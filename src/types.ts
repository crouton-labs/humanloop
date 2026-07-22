// ── v2 shapes (v1 schema dropped per cycle-16 user pivot — humanloop is v2-only) ──

import type { Key } from './tui/terminal.js';

// Single source of truth for the interaction-kind enum: the Zod deck schema
// (`src/inbox/deck-schema.ts`) and the CLI's JSON schema (`src/cli.ts`) both
// derive their enum values from this array so a new kind can't drift between
// the type and the two validation surfaces the way `'review'` once did.
export const INTERACTION_KINDS = ['notify', 'decision', 'context', 'error', 'review'] as const;
export type InteractionKind = (typeof INTERACTION_KINDS)[number];

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
  /** Short topic — the thing being decided, not the decision. */
  title: string;
  /** ONE-sentence TL;DR of the choice/stakes. Renders as markdown in the
   *  scrollable region; keep it a single line — long prose belongs in `body`. */
  subtitle?: string;
  /** The full explanation: directive-flavored markdown rendered by termrender.
   *  This is where long or rich content goes (never the wall of detail in
   *  `subtitle`). `bodyPath` is the same content sourced from a file. */
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
  /** Host-owned durable Visual capability marker. A registered handler is also required. */
  visual?: 'humanloop.visual/v1';
}

export interface Deck {
  /** Short inbox topic for the deck as a whole. */
  title: string;
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
  /** Original model output, retained so resize can re-render locally. */
  markdown?: string;
  status: 'loading' | 'ready' | 'error';
}

export type FollowUpState =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'ready'; markdown: string }
  | { status: 'error'; error: string };

// ── TUI state ─────────────────────────────────────────────────────────────────

export type Phase = 'overview' | 'item-review' | 'final';

export type InputMode =
  | null
  | { kind: 'comment'; buffer: string; cursor: number; selectedOptionId?: string }
  | { kind: 'freetext'; buffer: string; cursor: number }
  | { kind: 'follow-up'; buffer: string; cursor: number };

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
  bodyMode: 'question' | 'visual';
  scrollOffset: number;
  bodyScrollOffsets: { question: number; visual: number };
  /** The mounting host provided an active Ctrl+O editor callback. */
  editorAvailable: boolean;
  followUpAvailable: boolean;
  followUp?: FollowUpState;
  /** Transient one-line notice shown in item-review (e.g. an empty multi-select
   *  Enter that was rejected). Cleared on the next keypress. */
  hint?: string;
  persist?: () => void;
}

// ── Interaction-directory convention (index §B/§C/§D) ──────────────────────────

/**
 * Resolution contract returned by `ask`/`inbox`. On-disk `response.json` stays
 * `{ responses, completedAt }`; `responsePath` points at it.
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
export interface ClaimSummary {
  owner: string;
  claimedAt: string;
  heartbeatAt: string;
}

interface TicketSummaryBase {
  dir: string;
  id: string;
  title: string;
  subtitle?: string;
  blockedSince: string;
  source: DeckSource;
  claim?: ClaimSummary;
}

export interface DeckTicketSummary extends TicketSummaryBase {
  kind: 'deck';
  interactionKind?: InteractionKind;
}

export interface ReviewTicketSummary extends TicketSummaryBase {
  kind: 'review';
  file: string;
  output: string;
}

/** The only pending-ticket shape scanners expose. */
export type TicketSummary = DeckTicketSummary | ReviewTicketSummary;
/** Compatibility name retained only while the list adapter is moved in H2. */
export type InboxItem = TicketSummary;

export interface ReviewDescriptor {
  schema: 'humanloop.review/v1';
  file: string;
  output: string;
  title: string;
  source: DeckSource;
  blockedSince: string;
}

export interface DeckTicketResult {
  schema: 'humanloop.response/v2';
  kind: 'deck';
  responses: InteractionResponse[];
  summary: string;
  completedAt: string;
}

export interface ReviewTicketResult {
  schema: 'humanloop.review-response/v1';
  kind: 'review';
  result: FeedbackResult;
  completedAt: string;
}

