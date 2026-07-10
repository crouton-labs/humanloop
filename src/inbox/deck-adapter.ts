import { readFileSync } from 'node:fs';
import type { Deck, InteractionResponse, MountedPanel } from '../types.js';
import type { Key } from '../tui/terminal.js';
import { deckPath, progressPath, readJson } from './convention.js';
import { validateDeck } from './deck-schema.js';
import { mountPanel } from '../tui/app.js';

export interface DeckAdapterOptions {
  dir: string;
  deck: Deck;
  cols: number;
  rows: number;
  onProgress?: (responses: InteractionResponse[]) => void;
  onComplete: (responses: InteractionResponse[]) => void;
  onBack: () => void;
  onDirty: () => void;
}

/** Embeds the single deck renderer in a controller-owned rectangle. */
export class DeckAdapter {
  private readonly opts: DeckAdapterOptions;
  private panel: MountedPanel;
  private responses: InteractionResponse[] = [];

  constructor(opts: DeckAdapterOptions) {
    this.opts = opts;
    this.responses = initialResponses(opts.deck, opts.dir);
    this.panel = mountPanel({
      deck: opts.deck,
      progressPath: progressPath(opts.dir),
      cols: opts.cols,
      rows: opts.rows,
      onProgress: (responses) => { this.responses = responses; opts.onProgress?.(responses); },
      onComplete: opts.onComplete,
      onExit: () => opts.onComplete(this.responses),
      onDirty: opts.onDirty,
    });
  }

  render(): string[] { return this.panel.render(); }
  resize(cols: number, rows: number): string[] { return this.panel.handleResize(cols, rows); }
  inputBuffer(): string | undefined { return this.panel.getInputBuffer(); }
  canAcceptHostKeys(): boolean { return this.panel.canAcceptHostKeys(); }

  handleKey(input: string, key: Key): void {
    if (key.escape && this.panel.atDeckTop()) {
      this.opts.onBack();
      return;
    }
    this.panel.handleKey(input, key);
  }

  /** Fresh descriptor reads preserve mounted answers for interaction ids still present. */
  reload(): void {
    try {
      this.panel.loadDeck(validateDeck(JSON.parse(readFileSync(deckPath(this.opts.dir), 'utf8'))), { progressPath: progressPath(this.opts.dir) });
      this.opts.onDirty();
    } catch {
      // An incomplete external rewrite is not a new deck; retain the current editor.
    }
  }

  close(): void { this.panel.unmount(); }
}

function initialResponses(deck: Deck, dir: string): InteractionResponse[] {
  const saved = readJson<{ responses?: InteractionResponse[] }>(progressPath(dir))?.responses;
  if (Array.isArray(saved)) return saved;
  return deck.interactions.flatMap((interaction) => {
    const answer = interaction.preAnswered;
    if (answer === undefined) return [];
    return [{ id: interaction.id, ...(answer.selectedOptionId === undefined ? {} : { selectedOptionId: answer.selectedOptionId }), ...(answer.selectedOptionIds === undefined ? {} : { selectedOptionIds: [...answer.selectedOptionIds] }), ...(answer.freetext === undefined ? {} : { freetext: answer.freetext }) }];
  });
}
