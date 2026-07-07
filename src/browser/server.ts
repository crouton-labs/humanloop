import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse, Server as HttpServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Deck, InteractionResponse } from '../types.js';
import { deckPath, readJson, writeResponse, clearProgress } from '../inbox/convention.js';

// See $CRTR_CONTEXT_DIR/phase1-server-contract.md for the full HTTP/WS API
// this module implements — this file is the reference implementation, that
// doc is the stable seam phases 2/3 build against.

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

// Compiled server.js lives at dist/browser/server.js; the Vite SPA bundle
// builds into dist/web (see web/vite.config.ts) — siblings under dist/, so
// this never collides with tsc's own output tree.
const STATIC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');

export interface WebServerOpts {
  /** Interaction dir — the deck.json / response.json / progress.json convention. */
  dir: string;
  /** The deck to serve. Re-read from disk on every GET in case it changed. */
  deck: Deck;
  /**
   * Fired once the browser's submit has been written to response.json —
   * exactly once per server instance, only for the first accepted submit
   * (later submits get a 409 and never re-fire this). `responsePath`/
   * `completedAt` are already persisted to disk — the caller converges the
   * host surface, it must NOT write the result again. Fired only after the
   * submit's own HTTP 200 has finished flushing to its socket, so it is
   * safe for this callback to `stop()` the server (which force-closes all
   * open sockets) without racing the ack the browser is waiting on.
   */
  onSubmit?: (responses: InteractionResponse[], completedAt: string, responsePath: string) => void;
}

export interface WebServerHandle {
  /** `http://127.0.0.1:<port>/` — open this in a browser. */
  url: string;
  port: number;
  /** Broadcast `{type:'taken-back'}` to every connected browser tab. Safe to
   *  call with zero open sockets (e.g. the browser was never opened). */
  notifyTakenBack(): void;
  /** Stop listening, close all sockets (WS and HTTP), and tear down. */
  stop(): Promise<void>;
}

