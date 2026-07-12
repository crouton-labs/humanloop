import type { Deck, Interaction, InteractionResponse } from '@/types';

// State shape + pure state-mutating helpers ported near-verbatim from the
// terminal's `src/tui/app.ts` (`buildInitialState`/`collectResponses`) and
// `src/tui/input.ts` (`submitOption`/`toggleMulti`/`commitMulti`/
// `setOptionComment`/`advanceToNextUnanswered`/`actionCount`/
// `responseSummary`). This is deliberate duplication, not drift risk taken
// lightly: response-shape parity with the terminal (criterion 1 of the
// phase 2 brief) is the highest-risk part of this surface, so instead of
// re-deriving the same logic from scratch, the exact mutation shapes are
// copied over unchanged with only terminal-only concerns removed (no
// `visuals` map, no `scrollOffset`/`detailExpanded` — the browser uses native
// DOM scroll and doesn't receive visual-context blocks over HTTP; no
// `persist` — the browser doesn't own progress.json). Keep this file in sync
// BY HAND with `src/tui/input.ts` + `src/tui/app.ts` if those mutation shapes
// change — same discipline as `types.ts`'s existing hand-sync obligation.

export type Phase = 'overview' | 'item-review' | 'final';

export type InputMode =
  | null
  | { kind: 'comment'; buffer: string; selectedOptionId?: string }
  | { kind: 'freetext'; buffer: string };

export interface DeckState {
  phase: Phase;
  currentIndex: number;
  interactions: Interaction[];
  responses: Map<string, InteractionResponse>;
  preAnsweredIds: Set<string>;
  inputMode: InputMode;
  /** Focus row within item-review's action list: an index into
   *  `options`, or `options.length` for the "[c] comment"/"[r] response" row. */
  selectedAction: number;
  /** One-line transient notice (e.g. "select at least one option"). Cleared
   *  on the next dispatched action. */
  hint?: string;
  /** Pulses `true` for exactly one state snapshot when the deck just
   *  auto-completed (mirrors the terminal's `checkAutoExit`) — the host
   *  effect watches this and fires the real submit instead of parking on the
   *  Final summary screen. See `deckReducer.ts`. */
  autoSubmit: boolean;
}

export function buildInitialState(deck: Deck, initialResponses: InteractionResponse[] = []): DeckState {
  // Single-interaction decks skip the overview list, same as the terminal —
  // there's nothing to overview, and overview hides option shortcuts.
  const initialPhase: Phase = deck.interactions.length === 1 ? 'item-review' : 'overview';
  const responses = new Map<string, InteractionResponse>();
  const preAnsweredIds = new Set<string>();
  for (const interaction of deck.interactions) {
    const pa = interaction.preAnswered;
    if (pa === undefined) continue;
    const response: InteractionResponse = { id: interaction.id };
    if (pa.selectedOptionId !== undefined) response.selectedOptionId = pa.selectedOptionId;
    if (pa.selectedOptionIds !== undefined) response.selectedOptionIds = [...pa.selectedOptionIds];
    if (pa.freetext !== undefined) response.freetext = pa.freetext;
    responses.set(interaction.id, response);
    preAnsweredIds.add(interaction.id);
  }
  for (const response of initialResponses) {
    if (deck.interactions.some((interaction) => interaction.id === response.id)) {
      responses.set(response.id, response);
      preAnsweredIds.delete(response.id);
    }
  }
  const firstUnanswered = deck.interactions.findIndex((i) => !responses.has(i.id));
  return {
    phase: initialPhase,
    currentIndex: firstUnanswered >= 0 ? firstUnanswered : 0,
    interactions: deck.interactions,
    responses,
    preAnsweredIds,
    inputMode: null,
    selectedAction: 0,
    autoSubmit: false,
  };
}

/** Ordered `InteractionResponse[]` exactly as the terminal would produce for
 *  `POST /api/submit` — interaction order, answered ones only. */
export function collectResponses(state: DeckState): InteractionResponse[] {
  const out: InteractionResponse[] = [];
  for (const interaction of state.interactions) {
    const r = state.responses.get(interaction.id);
    if (r !== undefined) out.push(r);
  }
  return out;
}

export function actionCount(interaction: Interaction): number {
  return interaction.options.length + (interaction.allowFreetext && interaction.options.length > 0 ? 1 : 0);
}

export function submitOption(
  state: DeckState,
  interaction: Interaction,
  selectedOptionId: string | undefined,
  freetext: string | undefined,
): void {
  const response: InteractionResponse = { id: interaction.id };
  if (selectedOptionId !== undefined) response.selectedOptionId = selectedOptionId;
  if (freetext !== undefined) response.freetext = freetext;
  state.responses.set(interaction.id, response);
  state.preAnsweredIds.delete(interaction.id);
}

