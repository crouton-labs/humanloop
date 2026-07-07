import { useCallback } from 'react';
import type { RefObject } from 'react';
import type { ReviewState } from '@/lib/reviewState';
import type { ReviewAction } from '@/lib/reviewReducer';
import { handleReviewKey, type ReviewKeyEvent } from '@/lib/reviewKeymap';
import { useGlobalKeydown } from './useGlobalKeydown';

export interface UseReviewKeymapOpts {
  scrollRef: RefObject<HTMLElement | null>;
  disabled?: boolean;
}

/**
 * Review keymap: a thin React binding over the pure `handleReviewKey` core
 * (`lib/reviewKeymap.ts`), built on the shared `useGlobalKeydown` primitive.
 * Deliberately NOT a reuse of `useDeckKeymap` — review is a different key→action
 * mapping over a different reducer, so it shares the primitive, not the deck
 * consumer (per the Phase-2 handoff notes).
 */
export function useReviewKeymap(
  state: ReviewState,
  dispatch: (action: ReviewAction) => void,
  opts: UseReviewKeymapOpts,
): void {
  const handler = useCallback((e: KeyboardEvent) => {
    handleReviewKey(e as unknown as ReviewKeyEvent, state, dispatch, {
      scrollBy: (top) => opts.scrollRef.current?.scrollBy({ top, behavior: 'smooth' }),
      schedule: (fn, ms) => window.setTimeout(fn, ms),
    });
  }, [state, dispatch, opts]);

  useGlobalKeydown(handler, opts.disabled !== true);
}
