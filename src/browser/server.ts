import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse, Server as HttpServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Deck, FeedbackResult, InteractionResponse } from '../types.js';
import { deckPath, readJson, writeResponse, clearProgress } from '../inbox/convention.js';
import {
  buildDraftFeedbackResult,
  buildFinalFeedbackResult,
  parseFeedbackComments,
  readStoredDraftFeedbackResult,
  serializeFeedbackResult,
  writeFeedbackResult,
  writeSubmitFlag,
} from '../editor/feedback.js';

// See $CRTR_CONTEXT_DIR/phase1-server-contract.md for the deck HTTP/WS API this
// module implements — this file is the reference implementation for the deck
// surface, and the review surface reuses the same static/WS skeleton.

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

type SurfaceKind = 'deck' | 'review';

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

export interface ReviewWebServerOpts {
  /** Shared review job dir — carries review.vim and feedback.json. */
  jobDir: string;
  /** Absolute source file under review. */
  file: string;
  /** Absolute feedback JSON output path. */
  output: string;
  /** Optional submit sentinel written on final browser submit. */
  submitFlagPath?: string;
  /** Fired after the HTTP submit ack has finished flushing. */
  onSubmit?: (result: FeedbackResult, submittedAt: string, outputPath: string) => void;
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

function wrongSurface(expected: SurfaceKind): Record<string, string> {
  return { error: 'wrong_surface', expected };
}

function createServerScaffold() {
  let handleRequest: (req: IncomingMessage, res: ServerResponse) => Promise<void> = async () => {};
  const httpServer: HttpServer = createServer((req, res) => {
    void handleRequest(req, res);
  });

  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
  const sockets = new Set<WebSocket>();
  wss.on('connection', (ws) => {
    sockets.add(ws);
    ws.on('close', () => sockets.delete(ws));
  });

  let stopped = false;
  function broadcast(message: unknown): void {
    const payload = JSON.stringify(message);
    for (const ws of sockets) {
      if (ws.readyState === ws.OPEN) ws.send(payload);
    }
  }

  function setHandler(next: (req: IncomingMessage, res: ServerResponse) => Promise<void>): void {
    handleRequest = next;
  }

  function stop(): Promise<void> {
    if (stopped) return Promise.resolve();
    stopped = true;
    return new Promise((resolveStop) => {
      for (const ws of sockets) ws.terminate();
      wss.close();
      // Ephemeral, single-purpose server: force-close any lingering keep-alive
      // sockets rather than waiting on http.Server#close's default drain-first
      // behavior.
      httpServer.closeAllConnections();
      httpServer.close(() => resolveStop());
    });
  }

  return { httpServer, broadcast, setHandler, stop };
}

async function listen(server: HttpServer): Promise<number> {
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => resolveListen());
  });
  const address = server.address();
  return typeof address === 'object' && address !== null ? address.port : 0;
}

async function startDeckServer(opts: WebServerOpts): Promise<WebServerHandle> {
  let deck = opts.deck;
  const dir = opts.dir;
  let submitted: { responsePath: string; completedAt: string } | null = null;
  const scaffold = createServerScaffold();

  scaffold.setHandler(async (req, res) => {
    const url = req.url ?? '/';
    if (url === '/api/surface' && req.method === 'GET') {
      sendJson(res, 200, { kind: 'deck' });
      return;
    }
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
      scaffold.broadcast({ type: 'converged' });
      // Ack-ordering guarantee: the HTTP caller must always receive its 200
      // body before any lifecycle teardown can close its socket.
      res.once('finish', () => {
        opts.onSubmit?.(responses, completedAt, responsePath);
      });
      sendJson(res, 200, { ok: true, responsePath, completedAt });
      return;
    }
    if (url.startsWith('/api/review')) {
      sendJson(res, 404, wrongSurface('deck'));
      return;
    }
    await serveStatic(url, res);
  });

  const port = await listen(scaffold.httpServer);
  const url = `http://127.0.0.1:${port}/`;
  return {
    url,
    port,
    notifyTakenBack(): void {
      scaffold.broadcast({ type: 'taken-back' });
    },
    stop(): Promise<void> {
      return scaffold.stop();
    },
  };
}

