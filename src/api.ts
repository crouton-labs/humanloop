import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  Deck, InteractionResponse, ResolutionEnvelope, GenerateVisual,
} from './types.js';
import { resolveInteractionDir } from './tui/app.js';
import { scanInbox } from './inbox/scan.js';
import { pickFromInbox } from './inbox/tui.js';
import { deckPath, atomicWriteJson, readJson, stampCanvasNode } from './inbox/convention.js';
import { getTerminalSize } from './tui/terminal.js';
import { notifyDeck } from './inbox/deck-factories.js';
import { buildSummary } from './summary.js';

const RESPONSE_SCHEMA_ID = 'humanloop.response/v2' as const;

function managedDir(): string {
  return mkdtempSync(join(tmpdir(), 'hl-ix-'));
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
  stampCanvasNode(deck);
  atomicWriteJson(deckPath(dir), deck);

  const { responses, completedAt, responsePath, deck: answeredDeck } = await resolveInteractionDir(dir, deck, {
    sessionId: opts.sessionId,
    cols: opts.cols,
    rows: opts.rows,
  });

  return {
    // `answeredDeck` === `deck` unless an agent ran `hl deck update`
    // mid-flight; the summary must describe the questions actually answered.
    summary: buildSummary(answeredDeck, responses),
    responsePath,
    schema: RESPONSE_SCHEMA_ID,
    responses,
    completedAt,
  };
}

/** Sugar: a single `kind:'notify'` acknowledgement. */
export async function notify(title: string, body?: string): Promise<void> {
  const deck = notifyDeck(title, body !== undefined ? { body } : {});
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
