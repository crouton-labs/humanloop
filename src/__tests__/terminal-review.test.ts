import assert from 'node:assert/strict';
import {
  closeCompose,
  closeList,
  commitCompose,
  currentAnchor,
  deleteAtListIndex,
  initReviewState,
  moveActiveLine,
  moveListIndex,
  openComposeEdit,
  openComposeNew,
  openList,
  renderReviewFrame,
  scrollBy,
  textBackspace,
  textEnd,
  textHome,
  textInsert,
  textVertical,
  undoLast,
} from '../editor/terminal-review.js';

const sourceLines = ['# Title', 'line two', 'line three', 'line four', 'line five'];

// Anchor motion: j/k move the active line; Shift+j/k extends a range in either direction.
{
  let state = initReviewState(sourceLines, [], 0);
  assert.deepEqual(currentAnchor(state), { line: 1, endLine: 1 });
  state = moveActiveLine(state, 1, false);
  state = moveActiveLine(state, 1, false);
  assert.deepEqual(currentAnchor(state), { line: 3, endLine: 3 }, 'j moves the anchor forward');
  state = moveActiveLine(state, 1, true);
  assert.deepEqual(currentAnchor(state), { line: 3, endLine: 4 }, 'shift+j extends the range downward');
  state = moveActiveLine(state, -2, true);
  assert.deepEqual(currentAnchor(state), { line: 2, endLine: 3 }, 'shift+k can extend the range back past the anchor');
  state = moveActiveLine(state, 1, false);
  assert.deepEqual(currentAnchor(state), { line: 3, endLine: 3 }, 'a plain j/k clears the range');
  // Bounds
  state = moveActiveLine(state, -100, false);
  assert.equal(state.activeLine, 1, 'anchor cannot move above line 1');
  state = moveActiveLine(state, 100, false);
  assert.equal(state.activeLine, sourceLines.length, 'anchor cannot move past the last source line');
}

// Compose: commit builds a comment anchored to the current range with the raw source text captured.
{
  let state = initReviewState(sourceLines, [], 0);
  state = moveActiveLine(state, 1, false); // line 2
  state = moveActiveLine(state, 1, true); // range 2-3
  state = openComposeNew(state);
  assert.equal(state.mode, 'compose');
  assert.deepEqual(state.compose?.anchor, { line: 2, endLine: 3 });
  state = { ...state, compose: { ...state.compose!, buffer: 'needs a rewrite' } };
  state = commitCompose(state, '2024-01-01T00:00:00.000Z');
  assert.equal(state.mode, 'view');
  assert.equal(state.comments.length, 1);
  const [comment] = state.comments;
  assert.equal(comment!.line, 2);
  assert.equal(comment!.endLine, 3);
  assert.equal(comment!.lineText, 'line two\nline three');
  assert.equal(comment!.comment, 'needs a rewrite');
  assert.equal(comment!.createdAt, '2024-01-01T00:00:00.000Z');

  // Empty compose cancels rather than adding a blank comment.
  state = openComposeNew(state);
  state = commitCompose(state);
  assert.equal(state.comments.length, 1, 'an empty buffer commit is a no-op cancel');
  assert.equal(state.mode, 'view');

  // Editing from the list updates the existing comment in place and returns to list mode.
  state = openList(state);
  state = openComposeEdit(state, 0);
  assert.equal(state.compose?.editingId, comment!.id);
  state = { ...state, compose: { ...state.compose!, buffer: 'edited note' } };
  state = commitCompose(state);
  assert.equal(state.mode, 'list', 'editing from the list returns to the list');
  assert.equal(state.comments[0]!.comment, 'edited note');
  assert.equal(state.comments[0]!.line, 2, 'editing preserves the original anchor');

  state = closeList(state);
  assert.equal(state.mode, 'view');

  // Undo and delete both remove comments.
  state = undoLast(state);
  assert.equal(state.comments.length, 0);
}

// List navigation and delete-by-index.
{
  let state = initReviewState(sourceLines, [], 0);
  state = openComposeNew(state);
  state = { ...state, compose: { ...state.compose!, buffer: 'first' } };
  state = commitCompose(state);
  state = moveActiveLine(state, 1, false);
  state = openComposeNew(state);
  state = { ...state, compose: { ...state.compose!, buffer: 'second' } };
  state = commitCompose(state);
  assert.equal(state.comments.length, 2);
  state = openList(state);
  state = moveListIndex(state, 1);
  assert.equal(state.listIndex, 1);
  state = deleteAtListIndex(state);
  assert.equal(state.comments.length, 1);
  assert.equal(state.comments[0]!.comment, 'first');
  assert.equal(state.listIndex, 0);
}

// Scroll clamps to [0, totalLines - bodyHeight] and never goes negative.
{
  let state = initReviewState(sourceLines, [], 0);
  state = scrollBy(state, -50, 10, 30);
  assert.equal(state.scroll, 0, 'scroll cannot go negative');
  state = scrollBy(state, 50, 10, 30);
  assert.equal(state.scroll, 20, 'scroll clamps to the maximum');
  state = scrollBy(state, 50, 10, 30);
  assert.equal(state.scroll, 20, 'scroll stays clamped on repeated overshoot');
}

// Multi-line text-buffer helpers used by the compose input.
{
  let r = textInsert('', 0, 'hello');
  assert.deepEqual(r, { buffer: 'hello', cursor: 5 });
  r = textInsert(r.buffer, 5, '\nworld');
  assert.deepEqual(r, { buffer: 'hello\nworld', cursor: 11 });
  assert.equal(textHome(r.buffer, 11), 6, 'home jumps to the start of the current line');
  assert.equal(textEnd(r.buffer, 6), 11, 'end jumps to the end of the current line');
  assert.equal(textVertical(r.buffer, 8, -1), 2, 'up preserves the column on the previous line');
  r = textBackspace(r.buffer, 11);
  assert.deepEqual(r, { buffer: 'hello\nworl', cursor: 10 });
}

// Render frame: a comment count in the header and the anchor label in the footer.
{
  let state = initReviewState(sourceLines, [], 0);
  state = moveActiveLine(state, 2, false);
  const frame = renderReviewFrame(state, 'doc.md', ['rendered line one', 'rendered line two'], 60, 20);
  assert.equal(frame.length, 20, 'the frame always fills the requested row count');
  const joined = frame.join('\n');
  assert.match(joined, /Review — doc\.md/);
  assert.match(joined, /0 comments/);
  assert.match(joined, /L3\b/, 'the footer shows the current anchor line');
}

console.log('terminal review tests passed');
