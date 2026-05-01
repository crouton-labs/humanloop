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
