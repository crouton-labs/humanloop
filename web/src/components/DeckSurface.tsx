import { useEffect, useReducer, useRef, useState } from 'react';
import type { Deck, InteractionResponse } from '@/types';
import { buildInitialState, collectResponses } from '@/lib/deckState';
import { deckReducer } from '@/lib/deckReducer';
import { assignShortcuts } from '@/lib/assignShortcuts';
import { useDeckKeymap } from '@/hooks/useDeckKeymap';
import { cn } from '@/lib/utils';
import { Overview } from '@/components/deck/Overview';
import { ItemReview } from '@/components/deck/ItemReview';
import { FinalSummary } from '@/components/deck/FinalSummary';
import { HelpOverlay } from '@/components/HelpOverlay';

export interface DeckSurfaceProps {
  deck: Deck;
  /** Terminal-owned progress snapshot captured at browser handoff. */
  initialResponses?: InteractionResponse[];
  onSubmit: (responses: InteractionResponse[]) => void;
  /** True once the deck has converged (submitted / taken-back / erroring on
   *  the initial load) — detaches the keymap and dims the UI; there's
   *  nothing left to navigate. */
  disabled: boolean;
}

/**
 * Owns the deck's interactive state (`deckReducer`) and renders whichever
 * phase is active. `deck` is only read once (React lazy-init via
 * `useReducer(reducer, deck, buildInitialState)`) — a live `deck-updated`
 * mid-session refetch is out of scope for phase 2 (see
 * phase2-deck-ui-notes.md); re-mount this component (change its `key`) to
 * pick up a fresh deck.
 */
export function DeckSurface({ deck, initialResponses = [], onSubmit, disabled }: DeckSurfaceProps) {
  // Mutates deck.interactions in place, filling in option.shortcut — see
  // lib/assignShortcuts.ts for why the browser must compute these itself
  // rather than trusting deck.json (the terminal never persists them).
  assignShortcuts(deck.interactions);

  const [state, dispatch] = useReducer(deckReducer, { deck, initialResponses }, ({ deck: initialDeck, initialResponses: restored }) => buildInitialState(initialDeck, restored));
  const scrollRef = useRef<HTMLDivElement>(null);
  const [helpOpen, setHelpOpen] = useState(false);

  useDeckKeymap(state, dispatch, {
    scrollRef,
    modalOpen: helpOpen,
    onToggleHelp: () => setHelpOpen((v) => !v),
    onCloseModal: () => setHelpOpen(false),
    disabled,
  });

  // Mirrors the terminal's `checkAutoExit`: single-select decks (and the
  // overview's "q when everything's answered" fast path, and Final's own
  // Enter) submit directly instead of always parking on a confirm screen.
  // Safe to fire on every pulse without a fired-once guard: the server's
  // `/api/submit` is itself single-assignment (a duplicate POST gets a 409
  // echoing the canonical result, per the phase 1 contract) — this effect
  // only re-runs when a NEW dispatch produces a fresh `state` reference,
  // which can't happen once `disabled` detaches the keymap.
  useEffect(() => {
    if (state.autoSubmit) onSubmit(collectResponses(state));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  const multiInteraction = state.interactions.length > 1;

  return (
    <div className={cn('flex flex-col gap-4 transition-opacity', disabled && 'pointer-events-none opacity-60')}>
      {state.phase === 'overview' && <Overview state={state} dispatch={dispatch} />}
      {state.phase === 'item-review' && (
        <ItemReview state={state} dispatch={dispatch} scrollRef={scrollRef} multiInteraction={multiInteraction} />
      )}
      {state.phase === 'final' && <FinalSummary state={state} dispatch={dispatch} />}
      {helpOpen && <HelpOverlay onClose={() => setHelpOpen(false)} />}
    </div>
  );
}
