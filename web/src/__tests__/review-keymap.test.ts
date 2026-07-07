import assert from 'node:assert/strict';
import { handleReviewKey, resetReviewLeaderState, type ReviewKeyEvent, type ReviewKeymapEnv } from '../lib/reviewKeymap.ts';
import { buildInitialReviewState, type ReviewState } from '../lib/reviewState.ts';
import type { ReviewAction } from '../lib/reviewReducer.ts';
import type { ReviewPayload } from '../types.ts';

function payload(): ReviewPayload {
  return {
    kind: 'review', file: '/f', output: '/f.json', jobId: 'j',
    content: 'a\nb\nc\n',
    result: { file: '/f', submitted: false, approved: false, comments: [], savedAt: '' },
    version: 0,
  };
}

const scheduled: Array<() => void> = [];
const env: ReviewKeymapEnv = {
  scrollBy: () => { scrolls.push(true); },
  schedule: (fn) => { scheduled.push(fn); },
};
const scrolls: boolean[] = [];

function press(state: ReviewState, key: string, mods: Partial<ReviewKeyEvent> = {}): ReviewAction[] {
  const actions: ReviewAction[] = [];
  const e: ReviewKeyEvent = { key, preventDefault: () => {}, ...mods };
  handleReviewKey(e, state, (a) => actions.push(a), env);
  return actions;
}

function pressTracked(state: ReviewState, key: string, mods: Partial<ReviewKeyEvent> = {}): { actions: ReviewAction[]; prevented: boolean } {
  const actions: ReviewAction[] = [];
  let prevented = false;
  const e: ReviewKeyEvent = { key, preventDefault: () => { prevented = true; }, ...mods };
  handleReviewKey(e, state, (a) => actions.push(a), env);
  return { actions, prevented };
}

const base = buildInitialReviewState(payload());

// ── Bare motion vs Shift range extension ────────────────────────────────────
{
  resetReviewLeaderState();
  assert.deepEqual(press(base, 'j'), [{ type: 'cursor/move', delta: 1, extend: false }]);
  assert.deepEqual(press(base, 'ArrowUp'), [{ type: 'cursor/move', delta: -1, extend: false }]);
  // M4: browsers report the REAL shape 'J'/shiftKey:true for Shift+j, not
  // 'j'/shiftKey:true — pressing the lowercase key with shiftKey masks the
  // bug this fixes, so assert the actual browser key value.
  assert.deepEqual(press(base, 'J', { shiftKey: true }), [{ type: 'cursor/move', delta: 1, extend: true }]);
  assert.deepEqual(press(base, 'K', { shiftKey: true }), [{ type: 'cursor/move', delta: -1, extend: true }]);
  // Ctrl+j is NOT a motion (must not shadow browser/OS chords).
  assert.deepEqual(press(base, 'j', { ctrlKey: true }), []);
  // 'G' (last-line) and the 'gg' leader must stay case-sensitive — the
  // lowercasing in the motion branch must NOT leak into these.
  resetReviewLeaderState();
  assert.deepEqual(press(base, 'g'), [], 'first g is a leader');
  assert.deepEqual(press(base, 'g'), [{ type: 'cursor/first' }], 'gg still goes to first line');
  assert.deepEqual(press(base, 'G'), [{ type: 'cursor/last' }], 'G still goes to last line');
}

// ── Space leader: space then c/l/u/s ────────────────────────────────────────
{
  resetReviewLeaderState();
  assert.deepEqual(press(base, ' '), [], 'space alone dispatches nothing (leader)');
  assert.deepEqual(press(base, 'c'), [{ type: 'composer/open' }], 'space then c opens the composer');

  resetReviewLeaderState();
  press(base, ' ');
  assert.deepEqual(press(base, 's'), [{ type: 'submit/request' }], 'space then s requests submit');

  resetReviewLeaderState();
  press(base, ' ');
  assert.deepEqual(press(base, 'l'), [{ type: 'list/toggle' }]);
}

