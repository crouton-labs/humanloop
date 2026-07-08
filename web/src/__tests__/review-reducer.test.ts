import assert from 'node:assert/strict';
import { reviewReducer, buildInitialReviewState, collectReviewComments, actionsForMouseSelection, type ReviewAction } from '../lib/reviewReducer.ts';
import type { ReviewState } from '../lib/reviewState.ts';
import { sourceSelectionFromByteRange } from '../lib/sourceMap.ts';
import type { ReviewPayload } from '../types.ts';

function payload(content: string): ReviewPayload {
  return {
    kind: 'review',
    file: '/abs/source.md',
    output: '/abs/source.md.feedback.json',
    jobId: 'hl-review-test',
    content,
    result: { file: '/abs/source.md', submitted: false, approved: false, comments: [], savedAt: '2026-07-07T00:00:00.000Z' },
    version: 0,
    activated: true,
  };
}

function run(state: ReviewState, actions: ReviewAction[]): ReviewState {
  return actions.reduce((acc, action) => reviewReducer(acc, action), state);
}

const content = 'line one\nline two\nline three\n';
const base = buildInitialReviewState(payload(content));

// ── Create a line-only comment via the composer ─────────────────────────────
{
  const s = run(base, [
    { type: 'cursor/set-line', line: 2 },
    { type: 'composer/open' },
    { type: 'composer/update', buffer: '  needs work  ' },
    { type: 'composer/submit' },
  ]);
  assert.equal(s.comments.length, 1);
  const c = s.comments[0]!;
  assert.equal(c.line, 2);
  assert.equal(c.endLine, 2);
  assert.equal(c.comment, 'needs work', 'comment text is trimmed');
  assert.equal(c.colStart, undefined, 'line-only comment carries no columns');
  assert.equal(c.lineText, 'line two');
  assert.equal(s.saveState, 'dirty', 'adding a comment marks the draft dirty');
}

// ── A range selection produces a column-anchored comment ────────────────────
{
  // Select "one" on line 1: bytes 5..8.
  const sel = sourceSelectionFromByteRange(base.sourceMap, 5, 8)!;
  const s = run(base, [
    { type: 'selection/set', selection: sel },
    { type: 'composer/open' },
    { type: 'composer/update', buffer: 'tighten' },
    { type: 'composer/submit' },
  ]);
  const c = s.comments[0]!;
  assert.equal(c.colStart, 5);
  assert.equal(c.colEnd, 8);
  assert.equal(c.quote, 'one');
  assert.equal(s.selection, null, 'selection clears after committing a comment');
}

// ── Empty composer submit adds nothing ──────────────────────────────────────
{
  const s = run(base, [
    { type: 'composer/open' },
    { type: 'composer/update', buffer: '   ' },
    { type: 'composer/submit' },
  ]);
  assert.equal(s.comments.length, 0);
  assert.equal(s.composer, null);
}

// ── Edit keeps the anchor, replaces text ────────────────────────────────────
{
  const created = run(base, [
    { type: 'cursor/set-line', line: 1 },
    { type: 'composer/open' },
    { type: 'composer/update', buffer: 'first' },
    { type: 'composer/submit' },
  ]);
  const id = created.comments[0]!.id;
  const edited = run(created, [
    { type: 'draft/save-ack', version: 1, savedComments: collectReviewComments(created) },
    { type: 'composer/edit', id },
    { type: 'composer/update', buffer: 'revised' },
    { type: 'composer/submit' },
  ]);
  assert.equal(edited.comments.length, 1);
  assert.equal(edited.comments[0]!.comment, 'revised');
  assert.equal(edited.comments[0]!.line, 1, 'edit preserves the original anchor');
  assert.equal(edited.saveState, 'dirty', 'editing re-dirties the draft');
}

// ── Editing a column/range comment keeps its columns + quote in the composer ─
{
  // Create a column-anchored comment over "one" on line 1 (bytes 5..8).
  const sel = sourceSelectionFromByteRange(base.sourceMap, 5, 8)!;
  const created = run(base, [
    { type: 'selection/set', selection: sel },
    { type: 'composer/open' },
    { type: 'composer/update', buffer: 'tighten' },
    { type: 'composer/submit' },
  ]);
  const id = created.comments[0]!.id;
  const editing = run(created, [{ type: 'composer/edit', id }]);
  // m3: the composer anchor is derived from the comment, so columns + quote
  // survive (a line-only anchor would drop both from the composer display).
  assert.equal(editing.composer!.mode, 'edit');
  assert.equal(editing.composer!.anchor.colStart, 5, 'edit anchor keeps colStart');
  assert.equal(editing.composer!.anchor.colEnd, 8, 'edit anchor keeps colEnd');
  assert.equal(editing.composer!.anchor.quote, 'one', 'edit anchor keeps the quote');
  assert.equal(editing.composer!.buffer, 'tighten', 'edit seeds the existing comment text');
}