export function toggleMulti(state: DeckState, interaction: Interaction, optionId: string): void {
  const existing = state.responses.get(interaction.id);
  const priorIds = existing !== undefined && existing.selectedOptionIds !== undefined
    ? existing.selectedOptionIds
    : [];
  const set = new Set(priorIds);
  if (set.has(optionId)) set.delete(optionId);
  else set.add(optionId);
  const response: InteractionResponse = { id: interaction.id, selectedOptionIds: [...set] };
  if (existing !== undefined && existing.freetext !== undefined) response.freetext = existing.freetext;
  if (existing !== undefined && existing.optionComments !== undefined) {
    response.optionComments = { ...existing.optionComments };
  }
  state.responses.set(interaction.id, response);
  state.preAnsweredIds.delete(interaction.id);
}

export function commitMulti(
  state: DeckState,
  interaction: Interaction,
  freetext?: string,
): void {
  const existing = state.responses.get(interaction.id);
  const priorIds = existing !== undefined && existing.selectedOptionIds !== undefined
    ? existing.selectedOptionIds
    : [];
  const response: InteractionResponse = {
    id: interaction.id,
    selectedOptionIds: [...priorIds],
  };
  let ft: string | undefined;
  if (freetext !== undefined) ft = freetext;
  else if (existing !== undefined) ft = existing.freetext;
  if (ft !== undefined) response.freetext = ft;
  if (existing !== undefined && existing.optionComments !== undefined) {
    response.optionComments = { ...existing.optionComments };
  }
  state.responses.set(interaction.id, response);
  state.preAnsweredIds.delete(interaction.id);
}

export function setOptionComment(
  state: DeckState,
  interaction: Interaction,
  optionId: string,
  comment: string,
): void {
  const existing = state.responses.get(interaction.id);
  const priorIds = existing !== undefined && existing.selectedOptionIds !== undefined
    ? existing.selectedOptionIds
    : [];
  const set = new Set(priorIds);
  set.add(optionId);
  const priorComments = existing !== undefined && existing.optionComments !== undefined
    ? existing.optionComments
    : {};
  const nextComments: Record<string, string> = { ...priorComments, [optionId]: comment };
  const response: InteractionResponse = {
    id: interaction.id,
    selectedOptionIds: [...set],
    optionComments: nextComments,
  };
  if (existing !== undefined && existing.freetext !== undefined) response.freetext = existing.freetext;
  state.responses.set(interaction.id, response);
  state.preAnsweredIds.delete(interaction.id);
}

/** Move to the next interaction WITHOUT a response, falling through to
 *  `final` if everything following is already answered. */
export function advanceToNextUnanswered(state: DeckState): void {
  let next = state.currentIndex + 1;
  while (next < state.interactions.length && state.responses.has(state.interactions[next]!.id)) {
    next++;
  }
  if (next >= state.interactions.length) {
    state.phase = 'final';
    return;
  }
  state.currentIndex = next;
  state.selectedAction = 0;
}

export function advanceItem(state: DeckState, direction: number): void {
  const next = state.currentIndex + direction;
  if (next < 0) return;
  if (next >= state.interactions.length) {
    state.phase = 'final';
    return;
  }
  state.currentIndex = next;
  state.selectedAction = 0;
}

/** Mirrors the terminal's `checkAutoExit`: true when every interaction is
 *  answered AND the interaction that just got answered wasn't a multi-select
 *  commit (those route through the Final summary for a deliberate second
 *  confirm — see `commitMulti` call sites). */
export function computeAutoExit(state: DeckState): boolean {
  if (state.phase !== 'final') return false;
  if (state.responses.size < state.interactions.length) return false;
  const justCommitted = state.interactions[state.currentIndex];
  if (justCommitted?.multiSelect === true) return false;
  return true;
}

export function responseSummary(r: InteractionResponse, interaction: Interaction): string {
  if (r.selectedOptionIds !== undefined) {
    const oc = r.optionComments;
    const parts = r.selectedOptionIds
      .map((id) => interaction.options.find((o) => o.id === id))
      .filter((o): o is NonNullable<typeof o> => o !== undefined)
      .map((o) => {
        const note = oc !== undefined ? oc[o.id] : undefined;
        return typeof note === 'string' && note.length > 0
          ? `${o.label} ("${note}")`
          : o.label;
      });
    const picks = parts.length > 0 ? parts.join(', ') : '(none)';
    if (r.freetext) return `${picks}: "${r.freetext}"`;
    return picks;
  }
  const opt = r.selectedOptionId
    ? interaction.options.find((o) => o.id === r.selectedOptionId)
    : undefined;
  if (opt && r.freetext) return `${opt.label}: "${r.freetext}"`;
  if (opt) return opt.label;
  if (r.freetext) return r.freetext;
  return '(empty)';
}
