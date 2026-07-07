import { useCallback } from 'react';
import type { RefObject } from 'react';
import type { DeckState } from '@/lib/deckState';
import type { DeckAction } from '@/lib/deckReducer';
import { useGlobalKeydown, isEditableTarget, isPlainKey } from './useGlobalKeydown';

// ── Deck keymap ──────────────────────────────────────────────────────────────
// A DECK-SPECIFIC consumer of `useGlobalKeydown` (the reusable primitive).
// Mirrors `src/tui/input.ts`'s `handleKeypress`/`handleOverview`/
// `handleItemReview`/`handleInteractionAction`/`handleInputMode` branch order
// key-for-key, but dispatches `DeckAction`s at the reducer (`deckReducer.ts`)
// instead of mutating a terminal `TuiState` — every mouse click in the deck
// components dispatches the exact same actions, so keyboard and mouse can
// never drift out of sync.
//
// Phase 3 (nvim-review web UI) will NOT reuse this hook directly — review's
// keymap is a different key→action mapping over a different state shape —
// but should follow the same pattern: a thin hook built on
// `useGlobalKeydown`, dispatching actions into its own reducer.
//
// Deliberate deviations from the terminal keymap (documented, not oversights):
//  - No ctrl+d/ctrl+u/ctrl+e/ctrl+y scroll aliases — those exist in the
//    terminal because some tmux configs intercept plain Ctrl+D/Ctrl+U; a
//    browser tab has no such interception problem, and Ctrl+D/Ctrl+W are
//    real browser shortcuts (bookmark, close tab) not safe to shadow. Plain
//    `u`/`d` and PageUp/PageDown (an explicit acceptance criterion) cover it.
//  - Text editing inside the comment/freetext textarea relies on the
//    browser's native textarea behavior (cursor motion, word-jump, undo,
//    IME) instead of porting the terminal's hand-rolled emacs-style bindings
//    (ctrl+u line-discard, alt+backspace word-delete, ...) — a real
//    `<textarea>` already provides equivalent-or-better editing, and
//    hijacking ctrl+u/ctrl+a would fight real browser/OS shortcuts. Only
//    Escape (cancel), Tab (cycle attached option), and Enter-without-Shift
//    (submit) are intercepted; Shift+Enter inserts a newline via the
//    textarea's own default behavior.
//  - `space` "expand context" on a single-select interaction is a no-op: the
//    terminal's expand reveals a `VisualBlock` the host generates locally
//    (screenshots/ansi context) — there is no HTTP channel carrying that to
//    the browser today (see phase2-deck-ui-notes.md), so there's nothing to
//    expand. Space is still swallowed (`preventDefault`) so it never
//    scrolls the page.

export interface UseDeckKeymapOpts {
  /** Scrollable body region (subtitle/body markdown) — u/d/PageUp/PageDown
   *  scroll this element directly; it's view state, not deck state, so it
   *  bypasses the reducer entirely. */
  scrollRef: RefObject<HTMLElement | null>;
  /** True while the `?` help overlay (or any other modal) owns the keyboard —
   *  only Escape/`?` are processed; every other key is swallowed. */
  modalOpen: boolean;
  onToggleHelp: () => void;
  onCloseModal: () => void;
  /** Detach the listener entirely once the deck has converged (submitted /
   *  taken-back / errored) — nothing left to navigate. */
  disabled?: boolean;
}

const SCROLL_STEP_PX = 220; // ~10 terminal rows at a typical line-height

