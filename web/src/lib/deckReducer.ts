import type { Interaction } from '@/types';
import {
  type DeckState, type InputMode,
  submitOption, toggleMulti, commitMulti, setOptionComment,
  advanceToNextUnanswered, advanceItem, computeAutoExit, actionCount,
} from './deckState';

// The full deck action set — one variant per distinct mutation the terminal's
// `src/tui/input.ts` performs. `useDeckKeymap` (keyboard) and the click
// handlers in the Deck components (mouse) both dispatch these same actions,
// which is what keeps keyboard and mouse input perfectly in sync (single
// source of truth: this reducer).
export type DeckAction =
  | { type: 'overview/move'; delta: -1 | 1 }
  | { type: 'overview/enter'; index?: number }
  | { type: 'overview/quick-answer'; optionId: string }
  | { type: 'overview/finish' }
  | { type: 'item-review/move-focus'; delta: -1 | 1 }
  | { type: 'item-review/set-focus'; index: number }
  | { type: 'item-review/back' }
  | { type: 'item-review/step'; delta: -1 | 1 }
  | { type: 'item-review/toggle-option'; optionId: string; index?: number }
  | { type: 'item-review/pick-option'; optionId: string; index?: number }
  | { type: 'item-review/enter-row' }
  | { type: 'item-review/open-comment'; optionId?: string }
  | { type: 'item-review/open-freetext' }
  | { type: 'input/update'; buffer: string }
  | { type: 'input/cycle-attached' }
  | { type: 'input/submit' }
  | { type: 'input/cancel' }
  | { type: 'final/confirm' }
  | { type: 'final/back' }
  | { type: 'final/prev' };

function currentInteraction(state: DeckState): Interaction {
  return state.interactions[state.currentIndex]!;
}

/** Shallow-clone the mutable containers so React sees a new reference;
 *  everything else (`interactions`, individual response objects) is treated
 *  as immutable and replaced wholesale by the ported mutators, never
 *  mutated in place. */
function cloneState(state: DeckState): DeckState {
  return {
    ...state,
    responses: new Map(state.responses),
    preAnsweredIds: new Set(state.preAnsweredIds),
    hint: undefined, // cleared every dispatch, same as the terminal's handleKeypress
    autoSubmit: false, // pulse — only re-armed below when this dispatch earns it
  };
}