// ── Delete + undo ───────────────────────────────────────────────────────────
{
  const two = run(base, [
    { type: 'cursor/set-line', line: 1 },
    { type: 'composer/open' }, { type: 'composer/update', buffer: 'a' }, { type: 'composer/submit' },
    { type: 'cursor/set-line', line: 2 },
    { type: 'composer/open' }, { type: 'composer/update', buffer: 'b' }, { type: 'composer/submit' },
  ]);
  assert.equal(two.comments.length, 2);
  const deleted = reviewReducer(two, { type: 'comment/delete', id: two.comments[0]!.id });
  assert.equal(deleted.comments.length, 1);
  assert.equal(deleted.comments[0]!.comment, 'b');
  const undone = reviewReducer(deleted, { type: 'comment/undo' });
  assert.equal(undone.comments.length, 0);
}

// ── Cursor motion + Shift range extension ───────────────────────────────────
{
  const moved = run(base, [
    { type: 'cursor/set-line', line: 1 },
    { type: 'cursor/move', delta: 1 },
    { type: 'cursor/move', delta: 1, extend: true },
  ]);
  assert.equal(moved.activeLine, 3);
  assert.ok(moved.selection !== null, 'shift-extend builds a keyboard range');
  assert.equal(moved.selection!.line, 2);
  assert.equal(moved.selection!.endLine, 3);

  const clamped = run(base, [{ type: 'cursor/set-line', line: 1 }, { type: 'cursor/move', delta: -5 }]);
  assert.equal(clamped.activeLine, 1, 'motion clamps at the first line');
  // A5: the lower-bound clamp above was the only clamp asserted — also cover
  // the upper bound (moving past the last source line stays on it).
  const clampedHigh = run(base, [{ type: 'cursor/set-line', line: 3 }, { type: 'cursor/move', delta: 5 }]);
  assert.equal(clampedHigh.activeLine, 3, 'motion clamps at the last line');
  const last = reviewReducer(base, { type: 'cursor/last' });
  assert.equal(last.activeLine, 3, 'G goes to the last source line');
}

// ── submit/request is a single-pulse flag ───────────────────────────────────
{
  const requested = reviewReducer(base, { type: 'submit/request' });
  assert.equal(requested.submitRequested, true);
  const next = reviewReducer(requested, { type: 'cursor/move', delta: 1 });
  assert.equal(next.submitRequested, false, 'submitRequested resets on the next dispatch');
}

// ── conflict adopts server version, lands out of dirty; resolve re-arms autosave ─
{
  const withComment = run(base, [
    { type: 'composer/open' }, { type: 'composer/update', buffer: 'local edit' }, { type: 'composer/submit' },
  ]);
  const conflicted = reviewReducer(withComment, { type: 'draft/conflict', version: 5, message: 'moved on' });
  assert.equal(conflicted.version, 5, 'adopts the server version so an explicit retry writes fresh');
  assert.equal(conflicted.comments.length, 1, 'unsaved local edits are preserved');
  assert.equal(conflicted.saveState, 'conflict', 'lands in conflict, not dirty — the autosave debounce does not re-trigger on conflict');
  assert.equal(conflicted.notice, 'moved on');

  const resolved = reviewReducer(conflicted, { type: 'draft/resolve-conflict' });
  assert.equal(resolved.saveState, 'dirty', 'resolve-conflict re-arms the autosave debounce');
  assert.equal(resolved.version, 5, 'version stays adopted from the conflict');
  assert.equal(resolved.comments.length, 1, 'local edits still preserved through resolve');
  assert.equal(resolved.notice, null);

  // resolve-conflict is a no-op outside conflict state.
  const noop = reviewReducer(withComment, { type: 'draft/resolve-conflict' });
  assert.equal(noop.saveState, 'dirty', 'resolve-conflict does nothing when not in conflict');
}

