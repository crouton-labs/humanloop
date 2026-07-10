import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  Deck, ResolutionEnvelope,
} from './types.js';
import { resolveInteractionDir } from './tui/app.js';
import { InboxController } from './inbox/controller.js';
import { deckPath, atomicWriteJson, stampCanvasNode } from './inbox/convention.js';
import { resolveDeckBodyPaths } from './inbox/deck-schema.js';
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
  // Canonical bodyPath → body normalization boundary (see deck-schema.ts) —
  // resolved BEFORE the deck is ever written to disk, so every reader
  // downstream (terminal render, the live-reload poller, the browser server)
  // only ever sees a plain `body`.
  deck = resolveDeckBodyPaths(deck, dir);
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
  roots?: string[];
}

/** Open the centralized inbox controller in the current human terminal. */
export async function openInbox(opts: InboxOpts = {}): Promise<void> {
  const controller = new InboxController({ roots: opts.roots, cols: opts.cols, rows: opts.rows });
  await controller.run();
}

// Compatibility export for the current package entrypoint; it invokes the centralized controller.
export async function inbox(roots: string[], opts: Omit<InboxOpts, 'roots'> = {}): Promise<void> {
  await openInbox({ ...opts, roots });
}
