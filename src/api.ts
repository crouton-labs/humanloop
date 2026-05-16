import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  Deck, InteractionResponse, ResolutionEnvelope, GenerateVisual,
} from './types.js';
import { resolveInteractionDir } from './tui/app.js';
import { scanInbox } from './inbox/scan.js';
import { pickFromInbox } from './inbox/tui.js';
import { deckPath, atomicWriteJson, readJson } from './inbox/convention.js';
import { getTerminalSize } from './tui/terminal.js';

const RESPONSE_SCHEMA_ID = 'humanloop.response/v2' as const;

function managedDir(): string {
  return mkdtempSync(join(tmpdir(), 'hl-ix-'));
}

/**
 * Deterministic, no-LLM resolution summary — one line per answered
 * interaction: `"<title>: <option label>[ — <freetext>]"`.
 */
function buildSummary(deck: Deck, responses: InteractionResponse[]): string {
  const byId = new Map(responses.map((r) => [r.id, r] as const));
  const lines: string[] = [];
  for (const it of deck.interactions) {
    const r = byId.get(it.id);
    if (r === undefined) continue;
    const opt = r.selectedOptionId !== undefined
      ? it.options.find((o) => o.id === r.selectedOptionId)
      : undefined;
    const ft = r.freetext !== undefined && r.freetext !== '' ? r.freetext : undefined;
    let val: string;
    if (opt !== undefined && ft !== undefined) val = `${opt.label} — ${ft}`;
    else if (opt !== undefined) val = opt.label;
    else if (ft !== undefined) val = ft;
    else val = '(skipped)';
    lines.push(`${it.title}: ${val}`);
  }
  return lines.join('\n');
}

export interface AskOpts {
  /** Interaction directory. Defaults to a managed temp dir under os.tmpdir(). */
  dir?: string;
  sessionId?: string;
  cols?: number;
  rows?: number;
}

/**
 * Resolve a deck against an interaction directory and return the resolution
 * envelope. Writes `<dir>/deck.json` (the request, per the convention) and,
 * on completion, `<dir>/response.json`.
 */
export async function ask(deck: Deck, opts: AskOpts = {}): Promise<ResolutionEnvelope> {
  const dir = opts.dir ?? managedDir();
  mkdirSync(dir, { recursive: true });
  atomicWriteJson(deckPath(dir), deck);

  const { responses, completedAt, responsePath } = await resolveInteractionDir(dir, deck, {
    sessionId: opts.sessionId,
    cols: opts.cols,
    rows: opts.rows,
  });

  return {
    summary: buildSummary(deck, responses),
    responsePath,
    schema: RESPONSE_SCHEMA_ID,
    responses,
    completedAt,
  };
}

export interface ApproveOpts {
  subtitle?: string;
  body?: string;
  dir?: string;
  sessionId?: string;
}

/** Sugar: a single `kind:'validation'` Yes/No interaction. */
export async function approve(title: string, opts: ApproveOpts = {}): Promise<boolean> {
  const deck: Deck = {
    interactions: [{
      id: 'approve',
      title,
      ...(opts.subtitle !== undefined ? { subtitle: opts.subtitle } : {}),
      ...(opts.body !== undefined ? { body: opts.body } : {}),
      kind: 'validation',
      options: [
        { id: 'yes', label: 'Yes' },
        { id: 'no', label: 'No' },
      ],
    }],
  };
  const env = await ask(deck, { dir: opts.dir, sessionId: opts.sessionId });
  return env.responses[0]?.selectedOptionId === 'yes';
}

/** Sugar: a single `kind:'notify'` acknowledgement. */
export async function notify(title: string, body?: string): Promise<void> {
  const deck: Deck = {
    interactions: [{
      id: 'notify',
      title,
      ...(body !== undefined ? { body } : {}),
      kind: 'notify',
      options: [{ id: 'ok', label: 'OK' }],
    }],
  };
  await ask(deck, {});
}

export interface InboxOpts {
  cols?: number;
  rows?: number;
  generateVisual?: GenerateVisual;
}

/**
 * List → resolve loop across `roots`. Shows pending interactions, lets the
 * human pick one, resolves it (writing its `response.json`), then rescans —
 * resolved items drop out — until the human quits or nothing is pending.
 */
export async function inbox(roots: string[], opts: InboxOpts = {}): Promise<void> {
  for (;;) {
    const items = scanInbox(roots);
    if (items.length === 0) return;

    const term = getTerminalSize();
    const cols = opts.cols ?? term.cols;
    const rows = opts.rows ?? term.rows;

    const picked = await pickFromInbox(items, { cols, rows });
    if (picked === null) return;

    const deck = readJson<Deck>(deckPath(picked.dir));
    if (deck === null) continue; // raced/removed — rescan

    await resolveInteractionDir(picked.dir, deck, {
      generateVisual: opts.generateVisual,
      cols,
      rows,
    });
  }
}