// ── save-ack: matching snapshot cleans, stale snapshot stays dirty but adopts version ─
{
  const withComment = run(base, [
    { type: 'composer/open' }, { type: 'composer/update', buffer: 'first draft' }, { type: 'composer/submit' },
  ]);
  const sentComments = collectReviewComments(withComment);

  // (a) ack for the exact snapshot that was sent -> clean.
  const acked = reviewReducer(withComment, { type: 'draft/save-ack', version: 2, savedComments: sentComments });
  assert.equal(acked.saveState, 'clean', 'ack matching the live comments cleans the draft');
  assert.equal(acked.version, 2);

  // (b) a newer edit lands while the save was in flight; the ack for the
  // OLDER (now-stale) snapshot must not mark the newer edit clean.
  const editedWhileInFlight = run(withComment, [
    { type: 'composer/open' }, { type: 'composer/update', buffer: 'second draft' }, { type: 'composer/submit' },
  ]);
  const staleAck = reviewReducer(editedWhileInFlight, { type: 'draft/save-ack', version: 2, savedComments: sentComments });
  assert.equal(staleAck.saveState, 'dirty', 'ack for a stale snapshot leaves the newer edit dirty');
  assert.equal(staleAck.version, 2, 'version is still adopted from the ack');
  assert.equal(staleAck.comments.length, 2, 'the newer edit is not lost');
}

// ── actionsForMouseSelection: real selection opens the composer on it ──────
{
  const sel = sourceSelectionFromByteRange(base.sourceMap, 5, 8)!;
  const actions = actionsForMouseSelection(sel);
  assert.deepEqual(actions.map((a) => a.type), ['selection/set', 'composer/open']);
  const s = run(base, actions);
  assert.ok(s.composer !== null, 'composer opens from a mouse selection');
  assert.equal(s.composer!.anchor.colStart, sel.colStart);
  assert.equal(s.composer!.anchor.colEnd, sel.colEnd);
  assert.equal(s.composer!.anchor.line, sel.line);
  assert.equal(s.composer!.anchor.quote, sel.quote);
}

// ── actionsForMouseSelection: unmappable selection clears + notices ────────
{
  const actions = actionsForMouseSelection(null);
  assert.deepEqual(actions.map((a) => a.type), ['selection/clear', 'notice/set']);
  const withSelection: ReviewState = { ...base, selection: sourceSelectionFromByteRange(base.sourceMap, 5, 8)! };
  const s = run(withSelection, actions);
  assert.equal(s.composer, null, 'composer stays closed on an unmappable selection');
  assert.equal(s.selection, null, 'stale selection is cleared');
  assert.equal(s.notice, 'Selection cannot be anchored to source text.');
}

// ── read-only blocks mutation ───────────────────────────────────────────────
// M6: the reducer already guards every mutating action on `state.readOnly`;
// the prior test only exercised `composer/open`. Assert EACH mutating action
// individually is a genuine no-op after `server/mark-readonly`, so a
// regression re-opening any one of them would be caught.
{
  const withComment = run(base, [
    { type: 'cursor/set-line', line: 1 },
    { type: 'composer/open' }, { type: 'composer/update', buffer: 'seed' }, { type: 'composer/submit' },
  ]);
  const commentId = withComment.comments[0]!.id;
  const ro = reviewReducer(withComment, { type: 'server/mark-readonly' });
  assert.equal(ro.readOnly, true);
  assert.equal(ro.comments.length, 1, 'the existing comment survives going read-only');
  assert.equal(ro.saveState, 'dirty', 'server/mark-readonly must not silently force the draft clean while an edit is still unsaved (Finding 2b)');

  const openBlocked = reviewReducer(ro, { type: 'composer/open' });
  assert.equal(openBlocked.composer, null, 'read-only blocks composer/open');

  const editBlocked = reviewReducer(ro, { type: 'composer/edit', id: commentId });
  assert.equal(editBlocked.composer, null, 'read-only blocks composer/edit');

  const composing: ReviewState = { ...ro, composer: { mode: 'create', anchor: { line: 1, endLine: 1, startByte: 0, endByte: 1, lineText: 'a' }, buffer: 'nope' } };
  const submitBlocked = reviewReducer(composing, { type: 'composer/submit' });
  assert.equal(submitBlocked.comments.length, 1, 'read-only blocks composer/submit (no new comment added)');

  const deleteBlocked = reviewReducer(ro, { type: 'comment/delete', id: commentId });
  assert.equal(deleteBlocked.comments.length, 1, 'read-only blocks comment/delete');

  const undoBlocked = reviewReducer(ro, { type: 'comment/undo' });
  assert.equal(undoBlocked.comments.length, 1, 'read-only blocks comment/undo');

  const submitReqBlocked = reviewReducer(ro, { type: 'submit/request' });
  assert.equal(submitReqBlocked.submitRequested, false, 'read-only blocks submit/request');
}

// ── collectReviewComments returns detached copies ───────────────────────────
{
  const s = run(base, [{ type: 'composer/open' }, { type: 'composer/update', buffer: 'x' }, { type: 'composer/submit' }]);
  const collected = collectReviewComments(s);
  collected[0]!.comment = 'mutated';
  assert.equal(s.comments[0]!.comment, 'x', 'collect returns copies, not the live state objects');
}

console.log('OK: review reducer create/edit/delete/undo/motion/submit/stale');