function send(res: ServerResponse, status: number, body: string, contentType: string): void {
  res.writeHead(status, { 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  send(res, status, JSON.stringify(value), 'application/json; charset=utf-8');
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function serveStatic(reqPath: string, res: ServerResponse): Promise<void> {
  // Strip query string + guard path traversal. Unknown paths (and `/`) fall
  // back to index.html — there is no server-side routing, the SPA owns it.
  const safePath = reqPath.split('?')[0]!.replace(/\.\.(\/|\\)/g, '');
  let filePath = join(STATIC_ROOT, safePath === '/' ? '/index.html' : safePath);
  if (!existsSync(filePath)) filePath = join(STATIC_ROOT, 'index.html');
  try {
    const body = await readFile(filePath);
    const type = MIME[extname(filePath)] ?? 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': body.length });
    res.end(body);
  } catch {
    send(
      res, 404,
      'humanloop: dist/web is missing — run `npm run build` (which builds the web/ SPA too) before opening the browser surface.',
      'text/plain; charset=utf-8',
    );
  }
}

/**
 * Start an on-demand local HTTP+WS server over one interaction dir. Binds to
 * an ephemeral port on 127.0.0.1 only (never 0.0.0.0 — this is a same-machine
 * handoff, not a shareable link). The caller owns the lifecycle: start it
 * when the human hands off to the browser, `stop()` it on take-back or once
 * `onSubmit` fires.
 */
export async function startWebServer(opts: WebServerOpts): Promise<WebServerHandle> {
  let deck = opts.deck;
  const dir = opts.dir;
  // Single-assignment submit boundary (Finding 2): the first accepted
  // `/api/submit` sets this; every later submit — a double-click, a second
  // tab, a retry — returns the same canonical result via 409 instead of
  // re-writing response.json or re-firing onSubmit. Everything from the
  // `submitted !== null` check through setting it below runs synchronously
  // (no `await` in between), so two requests racing through the earlier
  // `readRequestBody` await can't both slip past the check — Node's
  // single-threaded execution guarantees only one synchronous section runs
  // before `submitted` flips.
  let submitted: { responsePath: string; completedAt: string } | null = null;

  const httpServer: HttpServer = createServer((req, res) => {
    void handleRequest(req, res);
  });

  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
  const sockets = new Set<WebSocket>();
  wss.on('connection', (ws) => {
    sockets.add(ws);
    ws.on('close', () => sockets.delete(ws));
  });

  function broadcast(message: unknown): void {
    const payload = JSON.stringify(message);
    for (const ws of sockets) {
      if (ws.readyState === ws.OPEN) ws.send(payload);
    }
  }

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? '/';
    if (url === '/api/interaction' && req.method === 'GET') {
      // Re-read deck.json in case an agent rewrote it mid-handoff (mirrors
      // the terminal deck's own live-reload poll in resolveInteractionDir).
      // Best-effort — falls back to the in-memory deck if the read fails.
      const onDisk = readJson<Deck>(deckPath(dir));
      if (onDisk !== null) deck = onDisk;
      sendJson(res, 200, { dir, deck });
      return;
    }
    if (url === '/api/submit' && req.method === 'POST') {
      let parsed: { responses?: unknown };
      try {
        parsed = JSON.parse(await readRequestBody(req)) as { responses?: unknown };
      } catch {
        sendJson(res, 400, { error: 'bad_json', message: 'Request body is not valid JSON.' });
        return;
      }
      if (!Array.isArray(parsed.responses)) {
        sendJson(res, 400, { error: 'bad_input', message: 'responses must be an array.' });
        return;
      }
      // Single-assignment: the first accepted submit wins. A later submit
      // (double-click, a second open tab, a retry) never re-writes
      // response.json or re-fires onSubmit — it gets the same canonical
      // result back via 409.
      if (submitted !== null) {
        sendJson(res, 409, { ok: false, error: 'already_submitted', ...submitted });
        return;
      }
      const responses = parsed.responses as InteractionResponse[];
      const completedAt = new Date().toISOString();
      // Canonical write — the exact helper the terminal path uses, so nothing
      // downstream of response.json can tell which surface produced it.
      const responsePath = writeResponse(dir, responses, completedAt, deck);
      submitted = { responsePath, completedAt };
      clearProgress(dir);
      broadcast({ type: 'converged' });
      // Ack-ordering guarantee (Finding 1): the HTTP caller must always
      // receive its 200 body before any lifecycle teardown can close its
      // socket. `onSubmit` (which the TUI wires to `finalize()` → `stop()` →
      // `closeAllConnections()`) is deferred until this response's 'finish'
      // event — Node fires that once the response has actually been handed
      // off to the OS for transmission, so the ack is guaranteed delivered
      // before teardown can race it.
      res.once('finish', () => {
        opts.onSubmit?.(responses, completedAt, responsePath);
      });
      sendJson(res, 200, { ok: true, responsePath, completedAt });
      return;
    }
    await serveStatic(url, res);
  }

  await new Promise<void>((resolveListen, rejectListen) => {
    httpServer.once('error', rejectListen);
    httpServer.listen(0, '127.0.0.1', () => resolveListen());
  });

  const address = httpServer.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  const url = `http://127.0.0.1:${port}/`;

  return {
    url,
    port,
    notifyTakenBack(): void {
      broadcast({ type: 'taken-back' });
    },
    stop(): Promise<void> {
      return new Promise((resolveStop) => {
        for (const ws of sockets) ws.terminate();
        wss.close();
        // Ephemeral, single-purpose server: force-close any lingering
        // keep-alive sockets rather than waiting on http.Server#close's
        // default "drain first" behavior, which would otherwise hang stop()
        // for as long as the browser holds an idle connection open.
        httpServer.closeAllConnections();
        httpServer.close(() => resolveStop());
      });
    },
  };
}