async function startReviewServer(opts: ReviewWebServerOpts): Promise<WebServerHandle> {
  const { jobDir, file, output, submitFlagPath } = opts;
  const scaffold = createServerScaffold();
  let version = 0;
  let currentResult = readStoredDraftFeedbackResult(output, file)
    ?? buildDraftFeedbackResult(file, [], new Date().toISOString());

  function refreshInitialDraftFromDisk(): void {
    if (version !== 0 || currentResult.submitted) return;
    const onDisk = readStoredDraftFeedbackResult(output, file);
    if (onDisk === null) return;
    if (serializeFeedbackResult(onDisk) !== serializeFeedbackResult(currentResult)) {
      currentResult = onDisk;
      version += 1;
    }
  }

  function currentSnapshot(): FeedbackResult {
    return currentResult;
  }

  scaffold.setHandler(async (req, res) => {
    const url = req.url ?? '/';
    if (url === '/api/surface' && req.method === 'GET') {
      sendJson(res, 200, { kind: 'review' });
      return;
    }
    if (url === '/api/review' && req.method === 'GET') {
      refreshInitialDraftFromDisk();
      let content: string;
      try {
        content = await readFile(file, 'utf8');
      } catch (err) {
        sendJson(res, 404, {
          error: 'source_not_found',
          message: err instanceof Error ? err.message : String(err),
        });
        return;
      }
      sendJson(res, 200, {
        kind: 'review',
        file,
        output,
        jobId: basename(jobDir),
        content,
        result: currentSnapshot(),
        version,
      });
      return;
    }
    if (url === '/api/review/draft' && req.method === 'PUT') {
      let parsed: { comments?: unknown; baseVersion?: unknown };
      try {
        parsed = JSON.parse(await readRequestBody(req)) as { comments?: unknown; baseVersion?: unknown };
      } catch {
        sendJson(res, 400, { error: 'bad_json', message: 'Request body is not valid JSON.' });
        return;
      }
      refreshInitialDraftFromDisk();
      if (currentResult.submitted) {
        sendJson(res, 409, { error: 'already_submitted', result: currentSnapshot() });
        return;
      }
      if (!Number.isInteger(parsed.baseVersion)) {
        sendJson(res, 400, { error: 'bad_input', message: 'baseVersion must be an integer.' });
        return;
      }
      if (parsed.baseVersion !== version) {
        sendJson(res, 409, { error: 'stale_draft', version, result: currentSnapshot() });
        return;
      }
      const parsedComments = parseFeedbackComments(parsed.comments);
      if (!parsedComments.ok) {
        sendJson(res, 400, { error: 'bad_input', message: parsedComments.message });
        return;
      }
      const savedAt = new Date().toISOString();
      const nextResult = buildDraftFeedbackResult(file, parsedComments.comments, savedAt);
      try {
        writeFeedbackResult(output, nextResult);
      } catch (err) {
        sendJson(res, 500, { error: 'internal', message: err instanceof Error ? err.message : String(err) });
        return;
      }
      currentResult = nextResult;
      version += 1;
      scaffold.broadcast({ type: 'review-draft-updated', version, savedAt });
      sendJson(res, 200, { ok: true, result: currentSnapshot(), version });
      return;
    }
    if (url === '/api/review/submit' && req.method === 'POST') {
      let parsed: { comments?: unknown; baseVersion?: unknown };
      try {
        parsed = JSON.parse(await readRequestBody(req)) as { comments?: unknown; baseVersion?: unknown };
      } catch {
        sendJson(res, 400, { error: 'bad_json', message: 'Request body is not valid JSON.' });
        return;
      }
      refreshInitialDraftFromDisk();
      if (currentResult.submitted) {
        sendJson(res, 409, {
          ok: false,
          error: 'already_submitted',
          output,
          submittedAt: currentResult.submittedAt,
          result: currentSnapshot(),
        });
        return;
      }
      if (!Number.isInteger(parsed.baseVersion)) {
        sendJson(res, 400, { error: 'bad_input', message: 'baseVersion must be an integer.' });
        return;
      }
      if (parsed.baseVersion !== version) {
        sendJson(res, 409, { error: 'stale_draft', version, result: currentSnapshot() });
        return;
      }
      const parsedComments = parseFeedbackComments(parsed.comments);
      if (!parsedComments.ok) {
        sendJson(res, 400, { error: 'bad_input', message: parsedComments.message });
        return;
      }
      const submittedAt = new Date().toISOString();
      const nextResult = buildFinalFeedbackResult(file, parsedComments.comments, submittedAt);
      try {
        writeFeedbackResult(output, nextResult);
        currentResult = nextResult;
        if (submitFlagPath !== undefined && submitFlagPath.length > 0) {
          writeSubmitFlag(submitFlagPath);
        }
      } catch (err) {
        sendJson(res, 500, { error: 'internal', message: err instanceof Error ? err.message : String(err) });
        return;
      }
      scaffold.broadcast({ type: 'converged' });
      res.once('finish', () => {
        opts.onSubmit?.(currentSnapshot(), submittedAt, output);
      });
      sendJson(res, 200, { ok: true, output, submittedAt, result: currentSnapshot() });
      return;
    }
    if (url.startsWith('/api/interaction') || url === '/api/submit') {
      sendJson(res, 404, wrongSurface('review'));
      return;
    }
    await serveStatic(url, res);
  });

  const port = await listen(scaffold.httpServer);
  const url = `http://127.0.0.1:${port}/`;
  return {
    url,
    port,
    notifyTakenBack(): void {
      scaffold.broadcast({ type: 'taken-back' });
    },
    stop(): Promise<void> {
      return scaffold.stop();
    },
  };
}

/**
 * Start an on-demand local HTTP+WS server over one interaction dir. Binds to
 * an ephemeral port on 127.0.0.1 only (never 0.0.0.0 — this is a same-machine
 * handoff, not a shareable link). The caller owns the lifecycle: start it
 * when the human hands off to the browser, `stop()` it on take-back or once
 * `onSubmit` fires.
 */
export async function startWebServer(opts: WebServerOpts): Promise<WebServerHandle> {
  return startDeckServer(opts);
}

/** Start a review-mode browser server over one markdown review job. */
export async function startReviewWebServer(opts: ReviewWebServerOpts): Promise<WebServerHandle> {
  return startReviewServer(opts);
}