export interface CanceledTicketResult {
  schema: 'humanloop.cancel/v1';
  kind: 'canceled';
  canceledAt: string;
  reason?: string;
  actor?: string;
}

/** The sole canonical response.json union. */
export type TicketResult = DeckTicketResult | ReviewTicketResult | CanceledTicketResult;

export interface CompletionEvent {
  schema: 'humanloop.completion/v1';
  root: string;
  dir: string;
  ticketId: string;
  kind: 'deck' | 'review' | 'canceled';
  outcome: 'resolved' | 'canceled';
  responsePath: string;
}

/** A popup request to reveal the host surface that created a ticket. The root's
 * trusted focus handler decides what that means; humanloop only supplies the
 * selected ticket and the tmux pane underneath the popup. */
export interface FocusEvent {
  schema: 'humanloop.focus/v1';
  root: string;
  dir: string;
  ticketId: string;
  targetPane: string;
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

/** Width-free Interaction snapshot shared by the panel and durable Visual protocol. */
export interface CanonicalInteractionOption {
  id: string;
  label: string;
  description?: string;
}

export interface CanonicalInteraction {
  id: string;
  title: string;
  subtitle?: string;
  body?: string;
  options: CanonicalInteractionOption[];
  multiSelect?: boolean;
  allowFreetext?: boolean;
  freetextLabel?: string;
  kind?: InteractionKind;
  preAnswered?: InteractionPreAnswer;
}

export interface VisualRequest {
  requestId: string;
  generationId: string;
  interaction: CanonicalInteraction;
}

export type VisualResult =
  | { status: 'ready'; markdown: string }
  | { status: 'error'; error: string };

export interface VisualHandle {
  result: Promise<VisualResult>;
  /** Synchronous and idempotent. A canceled handle has no renderable result. */
  cancel(): void;
}

/** Host-injected, Markdown-only Visual capability. Rendering width belongs to the panel. */
export type VisualProvider = (request: VisualRequest) => VisualHandle;

export interface MountedPanelOpts {
  deck: Deck;
  progressPath?: string;
  visualProvider?: VisualProvider;
  /** Host callback for Ctrl+O while a comment/freetext buffer is active. */
  onEditorRequest?: () => void;
  followUpAvailable?: boolean;
  onFollowUpRequest?: (question: string) => void;
  onFollowUpCancel?: () => void;
  cols: number;
  rows: number;
  onProgress?: (responses: InteractionResponse[]) => void;
  onComplete?: (responses: InteractionResponse[]) => void;
  onExit?: () => void;
  /** Fired when panel state changes outside a keypress — currently when an
   *  async visual finishes loading. Hosts wire this to a repaint so
   *  "loading context..." is replaced the moment context arrives, rather than
   *  sticking until the next keystroke. Optional / backward-compatible. */
  onDirty?: () => void;
}

export interface MountedPanel {
  handleKey(input: string, key: Key): void;
  render(): string[];
  handleResize(cols: number, rows: number): string[];
  unmount(): void;
  loadDeck(deck: Deck, opts?: { progressPath?: string; visualProvider?: VisualProvider }): void;
  setFollowUpHandlers(available: boolean, onRequest?: (question: string) => void, onCancel?: () => void): void;
  setFollowUpState(state: FollowUpState): void;
  canAcceptHostKeys(): boolean;
  /**
   * True when the deck is at its top level: overview phase with no active
   * comment/freetext input. A host that owns mount/unmount uses this to decide
   * whether Esc should step back inside the deck (false) or tear it down (true).
   */
  atDeckTop(): boolean;
  /**
   * Live comment/freetext buffer, or undefined when not in input mode. Lets a
   * host implement the $EDITOR escape hatch (ctrl+o) without reaching into
   * panel-internal state: read the buffer here before spawning the editor.
   */
  getInputBuffer(): string | undefined;
  /**
   * Replace the input-mode buffer (e.g. after an $EDITOR round-trip) and move
   * the cursor to the end. No-op when not in input mode.
   */
  setInputBuffer(text: string): void;
}