// ── A bare 'c' without the space leader is NOT a comment (it scrolls? no-op) ─
{
  resetReviewLeaderState();
  assert.deepEqual(press(base, 'c'), [], 'bare c does nothing without the space leader');
}

// ── gg / G ──────────────────────────────────────────────────────────────────
{
  resetReviewLeaderState();
  assert.deepEqual(press(base, 'g'), [], 'first g is a leader');
  assert.deepEqual(press(base, 'g'), [{ type: 'cursor/first' }], 'gg goes to first line');
  assert.deepEqual(press(base, 'G'), [{ type: 'cursor/last' }]);
}

// ── '?' toggles help; while help is open only Escape/'?' pass ────────────────
{
  resetReviewLeaderState();
  assert.deepEqual(press(base, '?'), [{ type: 'help/toggle' }]);
  const helpOpen: ReviewState = { ...base, helpOpen: true };
  const swallowed = pressTracked(helpOpen, 'j');
  assert.deepEqual(swallowed.actions, [], 'other keys are swallowed while help is open');
  assert.equal(swallowed.prevented, true, 'the swallowed key event is preventDefault-ed, not left to fall through to the page');
  assert.deepEqual(press(helpOpen, 'Escape'), [{ type: 'help/close' }]);
}

// ── Composer focus: native editing, only Escape/Enter intercepted ───────────
{
  resetReviewLeaderState();
  const composing: ReviewState = {
    ...base,
    composer: { mode: 'create', anchor: { line: 1, endLine: 1, startByte: 0, endByte: 1, lineText: 'a' }, buffer: '' },
  };
  assert.deepEqual(press(composing, 'Enter'), [{ type: 'composer/submit' }]);
  assert.deepEqual(press(composing, 'Enter', { shiftKey: true }), [], 'Shift+Enter inserts a newline (native)');
  assert.deepEqual(press(composing, 'Escape'), [{ type: 'composer/cancel' }]);
  assert.deepEqual(press(composing, 'Enter', { isComposing: true }), [], 'IME composition owns Enter');
  assert.deepEqual(press(composing, 'j'), [], 'typing flows to the textarea, not the keymap');
  // M6: Enter on a focused button (e.g. the composer's Cancel/Save) must let
  // native button activation win, not get hijacked into composer/submit.
  assert.deepEqual(press(composing, 'Enter', { target: { tagName: 'BUTTON' } }), [], 'Enter on a focused button lets native activation win, not composer/submit');
  const buttonEnter = pressTracked(composing, 'Enter', { target: { tagName: 'BUTTON' } });
  assert.equal(buttonEnter.prevented, false, 'preventDefault must NOT be called so the browser fires the native button click');
}

// ── Comment list navigation + dd delete ─────────────────────────────────────
{
  resetReviewLeaderState();
  const withList: ReviewState = {
    ...base,
    listOpen: true,
    listIndex: 0,
    comments: [
      { id: 'c1', line: 1, endLine: 1, lineText: 'a', comment: 'x', createdAt: '' },
      { id: 'c2', line: 2, endLine: 2, lineText: 'b', comment: 'y', createdAt: '' },
    ],
  };
  assert.deepEqual(press(withList, 'j'), [{ type: 'list/move', delta: 1 }]);
  assert.deepEqual(press(withList, 'e'), [{ type: 'composer/edit', id: 'c1' }]);
  assert.deepEqual(press(withList, 'Enter'), [{ type: 'composer/edit', id: 'c1' }]);
  resetReviewLeaderState();
  assert.deepEqual(press(withList, 'd'), [], 'first d is a leader');
  assert.deepEqual(press(withList, 'd'), [{ type: 'comment/delete', id: 'c1' }], 'dd deletes the focused comment');
  assert.deepEqual(press(withList, 'q'), [{ type: 'list/close' }]);
}

// ── A stray editable target keeps the keyboard ──────────────────────────────
{
  resetReviewLeaderState();
  assert.deepEqual(press(base, 'j', { target: { tagName: 'TEXTAREA' } }), []);
}

console.log('OK: review keymap dispatches the shared reducer actions');
