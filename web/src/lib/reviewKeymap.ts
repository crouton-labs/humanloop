import type { ReviewState } from './reviewState';
import type { ReviewAction } from './reviewReducer';
// Reuse the ONE shared implementation of the key-event predicates (also used by
// `useGlobalKeydown`/the deck keymap) rather than re-deriving equivalents here.
// They're duck-typed, so this module stays pure/DOM-free and unit-testable
// against plain `ReviewKeyEvent` fixtures. Aliased to the names the mapping
// reads best with.
import {
  hasNoCtrlMetaAlt as noCtrlMetaAlt,
  hasNoModifiers as noModifiers,
  isComposingKey as composing,
  isEditableTarget as editableTarget,
  isButtonTarget as buttonTarget,
} from './keyEvent';

// Pure key→action mapping for the review surface, split out of the React hook
// (`hooks/useReviewKeymap.ts`) so it can be unit-tested without a DOM/React
// runtime. Mouse handlers in the review components dispatch these SAME actions,
// so keyboard and mouse can never drift — the deck's proven parity pattern.

export interface ReviewKeymapEnv {
  /** Scroll the document region by `top` px (view state, bypasses the reducer). */
  scrollBy: (top: number) => void;
  /** Schedule a one-shot timer (leader-key timeout). */
  schedule: (fn: () => void, ms: number) => void;
}

export interface ReviewKeyEvent {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
  target?: unknown;
  preventDefault: () => void;
}

const SCROLL_STEP_PX = 260;
const LEADER_TIMEOUT_MS = 650;

// Leader-key state (space, gg, dd) — module-scoped so a two-key sequence spans
// two events. Reset defensively on any non-matching key.
let pendingSpace = false;
let pendingG = false;
let pendingD = false;

/** Test/reset hook so leader state never leaks between cases. */
export function resetReviewLeaderState(): void {
  pendingSpace = false;
  pendingG = false;
  pendingD = false;
}

export function handleReviewKey(
  e: ReviewKeyEvent,
  state: ReviewState,
  dispatch: (action: ReviewAction) => void,
  env: ReviewKeymapEnv,
): void {
  // Help overlay owns the keyboard.
  if (state.helpOpen) {
    if (e.key === 'Escape' || e.key === '?') { e.preventDefault(); dispatch({ type: 'help/close' }); return; }
    e.preventDefault();
    return;
  }

  // Composer owns the keyboard: native text editing, only Escape/Enter/IME.
  if (state.composer !== null) {
    if (composing(e)) return;
    if (e.key === 'Escape') { e.preventDefault(); dispatch({ type: 'composer/cancel' }); return; }
    if (e.key === 'Enter' && !e.shiftKey && noCtrlMetaAlt(e) && !buttonTarget(e.target)) { e.preventDefault(); dispatch({ type: 'composer/submit' }); return; }
    return;
  }

  // A stray editable element elsewhere on the page keeps the keyboard.
  if (editableTarget(e.target)) return;

  if (e.key === '?' && noCtrlMetaAlt(e)) { e.preventDefault(); dispatch({ type: 'help/toggle' }); return; }

  // ── Space leader (space then c/l/u/s) ──────────────────────────────────
  if (pendingSpace) {
    pendingSpace = false;
    if (noCtrlMetaAlt(e)) {
      if (e.key === 'c') { e.preventDefault(); dispatch({ type: 'composer/open' }); return; }
      if (e.key === 'l') { e.preventDefault(); dispatch({ type: 'list/toggle' }); return; }
      if (e.key === 'u') { e.preventDefault(); dispatch({ type: 'comment/undo' }); return; }
      if (e.key === 's') { e.preventDefault(); dispatch({ type: 'submit/request' }); return; }
    }
  }
  if (e.key === ' ' && noModifiers(e)) {
    e.preventDefault();
    pendingSpace = true;
    env.schedule(() => { pendingSpace = false; }, LEADER_TIMEOUT_MS);
    return;
  }

  if (e.key === 'Escape' && noCtrlMetaAlt(e)) {
    e.preventDefault();
    if (state.listOpen) dispatch({ type: 'list/close' });
    else dispatch({ type: 'selection/clear' });
    return;
  }

  // ── Comment list navigation ────────────────────────────────────────────
  if (state.listOpen) {
    if ((e.key === 'j' || e.key === 'ArrowDown') && noModifiers(e)) { e.preventDefault(); dispatch({ type: 'list/move', delta: 1 }); return; }
    if ((e.key === 'k' || e.key === 'ArrowUp') && noModifiers(e)) { e.preventDefault(); dispatch({ type: 'list/move', delta: -1 }); return; }
    if ((e.key === 'q') && noCtrlMetaAlt(e)) { e.preventDefault(); dispatch({ type: 'list/close' }); return; }
    if ((e.key === 'e' || e.key === 'Enter') && noCtrlMetaAlt(e)) {
      const comment = state.comments[state.listIndex];
      if (comment !== undefined) { e.preventDefault(); dispatch({ type: 'composer/edit', id: comment.id }); }
      return;
    }
    if (e.key === 'd' && noCtrlMetaAlt(e)) {
      if (pendingD) {
        pendingD = false;
        const comment = state.comments[state.listIndex];
        if (comment !== undefined) { e.preventDefault(); dispatch({ type: 'comment/delete', id: comment.id }); }
      } else {
        e.preventDefault();
        pendingD = true;
        env.schedule(() => { pendingD = false; }, LEADER_TIMEOUT_MS);
      }
      return;
    }
    pendingD = false;
    return;
  }

  // ── gg leader ──────────────────────────────────────────────────────────
  if (e.key === 'g' && noModifiers(e)) {
    if (pendingG) { pendingG = false; e.preventDefault(); dispatch({ type: 'cursor/first' }); return; }
    e.preventDefault();
    pendingG = true;
    env.schedule(() => { pendingG = false; }, LEADER_TIMEOUT_MS);
    return;
  }
  pendingG = false;

  // ── Motion + Shift range extension ─────────────────────────────────────
  // Browsers report `'J'`/`'K'` for Shift+j/k, not `'j'`/`'k'` — lowercase
  // ONLY inside this motion branch (never globally: `'G'`/the `gg` leader
  // above must stay case-sensitive) so the advertised Shift+j/k range
  // extension actually fires.
  const shiftExtend = e.shiftKey === true && noCtrlMetaAlt(e);
  const lowerMotionKey = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if ((lowerMotionKey === 'j' || e.key === 'ArrowDown') && (noModifiers(e) || shiftExtend)) {
    e.preventDefault();
    dispatch({ type: 'cursor/move', delta: 1, extend: shiftExtend });
    return;
  }
  if ((lowerMotionKey === 'k' || e.key === 'ArrowUp') && (noModifiers(e) || shiftExtend)) {
    e.preventDefault();
    dispatch({ type: 'cursor/move', delta: -1, extend: shiftExtend });
    return;
  }
  if (e.key === 'G' && noCtrlMetaAlt(e)) { e.preventDefault(); dispatch({ type: 'cursor/last' }); return; }

  // ── Scroll (view state only) ───────────────────────────────────────────
  if (e.key === 'PageDown') { e.preventDefault(); env.scrollBy(SCROLL_STEP_PX); return; }
  if (e.key === 'PageUp') { e.preventDefault(); env.scrollBy(-SCROLL_STEP_PX); return; }
  if (e.key === 'd' && noModifiers(e)) { e.preventDefault(); env.scrollBy(SCROLL_STEP_PX); return; }
  if (e.key === 'u' && noModifiers(e)) { e.preventDefault(); env.scrollBy(-SCROLL_STEP_PX); return; }
}
