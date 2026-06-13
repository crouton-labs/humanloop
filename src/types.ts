// ── v2 shapes (v1 schema dropped per cycle-16 user pivot — humanloop is v2-only) ──

import type { Key } from './tui/terminal.js';

export type InteractionKind = 'notify' | 'decision' | 'context' | 'error' | 'review';

export interface InteractionOption {
  id: string;
  label: string;
  description?: string;
  /** Auto-assigned by the TUI (assignShortcuts) — NOT author-settable. Omitted
   *  from the deck schema so a deck can't create a shortcut that shadows a
   *  reserved key (e.g. `c` = comment, which would submit+close on single-select). */
  shortcut?: string;
}

/**
 * Seed an interaction with an answer the caller already has on hand — e.g. a
 * prior approval the human shouldn't have to re-confirm. When present, the
 * panel: (a) populates `responses[id]` from these fields at mount, (b) renders
 * a distinct "previously answered" marker in overview/final and labels it in
 * item-review, and (c) skips past the interaction on post-submit auto-advance.
 * The human can still navigate to it with `n`/`p` and override the seeded
 * answer — once they do, it renders as user-answered.
 */
export interface InteractionPreAnswer {
  selectedOptionId?: string;
  selectedOptionIds?: string[];
  freetext?: string;
  /** One-line marker shown in the answered chrome (e.g. "Previously approved").
   *  Defaults to "Previously answered" when omitted. */
  label?: string;
}

export interface Interaction {
  id: string;
  title: string;
  subtitle?: string;
  body?: string;
  bodyPath?: string;
  options: InteractionOption[];
  /** When true the human can check multiple options; the response carries
   *  `selectedOptionIds`. Absent/false = single-select (unchanged). */
  multiSelect?: boolean;
  allowFreetext?: boolean;
  freetextLabel?: string;
  kind?: InteractionKind;
  preAnswered?: InteractionPreAnswer;
}

export interface InteractionResponse {
  id: string;
  /** Single-select pick. */
  selectedOptionId?: string;
  /** Multi-select picks (set only for `multiSelect` interactions). */
  selectedOptionIds?: string[];
  freetext?: string;
  /** Multi-select per-option comments, keyed by option id. Each entry is a
   *  comment scoped to that specific option (independent of the overall
   *  `freetext`). Set only for `multiSelect` interactions. */
  optionComments?: Record<string, string>;
}

export interface DeckSource {
  sessionName?: string;
  askedBy?: string;
  blockedSince?: string;
  /** Originating canvas node id (CRTR_NODE_ID) when the ask was raised inside
   *  a crouter canvas node. Lets per-node attention scoping attribute the ask
   *  to the node that raised it rather than every sibling sharing the cwd. */
  nodeId?: string;
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
  /** Ids of interactions whose response was seeded from `Interaction.preAnswered`
   *  and which the human has not yet overridden. Drives the distinct
   *  "previously answered" rendering and the skip-on-advance behavior. */
  preAnsweredIds: Set<string>;
  inputMode: InputMode;
  selectedAction: number;
  detailExpanded: boolean;
  scrollOffset: number;
  /** Transient one-line notice shown in item-review (e.g. an empty multi-select
   *  Enter that was rejected). Cleared on the next keypress. */
  hint?: string;
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

/** Options for `display()` — the live-watch tmux pane surface. The pane always
 *  watches the file and live-updates on edits; there is no non-watched mode. */
export interface DisplayOpts {
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
  /**
   * True when the deck is at its top level: overview phase with no active
   * comment/freetext input. A host that owns mount/unmount uses this to decide
   * whether Esc should step back inside the deck (false) or tear it down (true).
   */
  atDeckTop(): boolean;
}
