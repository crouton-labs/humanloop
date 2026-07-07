// Deliberately duplicated, display-shaped subset of humanloop's `Deck` /
// `InteractionResponse` (../../src/types.ts). The SPA talks to the server
// over HTTP/JSON — a network boundary — so it keeps its own types rather
// than importing across into the CLI package's `src/`. Phase 2 (the real
// per-kind deck UI) will need the full Interaction shape; keep this in sync
// with src/types.ts by hand as fields are added.

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
  options: InteractionOption[];
  multiSelect?: boolean;
  allowFreetext?: boolean;
  freetextLabel?: string;
  kind?: 'notify' | 'decision' | 'context' | 'error' | 'review';
}

export interface Deck {
  title?: string;
  interactions: Interaction[];
}

export interface InteractionResponse {
  id: string;
  selectedOptionId?: string;
  selectedOptionIds?: string[];
  freetext?: string;
  optionComments?: Record<string, string>;
}
