import type { FeedbackComment, ReviewPayload } from '@/types';
import type { SourceSelection } from './sourceMap';
import { reviewCommentsFingerprint, sourceSelectionFromComment } from './sourceMap';
import { unitIndexForLine } from './anchorUnits';
import {
  type ReviewState,
  buildInitialReviewState,
  collectReviewComments,
  makeFeedbackComment,
  replaceFromPayload,
  selectedAnchor,
} from './reviewState';

export type ReviewAction =
  | { type: 'server/replace'; review: ReviewPayload }
  | { type: 'server/mark-readonly'; reason?: string }
  | { type: 'server/unmark-readonly' }
  | { type: 'cursor/move'; delta: number; extend?: boolean }
  | { type: 'cursor/set-line'; line: number }
  | { type: 'cursor/first' }
  | { type: 'cursor/last' }
  | { type: 'selection/set'; selection: SourceSelection }
  | { type: 'selection/clear' }
  | { type: 'composer/open' }
  | { type: 'composer/edit'; id: string }
  | { type: 'composer/update'; buffer: string }
  | { type: 'composer/submit' }
  | { type: 'composer/cancel' }
  | { type: 'comment/delete'; id: string }
  | { type: 'comment/undo' }
  | { type: 'list/toggle' }
  | { type: 'list/close' }
  | { type: 'list/move'; delta: number }
  | { type: 'help/toggle' }
  | { type: 'help/close' }
  | { type: 'draft/save-start' }
  | { type: 'draft/save-ack'; version: number; savedComments: FeedbackComment[] }
  | { type: 'draft/save-error'; message: string; version?: number }
  | { type: 'draft/conflict'; version: number; message: string }
  | { type: 'draft/resolve-conflict' }
  | { type: 'draft/external-update'; version: number; message: string }
  | { type: 'submit/request' }
  | { type: 'submit/clear-request' }
  | { type: 'notice/set'; message: string }
  | { type: 'notice/clear' };

function clampLine(state: ReviewState, line: number): number {
  return Math.max(1, Math.min(line, Math.max(1, state.sourceMap.lines.length)));
}

function clampUnit(state: ReviewState, index: number): number {
  return Math.max(0, Math.min(index, state.units.length - 1));
}

function clone(state: ReviewState): ReviewState {
  return { ...state, submitRequested: false };
}

function markDirty(state: ReviewState): ReviewState {
  return { ...state, saveState: 'dirty', notice: null };
}

function setListIndex(state: ReviewState, index: number): number {
  if (state.comments.length === 0) return 0;
  return Math.max(0, Math.min(index, state.comments.length - 1));
}

