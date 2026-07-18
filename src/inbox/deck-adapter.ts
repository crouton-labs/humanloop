import type { Deck, FollowUpState, InteractionResponse, MountedPanel, VisualProvider } from '../types.js';
import type { Key } from '../tui/terminal.js';
import { progressPath, readJson } from './convention.js';
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
  visualProvider?: VisualProvider;
  onEditorRequest?: () => void;
  followUpAvailable?: boolean;
  onFollowUpRequest?: (question: string) => void;
  onFollowUpCancel?: () => void;
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
      // A partial-deck exit is a valid completion for ordinary asks, but a
      // notification is resolved only by its explicit acknowledgement.
      onExit: () => { if (notificationsAcknowledged(opts.deck, this.responses)) opts.onComplete(this.responses); },
      onDirty: opts.onDirty,
      visualProvider: opts.visualProvider,
      onEditorRequest: opts.onEditorRequest,
      followUpAvailable: opts.followUpAvailable,
      onFollowUpRequest: opts.onFollowUpRequest,
      onFollowUpCancel: opts.onFollowUpCancel,
    });
  }

  render(): string[] { return this.panel.render(); }
  resize(cols: number, rows: number): string[] { return this.panel.handleResize(cols, rows); }
  inputBuffer(): string | undefined { return this.panel.getInputBuffer(); }
  setInputBuffer(text: string): void { this.panel.setInputBuffer(text); }
  setFollowUpHandlers(available: boolean, onRequest?: (question: string) => void, onCancel?: () => void): void { this.panel.setFollowUpHandlers(available, onRequest, onCancel); }
  setFollowUpState(state: FollowUpState): void { this.panel.setFollowUpState(state); }
  canAcceptHostKeys(): boolean { return this.panel.canAcceptHostKeys(); }

  handleKey(input: string, key: Key): void {
    if (key.escape && this.panel.atDeckTop()) {
      this.opts.onBack();
      return;
    }
    this.panel.handleKey(input, key);
  }

  /** Fresh descriptor reads preserve mounted answers for interaction ids still present. */
  reload(deck: Deck): void {
    this.panel.loadDeck(deck, { progressPath: progressPath(this.opts.dir) });
    this.opts.onDirty();
  }

  close(): void { this.panel.unmount(); }
}

function notificationsAcknowledged(deck: Deck, responses: InteractionResponse[]): boolean {
  const byId = new Map(responses.map((response) => [response.id, response]));
  return deck.interactions.filter((interaction) => interaction.kind === 'notify').every((interaction) => {
    const response = byId.get(interaction.id);
    return response !== undefined && (response.selectedOptionId !== undefined || (response.selectedOptionIds?.length ?? 0) > 0 || (response.freetext?.trim() ?? '') !== '');
  });
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
