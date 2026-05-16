// ── v2 shapes (v1 schema dropped per cycle-16 user pivot — humanloop is v2-only) ──

import type { Key } from './tui/terminal.js';

export type InteractionKind = 'notify' | 'validation' | 'decision' | 'context' | 'error';

export interface InteractionOption {
  id: string;
  label: string;
  description?: string;
  shortcut?: string;
}

export interface Interaction {
  id: string;
  title: string;
  subtitle?: string;
  body?: string;
  bodyPath?: string;
  options: InteractionOption[];
  allowFreetext?: boolean;
  freetextLabel?: string;
  kind?: InteractionKind;
}

export interface InteractionResponse {
  id: string;
  selectedOptionId?: string;
  freetext?: string;
}

export interface DeckSource {
  sessionName?: string;
  askedBy?: string;
  blockedSince?: string;
}

export interface Deck {
  title?: string;
  source?: DeckSource;
  interactions: Interaction[];
}

// ── Propose-for-feedback (Neovim review) ───────────────────────────────────────

export interface FeedbackComment {
  id: string;
  /** 1-based source line where the comment is anchored (start). */
  line: number;
  /** 1-based source line where the anchored range ends (== line for one line). */
  endLine: number;
  /** Exact selected substring when the human made a visual selection. */
  quote?: string;
  /** 0-based byte column where a partial (charwise) selection starts on `line`. */
  colStart?: number;
  /** 0-based exclusive byte column where the selection ends on `endLine`. */
  colEnd?: number;
  /** Full source text of the anchored line(s) — context for the agent. */
  lineText: string;
  comment: string;
  createdAt: string;
}

export interface FeedbackResult {
  file: string;
  submitted: boolean;
  /** True when submitted with zero comments — human signalled "looks good". */
  approved: boolean;
  comments: FeedbackComment[];
  submittedAt?: string;
  savedAt: string;
}

// ── Visual context ─────────────────────────────────────────────────────────────

export interface VisualBlock {
  questionId: string;   // carries Interaction.id
  content: string;
  status: 'loading' | 'ready' | 'error';
}

// ── TUI state ─────────────────────────────────────────────────────────────────

export type Phase = 'overview' | 'item-review' | 'final';

export type InputMode =
  | null
  | { kind: 'comment'; buffer: string; selectedOptionId?: string }
  | { kind: 'freetext'; buffer: string };

export interface TuiState {
  phase: Phase;
  currentIndex: number;
  interactions: Interaction[];
  responses: Map<string, InteractionResponse>;
  visuals: Map<string, VisualBlock>;
  inputMode: InputMode;
  selectedAction: number;
  detailExpanded: boolean;
  scrollOffset: number;
  persist?: () => void;
}

// ── Interaction-directory convention (index §B/§C/§D) ──────────────────────────

/**
 * Resolution contract returned by `ask`/`inbox`. On-disk `response.json` stays
 * `{ responses, completedAt }`; `responsePath` points at it. `hl schema
 * response` returns the JSON Schema this `schema` id names.
 */
export interface ResolutionEnvelope {
  /** 1 line/interaction "<title>: <option label>[ — <freetext>]"; deterministic, no LLM. */
  summary: string;
  /** Absolute path to response.json. */
  responsePath: string;
  schema: 'humanloop.response/v2';
  /** Inline (small). */
  responses: InteractionResponse[];
  /** ISO timestamp. */
  completedAt: string;
}

/**
 * One pending interaction discovered by `scanInbox`. Read from the
 * `deck.json` header only — never the full deck.
 */
export interface InboxItem {
  dir: string;
  id: string;
  title?: string;
  subtitle?: string;
  kind?: InteractionKind;
  /** `deck.source.blockedSince` ?? `statSync(deck.json).mtime` (ISO). */
  blockedSince: string;
  source?: DeckSource;
}

/** Options for `display()` — the live-watch tmux pane surface. */
export interface DisplayOpts {
  /** Pass `--watch` so the pane live-updates on edits. Default true. */
  watch?: boolean;
  /** `'auto'` (default) splits until the pane budget, then opens a new window. */
  window?: 'auto' | 'split' | 'new';
  /** Pane budget per window before `'auto'` opens a new window. Default 3. */
  maxPanes?: number;
}

// ── Public panel API ──────────────────────────────────────────────────────────

export type GenerateVisual = (
  interaction: Interaction,
) => Promise<
  | { ok: true; ansi: string; markdown: string }
  | { ok: false; error: string }
>;

export interface MountedPanelOpts {
  deck: Deck;
  progressPath?: string;
  generateVisual?: GenerateVisual;
  cols: number;
  rows: number;
  onProgress?: (responses: InteractionResponse[]) => void;
  onComplete?: (responses: InteractionResponse[]) => void;
  onExit?: () => void;
}

export interface MountedPanel {
  handleKey(input: string, key: Key): void;
  render(): string[];
  handleResize(cols: number, rows: number): string[];
  unmount(): void;
  loadDeck(deck: Deck, opts?: { progressPath?: string }): void;
  canAcceptHostKeys(): boolean;
}
