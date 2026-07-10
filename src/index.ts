export { mountPanel, validateInput, launchTui } from './tui/app.js';
export { defaultGenerateVisual } from './visuals/generate.js';
export { launchReview } from './editor/review.js';
export { launchReview as review } from './editor/review.js';
export type { ReviewOptions } from './editor/review.js';

// Interaction-layer surface (SDK).
export { ask, notify, inbox } from './api.js';
export { display } from './surfaces/display.js';
export { scanInbox } from './inbox/scan.js';
export { registerInboxRoot, unregisterInboxRoot, listInboxRoots, managedInboxRoot } from './inbox/registry.js';
export type { CompletionHandler, InboxRootRegistration, InboxRootStatus, RegisterInboxRootOptions } from './inbox/registry.js';
export {
  submitDeck, submitReview, readTicketResult,
  finalizeDeck, finalizeReview, completeDeck, completeReview, cancelTicket, cancelTicketResult,
} from './inbox/tickets.js';
export type { SubmitDeckOptions, SubmitReviewOptions } from './inbox/tickets.js';
export { dispatchCompletion, reconcileCompletions } from './inbox/completion.js';
export { claimTicket, heartbeatClaim, releaseClaim, readTicketClaim } from './inbox/claim.js';
export type { TicketClaim, ClaimOptions } from './inbox/claim.js';

// Renderer binding — the sole org-wide termrender caller. Consumers
// (sisyphus md-render / ask-schema) route markdown through these.
export {
  renderMarkdown, checkMarkdown, ensureRenderer, isRendererReady,
} from './render/termrender.js';

// Canonical deck schema + parsing/validation (consumers stop forking it).
export { parseDeck, validateDeck, deckSchema, resolveDeckBodyPaths } from './inbox/deck-schema.js';

// Deck factories — pure builders for common deck shapes (sugar for SDK consumers
// who want validated Yes/No or notify decks without inline construction).
export { notifyDeck } from './inbox/deck-factories.js';
export type { NotifyDeckOpts } from './inbox/deck-factories.js';

// Interaction-directory convention helpers (§B) — names humanloop owns.
export {
  deckPath, responsePath, progressPath, visualsDir,
  interactionState, isResolved, isClaimed,
  atomicWriteJson, readJson, writeResponse, writeProgress, clearProgress,
} from './inbox/convention.js';
export type { InteractionState } from './inbox/convention.js';

// v1 schema dropped per cycle-16 user pivot — humanloop is v2-only.

export type {
  Interaction, InteractionOption, InteractionResponse, InteractionKind,
  Deck, DeckSource,
  MountedPanel, MountedPanelOpts, GenerateVisual, VisualBlock,
  FeedbackComment, FeedbackResult,
  ResolutionEnvelope, InboxItem, DisplayOpts,
  ClaimSummary, TicketSummary, DeckTicketSummary, ReviewTicketSummary,
  ReviewDescriptor, DeckTicketResult, ReviewTicketResult, CanceledTicketResult, TicketResult,
  InboxBindingState, CompletionEvent,
} from './types.js';
export type { Key } from './tui/terminal.js';
export type { ConversationMessage } from './conversation/reader.js';
