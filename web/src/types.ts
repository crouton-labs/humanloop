// Hand-synced, display-shaped copy of humanloop's `Deck`/`Interaction`/
// `InteractionResponse` (../../src/types.ts). The SPA talks to the server over
// HTTP/JSON — a real network boundary — so it keeps its own types rather than
// importing across into the CLI package's `src/`. This is phase1's known
// limitation (2): keep this file in sync BY HAND as `src/types.ts` changes.
// As of phase 2 this covers the FULL `Interaction` shape needed for a
// faithful deck render (preAnswered seeding, multiSelect, freetext,
// per-option comments, deck source metadata) — no longer just the phase-1
// placeholder subset.
//
// Deliberately NOT mirrored here: `bodyPath` (the CLI resolves it to `body`
// before writing deck.json — the browser only ever sees the resolved string)
// and `VisualBlock` (generated server-side visual context has no HTTP channel
// to the browser today — see phase2-deck-ui-notes.md for the deviation).

export type InteractionKind = 'notify' | 'decision' | 'context' | 'error' | 'review';

export interface InteractionOption {
  id: string;
  label: string;
  description?: string;
  /** Auto-assigned by the terminal's `assignShortcuts` — NEVER present on
   *  deck.json as read from disk (see phase2-deck-ui-notes.md: the terminal
   *  mutates its own in-memory copy but never persists shortcuts back to
   *  disk). The browser computes its own via `lib/assignShortcuts.ts`. */
  shortcut?: string;
}

/** Seed an interaction with an answer the caller already has on hand — mirrors
 *  `src/types.ts`'s `InteractionPreAnswer`. */
export interface InteractionPreAnswer {
  selectedOptionId?: string;
  selectedOptionIds?: string[];
  freetext?: string;
  label?: string;
}

export interface Interaction {
  id: string;
  title: string;
  subtitle?: string;
  body?: string;
  options: InteractionOption[];
  multiSelect?: boolean;
  allowFreetext?: boolean;
  freetextLabel?: string;
  kind?: InteractionKind;
  preAnswered?: InteractionPreAnswer;
}

export interface InteractionResponse {
  id: string;
  selectedOptionId?: string;
  selectedOptionIds?: string[];
  freetext?: string;
  optionComments?: Record<string, string>;
}

export interface DeckSource {
  sessionName?: string;
  askedBy?: string;
  blockedSince?: string;
  nodeId?: string;
}

export interface Deck {
  title?: string;
  source?: DeckSource;
  interactions: Interaction[];
}

export interface FeedbackComment {
  id: string;
  line: number;
  endLine: number;
  quote?: string;
  colStart?: number;
  colEnd?: number;
  lineText: string;
  comment: string;
  createdAt: string;
}

export interface FeedbackResult {
  file: string;
  submitted: boolean;
  approved: boolean;
  comments: FeedbackComment[];
  submittedAt?: string;
  savedAt: string;
}

export interface ReviewPayload {
  kind: 'review';
  file: string;
  output: string;
  jobId: string;
  content: string;
  result: FeedbackResult;
  version: number;
}