export function deckReducer(prev: DeckState, action: DeckAction): DeckState {
  const state = cloneState(prev);

  switch (action.type) {
    // ── Overview ───────────────────────────────────────────────────────────
    case 'overview/move': {
      const next = state.currentIndex + action.delta;
      state.currentIndex = Math.max(0, Math.min(next, state.interactions.length - 1));
      return state;
    }
    case 'overview/enter': {
      if (action.index !== undefined) state.currentIndex = action.index;
      state.phase = 'item-review';
      state.selectedAction = 0;
      return state;
    }
    case 'overview/quick-answer': {
      const interaction = currentInteraction(state);
      if (interaction.multiSelect) toggleMulti(state, interaction, action.optionId);
      else submitOption(state, interaction, action.optionId, undefined);
      return state;
    }
    case 'overview/finish': {
      // Unconditional: mirrors handleOverview's own `q` branch, not the
      // multiSelect-gated checkAutoExit path.
      if (state.responses.size >= state.interactions.length) state.autoSubmit = true;
      else state.phase = 'final';
      return state;
    }

    // ── Item review ────────────────────────────────────────────────────────
    case 'item-review/move-focus': {
      const interaction = currentInteraction(state);
      const max = actionCount(interaction) - 1;
      state.selectedAction = Math.max(0, Math.min(state.selectedAction + action.delta, max));
      return state;
    }
    case 'item-review/set-focus': {
      state.selectedAction = action.index;
      return state;
    }
    case 'item-review/back': {
      state.phase = 'overview';
      return state;
    }
    case 'item-review/step': {
      advanceItem(state, action.delta);
      return withAutoExitCheck(state);
    }
    case 'item-review/toggle-option': {
      const interaction = currentInteraction(state);
      if (action.index !== undefined) state.selectedAction = action.index;
      toggleMulti(state, interaction, action.optionId);
      return withAutoExitCheck(state);
    }
    case 'item-review/pick-option': {
      const interaction = currentInteraction(state);
      if (action.index !== undefined) state.selectedAction = action.index;
      submitOption(state, interaction, action.optionId, undefined);
      advanceToNextUnanswered(state);
      return withAutoExitCheck(state);
    }
    case 'item-review/enter-row': {
      const interaction = currentInteraction(state);
      const opts = interaction.options;
      if (state.selectedAction < opts.length) {
        if (interaction.multiSelect) {
          const checked = state.responses.get(interaction.id)?.selectedOptionIds ?? [];
          if (checked.length === 0) {
            state.hint = 'Select at least one option (space to toggle), or q to skip';
            return state;
          }
          commitMulti(state, interaction);
          advanceToNextUnanswered(state);
        } else {
          const o = opts[state.selectedAction]!;
          submitOption(state, interaction, o.id, undefined);
          advanceToNextUnanswered(state);
        }
        return withAutoExitCheck(state);
      }
      if (state.selectedAction === opts.length && interaction.allowFreetext && opts.length > 0) {
        state.inputMode = { kind: 'comment', buffer: '' };
      }
      return state;
    }
    case 'item-review/open-comment': {
      const interaction = currentInteraction(state);
      const opts = interaction.options;
      if (!interaction.allowFreetext || opts.length === 0) return state;
      const onOption = action.optionId !== undefined;
      if (onOption) {
        const optId = action.optionId!;
        let prefill = '';
        if (interaction.multiSelect) {
          const existing = state.responses.get(interaction.id);
          const prior = existing?.optionComments?.[optId];
          if (typeof prior === 'string') prefill = prior;
        }
        state.inputMode = { kind: 'comment', buffer: prefill, selectedOptionId: optId };
      } else {
        let prefill = '';
        if (interaction.multiSelect) {
          const existing = state.responses.get(interaction.id);
          if (existing?.freetext !== undefined) prefill = existing.freetext;
        }
        state.inputMode = { kind: 'comment', buffer: prefill };
      }
      return state;
    }
    case 'item-review/open-freetext': {
      const interaction = currentInteraction(state);
      if (interaction.allowFreetext && interaction.options.length === 0) {
        const existing = state.responses.get(interaction.id);
        const prefill = existing?.freetext ?? '';
        state.inputMode = { kind: 'freetext', buffer: prefill };
      }
      return state;
    }

    // ── Input mode (comment / freetext textarea) ────────────────────────────
    case 'input/update': {
      if (state.inputMode === null) return state;
      state.inputMode = { ...state.inputMode, buffer: action.buffer } as InputMode;
      return state;
    }
    case 'input/cycle-attached': {
      if (state.inputMode === null || state.inputMode.kind !== 'comment') return state;
      const interaction = currentInteraction(state);
      const opts = interaction.options;
      if (opts.length === 0) return state;
      const cur = state.inputMode.selectedOptionId;
      const curIdx = cur === undefined ? -1 : opts.findIndex((o) => o.id === cur);
      const nextIdx = curIdx + 1;
      const nextMode = { ...state.inputMode };
      if (nextIdx >= opts.length) delete nextMode.selectedOptionId;
      else nextMode.selectedOptionId = opts[nextIdx]!.id;
      state.inputMode = nextMode;
      return state;
    }
    case 'input/submit': {
      const mode = state.inputMode;
      if (mode === null) return state;
      const interaction = currentInteraction(state);
      const perOption = interaction.multiSelect === true
        && mode.kind === 'comment'
        && mode.selectedOptionId !== undefined;
      if (perOption) {
        setOptionComment(state, interaction, mode.selectedOptionId!, mode.buffer);
        state.inputMode = null;
        return withAutoExitCheck(state);
      }
      if (interaction.multiSelect) {
        commitMulti(state, interaction, mode.buffer);
      } else {
        const attached = mode.kind === 'comment' ? mode.selectedOptionId : undefined;
        submitOption(state, interaction, attached, mode.buffer);
      }
      state.inputMode = null;
      advanceToNextUnanswered(state);
      return withAutoExitCheck(state);
    }
    case 'input/cancel': {
      state.inputMode = null;
      return withAutoExitCheck(state);
    }

    // ── Final ────────────────────────────────────────────────────────────────
    case 'final/confirm': {
      // Unconditional, same as handleFinal's key.return — partial decks can
      // submit from here too.
      state.autoSubmit = true;
      return state;
    }
    case 'final/back': {
      state.phase = 'overview';
      return state;
    }
    case 'final/prev': {
      state.phase = 'item-review';
      state.currentIndex = state.interactions.length - 1;
      return state;
    }
    default:
      return state;
  }
}

/** Mirrors `checkAutoExit` — run after every item-review / input-mode
 *  mutation that can complete the deck. */
function withAutoExitCheck(state: DeckState): DeckState {
  state.autoSubmit = computeAutoExit(state);
  return state;
}