export function useDeckKeymap(
  state: DeckState,
  dispatch: (action: DeckAction) => void,
  opts: UseDeckKeymapOpts,
): void {
  const handler = useCallback((e: KeyboardEvent) => {
    const { scrollRef, modalOpen, onToggleHelp, onCloseModal } = opts;

    if (modalOpen) {
      if (e.key === 'Escape') { e.preventDefault(); onCloseModal(); }
      else if (e.key === '?') { e.preventDefault(); onToggleHelp(); }
      return;
    }
    if (e.key === '?' && isPlainKey(e) && !isEditableTarget(e.target)) {
      e.preventDefault();
      onToggleHelp();
      return;
    }

    // ── Input mode (comment / freetext textarea) ──────────────────────────
    // Only intercept the three keys the textarea itself shouldn't own;
    // everything else (typing, arrows, backspace, native word-jump...) falls
    // through to the browser's default textarea behavior + the controlled
    // component's onChange.
    if (state.inputMode !== null) {
      if (e.key === 'Escape') {
        e.preventDefault();
        dispatch({ type: 'input/cancel' });
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        dispatch({ type: 'input/cycle-attached' });
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        dispatch({ type: 'input/submit' });
        return;
      }
      return;
    }

    // Deck-navigation shortcuts never fire while focus sits in a text field
    // (a stray textarea/input elsewhere on the page, e.g. inside rendered
    // markdown — belt-and-suspenders since inputMode already gates the one
    // textarea we render).
    if (isEditableTarget(e.target)) return;

    if (state.phase === 'overview') {
      if ((e.key === 'j' || e.key === 'ArrowDown') && isPlainKey(e)) {
        e.preventDefault();
        dispatch({ type: 'overview/move', delta: 1 });
        return;
      }
      if ((e.key === 'k' || e.key === 'ArrowUp') && isPlainKey(e)) {
        e.preventDefault();
        dispatch({ type: 'overview/move', delta: -1 });
        return;
      }
      if ((e.key === 'Enter' || e.key === ' ') && isPlainKey(e)) {
        e.preventDefault();
        dispatch({ type: 'overview/enter' });
        return;
      }
      if (e.key === 'q' && isPlainKey(e)) {
        e.preventDefault();
        dispatch({ type: 'overview/finish' });
        return;
      }
      const interaction = state.interactions[state.currentIndex];
      if (interaction !== undefined && isPlainKey(e)) {
        const matched = interaction.options.find((o) => o.shortcut === e.key.toLowerCase());
        if (matched !== undefined) {
          e.preventDefault();
          dispatch({ type: 'overview/quick-answer', optionId: matched.id });
        }
      }
      return;
    }

    if (state.phase === 'item-review') {
      const interaction = state.interactions[state.currentIndex]!;
      const opts = interaction.options;

      if (e.key === 'n' && isPlainKey(e)) { e.preventDefault(); dispatch({ type: 'item-review/step', delta: 1 }); return; }
      if (e.key === 'p' && isPlainKey(e)) { e.preventDefault(); dispatch({ type: 'item-review/step', delta: -1 }); return; }
      if ((e.key === 'q' || e.key === 'Escape') && isPlainKey(e)) {
        e.preventDefault();
        dispatch({ type: 'item-review/back' });
        return;
      }
      if (e.key === ' ' && isPlainKey(e)) {
        e.preventDefault();
        if (interaction.multiSelect && state.selectedAction < opts.length) {
          dispatch({ type: 'item-review/toggle-option', optionId: opts[state.selectedAction]!.id });
        }
        // else: no-op (no visual-context channel to expand — see file header)
        return;
      }
      if (e.key === 'd' && isPlainKey(e)) { e.preventDefault(); scrollRef.current?.scrollBy({ top: SCROLL_STEP_PX, behavior: 'smooth' }); return; }
      if (e.key === 'PageDown') { e.preventDefault(); scrollRef.current?.scrollBy({ top: SCROLL_STEP_PX, behavior: 'smooth' }); return; }
      if (e.key === 'u' && isPlainKey(e)) { e.preventDefault(); scrollRef.current?.scrollBy({ top: -SCROLL_STEP_PX, behavior: 'smooth' }); return; }
      if (e.key === 'PageUp') { e.preventDefault(); scrollRef.current?.scrollBy({ top: -SCROLL_STEP_PX, behavior: 'smooth' }); return; }

      if ((e.key === 'j' || e.key === 'ArrowDown') && isPlainKey(e)) {
        e.preventDefault();
        dispatch({ type: 'item-review/move-focus', delta: 1 });
        return;
      }
      if ((e.key === 'k' || e.key === 'ArrowUp') && isPlainKey(e)) {
        e.preventDefault();
        dispatch({ type: 'item-review/move-focus', delta: -1 });
        return;
      }

      // handleInteractionAction, in the terminal's own order: shortcut match,
      // then 'c' comment-attach, then freetext-only 'r'/Enter, then
      // generic Enter-on-row.
      if (isPlainKey(e)) {
        const matched = opts.find((o) => o.shortcut === e.key.toLowerCase());
        if (matched !== undefined) {
          e.preventDefault();
          if (interaction.multiSelect) dispatch({ type: 'item-review/toggle-option', optionId: matched.id });
          else dispatch({ type: 'item-review/pick-option', optionId: matched.id });
          return;
        }
      }
      if (e.key === 'c' && isPlainKey(e) && interaction.allowFreetext && opts.length > 0) {
        e.preventDefault();
        const onOption = state.selectedAction < opts.length;
        dispatch({
          type: 'item-review/open-comment',
          optionId: onOption ? opts[state.selectedAction]!.id : undefined,
        });
        return;
      }
      if (interaction.allowFreetext && opts.length === 0) {
        if ((e.key === 'r' || e.key === 'Enter') && isPlainKey(e)) {
          e.preventDefault();
          dispatch({ type: 'item-review/open-freetext' });
          return;
        }
      }
      if (e.key === 'Enter' && isPlainKey(e)) {
        e.preventDefault();
        dispatch({ type: 'item-review/enter-row' });
        return;
      }
      return;
    }

    if (state.phase === 'final') {
      if (e.key === 'Enter' && isPlainKey(e)) { e.preventDefault(); dispatch({ type: 'final/confirm' }); return; }
      if (e.key === 'Escape' && isPlainKey(e)) { e.preventDefault(); dispatch({ type: 'final/back' }); return; }
      if (e.key === 'p' && isPlainKey(e)) { e.preventDefault(); dispatch({ type: 'final/prev' }); return; }
    }
  }, [state, dispatch, opts]);

  useGlobalKeydown(handler, !opts.disabled);
}