export function reviewReducer(prev: ReviewState, action: ReviewAction): ReviewState {
  if (action.type === 'server/replace') return replaceFromPayload(prev, action.review);
  const state = clone(prev);

  switch (action.type) {
    case 'server/mark-readonly':
      return { ...state, readOnly: true, composer: null, notice: action.reason ?? state.notice };

    // Counterpart to mark-readonly, for the ONE freeze reason that isn't
    // permanently terminal: a submit attempt that fails. mark-readonly is a
    // ratchet everywhere else (taking-back/taken-back/submitted/etc. never
    // reverse), so this must only ever be dispatched from the submit
    // failure path in ReviewSurface — never generically alongside
    // mark-readonly, or a genuinely terminal freeze could be undone.
    case 'server/unmark-readonly':
      return { ...state, readOnly: false };

    case 'cursor/move': {
      // Keyboard motion steps unit-to-unit. A bare move clears any mouse
      // selection and range origin; a Shift-extend fixes the origin at the
      // current unit and widens toward the new one.
      if (action.extend) {
        if (state.selectionAnchorUnit === null) state.selectionAnchorUnit = state.activeUnit;
      } else {
        state.selectionAnchorUnit = null;
      }
      state.selection = null;
      state.activeUnit = clampUnit(state, state.activeUnit + action.delta);
      return state;
    }

    case 'cursor/set-line':
      state.activeUnit = unitIndexForLine(state.units, clampLine(state, action.line));
      state.selection = null;
      state.selectionAnchorUnit = null;
      return state;

    case 'cursor/first':
      state.activeUnit = 0;
      state.selection = null;
      state.selectionAnchorUnit = null;
      return state;

    case 'cursor/last':
      state.activeUnit = Math.max(0, state.units.length - 1);
      state.selection = null;
      state.selectionAnchorUnit = null;
      return state;

    case 'selection/set':
      state.selection = action.selection;
      state.activeUnit = unitIndexForLine(state.units, clampLine(state, action.selection.line));
      state.selectionAnchorUnit = null;
      return state;

    case 'selection/clear':
      state.selection = null;
      state.selectionAnchorUnit = null;
      return state;

    case 'composer/open':
      if (state.readOnly) return state;
      state.composer = { mode: 'create', anchor: selectedAnchor(state), buffer: '' };
      state.listOpen = false;
      return state;

    case 'composer/edit': {
      if (state.readOnly) return state;
      const comment = state.comments.find((candidate) => candidate.id === action.id);
      if (comment === undefined) return state;
      // Derive the edit anchor from the comment itself so a column/range comment
      // keeps its column span + quote in the composer (a line-only range would
      // silently drop both from the display).
      const anchor = sourceSelectionFromComment(comment, state.sourceMap) ?? selectedAnchor(state);
      state.composer = { mode: 'edit', anchor, commentId: comment.id, buffer: comment.comment };
      state.selection = anchor;
      state.activeUnit = unitIndexForLine(state.units, clampLine(state, comment.line));
      state.selectionAnchorUnit = null;
      state.listOpen = false;
      return state;
    }

    case 'composer/update':
      if (state.composer === null) return state;
      state.composer = { ...state.composer, buffer: action.buffer };
      return state;

    case 'composer/submit': {
      if (state.readOnly || state.composer === null) return state;
      const text = state.composer.buffer.trim();
      if (text.length === 0) {
        state.composer = null;
        return state;
      }
      if (state.composer.mode === 'edit' && state.composer.commentId !== undefined) {
        state.comments = state.comments.map((comment) => (
          comment.id === state.composer?.commentId ? { ...comment, comment: text } : comment
        ));
      } else {
        state.comments = [...state.comments, makeFeedbackComment(state.composer.anchor, text)];
        state.listIndex = state.comments.length - 1;
      }
      state.composer = null;
      state.selection = null;
      return markDirty(state);
    }

    case 'composer/cancel':
      state.composer = null;
      return state;

    case 'comment/delete':
      if (state.readOnly) return state;
      state.comments = state.comments.filter((comment) => comment.id !== action.id);
      state.listIndex = setListIndex(state, state.listIndex);
      return markDirty(state);

    case 'comment/undo':
      if (state.readOnly || state.comments.length === 0) return state;
      state.comments = state.comments.slice(0, -1);
      state.listIndex = setListIndex(state, state.listIndex);
      return markDirty(state);

    case 'list/toggle':
      state.listOpen = !state.listOpen;
      state.composer = null;
      state.listIndex = setListIndex(state, state.listIndex);
      return state;

    case 'list/close':
      state.listOpen = false;
      return state;

    case 'list/move':
      state.listIndex = setListIndex(state, state.listIndex + action.delta);
      return state;

    case 'help/toggle':
      state.helpOpen = !state.helpOpen;
      return state;

    case 'help/close':
      state.helpOpen = false;
      return state;

    case 'draft/save-start':
      if (state.saveState === 'dirty' || state.saveState === 'save-error') state.saveState = 'saving';
      return state;

    case 'draft/save-ack': {
      state.version = action.version;
      // Only clear `dirty` when the LIVE comments still match what this
      // request actually saved. An older in-flight autosave's ack must not
      // mark newer local edits (made while the request was in flight) clean
      // — that would leave them unsaved with no follow-up autosave scheduled.
      // If they've diverged, adopt the version but stay dirty so the newer
      // state gets its own autosave.
      const stillMatchesSaved = reviewCommentsFingerprint(state.comments) === reviewCommentsFingerprint(action.savedComments);
      if (stillMatchesSaved) {
        state.saveState = 'clean';
        state.notice = null;
      } else {
        state.saveState = 'dirty';
      }
      return state;
    }

    case 'draft/save-error':
      if (action.version !== undefined) state.version = action.version;
      state.saveState = 'save-error';
      state.notice = action.message;
      return state;

    case 'draft/conflict':
      // A 409 stale_draft means another tab/nvim saved a NEWER draft. Adopt
      // the server's version token (so an explicit retry writes against the
      // right baseVersion) but land in `conflict`, not `dirty` — `conflict`
      // does NOT re-arm the autosave debounce, so the newer server draft is
      // never silently overwritten. Local edits stay in `state.comments`
      // untouched; only an explicit `draft/resolve-conflict` (a user action)
      // turns this back into a real save attempt.
      state.version = action.version;
      state.saveState = 'conflict';
      state.notice = action.message;
      return state;

    case 'draft/resolve-conflict':
      // Explicit user retry: the human has seen the conflict banner and
      // chosen to save their local edits over the server's newer draft.
      if (state.saveState !== 'conflict') return state;
      state.saveState = 'dirty';
      state.notice = null;
      return state;

    case 'draft/external-update':
      state.version = action.version;
      state.notice = action.message;
      return state;

    case 'submit/request':
      if (state.readOnly) return state;
      state.submitRequested = true;
      return state;

    case 'submit/clear-request':
      state.submitRequested = false;
      return state;

    case 'notice/set':
      state.notice = action.message;
      return state;

    case 'notice/clear':
      state.notice = null;
      return state;

    default:
      return state;
  }
}

// Pure mapping from a mouse-selection result to the reducer actions it should
// dispatch — split out of `ReviewDocument`'s `onMouseUp` so mouse and keyboard
// share the exact same tested action sequence (the deck's proven
// mouse/keyboard-parity pattern; see `lib/reviewKeymap.ts`). A successful
// selection sets it AND opens the composer on it, matching the advertised
// "drag text — select ... and open a source-backed comment" contract (the
// same path `space c` and the "Add comment" button already take through
// `selectedAnchor`). An unmappable selection clears any stale selection and
// surfaces the existing non-blocking notice instead.
export function actionsForMouseSelection(selection: SourceSelection | null): ReviewAction[] {
  if (selection === null) {
    return [
      { type: 'selection/clear' },
      { type: 'notice/set', message: 'Selection cannot be anchored to source text.' },
    ];
  }
  return [
    { type: 'selection/set', selection },
    { type: 'composer/open' },
  ];
}

export { buildInitialReviewState, collectReviewComments };
