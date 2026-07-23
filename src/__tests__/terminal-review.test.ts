import assert from 'node:assert/strict';
import type { RenderedDoc } from '../render/termrender.js';
import {
  anchorRowRange,
  blockIndexForLine,
  closeList,
  commentedBlockSet,
  commitCompose,
  currentAnchor,
  deleteAtListIndex,
  ensureAnchorVisible,
  initReviewState,
  moveActiveBlock,
  moveListIndex,
  openComposeEdit,
  openComposeNew,
  openList,
  renderReviewFrame,
  scrollBy,
  scrollToReveal,
  textBackspace,
  textEnd,
  textHome,
  textInsert,
  textVertical,
  undoLast,
} from '../editor/terminal-review.js';

// A small doc: three top-level blocks with a blank source line between each.
const sourceLines = ['# Title', '', 'line three', 'line four', '', 'line six'];
const blocks = [
  { start: 1, end: 1 },
  { start: 3, end: 4 },
  { start: 6, end: 6 },
];
// Rendered shape: block 0 → 1 row, separator, block 1 → 2 rows, separator, block 2 → 1 row.
const doc: RenderedDoc = {
  lines: ['TITLE', '', 'row three', 'row four', '', 'row six'],
  rows: [0, null, 1, 1, null, 2],
  blocks,
};

// blockIndexForLine: containment, forward snap across gaps, clamp past the end.
{
  assert.equal(blockIndexForLine(blocks, 1), 0);
  assert.equal(blockIndexForLine(blocks, 2), 1, 'a gap line snaps forward to the next block');
  assert.equal(blockIndexForLine(blocks, 3), 1);
  assert.equal(blockIndexForLine(blocks, 4), 1);
  assert.equal(blockIndexForLine(blocks, 6), 2);
  assert.equal(blockIndexForLine(blocks, 99), 2, 'past the last block clamps to the last block');
}

// Anchor motion: j/k move block-to-block; Shift+j/k extends across blocks.
{
  let state = initReviewState(sourceLines, blocks, [], 0);
  assert.deepEqual(currentAnchor(state), { line: 1, endLine: 1 });
  state = moveActiveBlock(state, 1, false);
  assert.deepEqual(currentAnchor(state), { line: 3, endLine: 4 }, 'j moves to the next block\'s source range');
  state = moveActiveBlock(state, 1, true);
  assert.deepEqual(currentAnchor(state), { line: 3, endLine: 6 }, 'shift+j extends the selection downward');
  state = moveActiveBlock(state, -2, true);
  assert.deepEqual(currentAnchor(state), { line: 1, endLine: 4 }, 'shift+k can extend the selection back past the anchor');
  state = moveActiveBlock(state, 1, false);
  assert.deepEqual(currentAnchor(state), { line: 3, endLine: 4 }, 'a plain j/k collapses the selection');
  // Bounds
  state = moveActiveBlock(state, -100, false);
  assert.equal(state.activeBlock, 0, 'anchor cannot move above the first block');
  state = moveActiveBlock(state, 100, false);
  assert.equal(state.activeBlock, blocks.length - 1, 'anchor cannot move past the last block');
}

// A draft comment positions the initial anchor on its block.
{
  const comment = { id: 'c1', line: 6, endLine: 6, lineText: 'line six', comment: 'note', createdAt: 'now' };
  const state = initReviewState(sourceLines, blocks, [comment], 0);
  assert.equal(state.activeBlock, 2);
}

// Compose: commit builds a comment anchored to the selected blocks' source range.
{
  let state = initReviewState(sourceLines, blocks, [], 0);
  state = moveActiveBlock(state, 1, false); // block 1 → L3-4
  state = openComposeNew(state);
  assert.equal(state.mode, 'compose');
  assert.deepEqual(state.compose?.anchor, { line: 3, endLine: 4 });
  state = { ...state, compose: { ...state.compose!, buffer: 'needs a rewrite' } };
  state = commitCompose(state, '2024-01-01T00:00:00.000Z');
  assert.equal(state.mode, 'view');
  assert.equal(state.comments.length, 1);
  const [comment] = state.comments;
  assert.equal(comment!.line, 3);
  assert.equal(comment!.endLine, 4);
  assert.equal(comment!.lineText, 'line three\nline four');
  assert.equal(comment!.comment, 'needs a rewrite');
  assert.equal(comment!.createdAt, '2024-01-01T00:00:00.000Z');

  // Empty compose cancels rather than adding a blank comment.
  state = openComposeNew(state);
  state = commitCompose(state);
  assert.equal(state.comments.length, 1, 'an empty buffer commit is a no-op cancel');
  assert.equal(state.mode, 'view');

  // Editing from the list updates the comment in place, returns to list mode,
  // and moves the visible anchor onto the comment's blocks.
  state = moveActiveBlock(state, -1, false); // move anchor away first
  state = openList(state);
  state = openComposeEdit(state, 0);
  assert.equal(state.compose?.editingId, comment!.id);
  assert.equal(state.activeBlock, 1, 'editing re-anchors onto the comment\'s block');
  state = { ...state, compose: { ...state.compose!, buffer: 'edited note' } };
  state = commitCompose(state);
  assert.equal(state.mode, 'list', 'editing from the list returns to the list');
  assert.equal(state.comments[0]!.comment, 'edited note');
  assert.equal(state.comments[0]!.line, 3, 'editing preserves the original anchor');

  // The commented block set marks blocks overlapped by comments.
  assert.deepEqual([...commentedBlockSet(state)], [1]);

  state = closeList(state);
  assert.equal(state.mode, 'view');

  // Undo and delete both remove comments.
  state = undoLast(state);
  assert.equal(state.comments.length, 0);
}

// List navigation and delete-by-index.
{
  let state = initReviewState(sourceLines, blocks, [], 0);
  state = openComposeNew(state);
  state = { ...state, compose: { ...state.compose!, buffer: 'first' } };
  state = commitCompose(state);
  state = moveActiveBlock(state, 1, false);
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

// anchorRowRange: rendered rows produced by a block span; null when unmapped.
{
  assert.deepEqual(anchorRowRange(doc.rows, 1, 1), { first: 2, last: 3 });
  assert.deepEqual(anchorRowRange(doc.rows, 0, 2), { first: 0, last: 5 });
  assert.equal(anchorRowRange(doc.rows, 5, 5), null);
}

// scrollToReveal: margin-aware reveal, top pin for oversize spans, clamping.
{
  assert.equal(scrollToReveal(0, 10, 11, 8, 30, 2), 6, 'reveals a below-view anchor with a bottom margin');
  assert.equal(scrollToReveal(6, 1, 1, 8, 30, 2), 0, 'reveals an above-view anchor, clamped at the top');
  assert.equal(scrollToReveal(0, 4, 20, 8, 30), 3, 'a taller-than-view span pins its first row one below the indicator row');
  assert.equal(scrollToReveal(0, 0, 20, 8, 30), 0, 'an oversize span starting at the top pins at zero');
  assert.equal(scrollToReveal(3, 5, 6, 8, 30), 3, 'an already-visible anchor leaves the scroll untouched');
  assert.equal(scrollToReveal(50, 25, 25, 8, 30, 2), 22, 'a stale overshoot scroll is clamped into the document');
  // The margin yields before it may push the span's own edges out of view.
  assert.equal(scrollToReveal(0, 10, 16, 8, 30, 2), 10, 'down-reveal of a bodyHeight-1 span keeps its first row visible');
  assert.equal(scrollToReveal(20, 10, 16, 8, 30, 2), 9, 'up-reveal of a bodyHeight-1 span keeps its last row visible');
  assert.equal(scrollToReveal(0, 10, 10, 2, 30, 2), 10, 'a tiny viewport still shows the anchored row itself');
}

// ensureAnchorVisible follows the active block through the row map.
{
  let state = initReviewState(sourceLines, blocks, [], 0);
  state = { ...state, activeBlock: 2, scroll: 0 };
  state = ensureAnchorVisible(state, doc, 2);
  assert.equal(state.scroll, 4, 'the anchored block\'s rows scroll into view');
}

// Scroll clamps to [0, totalLines - bodyHeight] and never goes negative.
{
  let state = initReviewState(sourceLines, blocks, [], 0);
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

// Render frame: in-document anchor highlight (gutter bar + tint), commented
// block markers, key-hints-only footer.
{
  let state = initReviewState(sourceLines, blocks, [], 0);
  state = moveActiveBlock(state, 1, false); // anchor block 1 (rendered rows 2-3)
  const frame = renderReviewFrame(state, 'doc.md', doc, 60, 20);
  assert.equal(frame.length, 20, 'the frame always fills the requested row count');
  const joined = frame.join('\n');
  assert.match(joined, /Review — doc\.md/);
  assert.match(joined, /0 comments/);
  assert.ok(!joined.includes('Anchor:'), 'the view footer carries no anchor caption');
  // Header is 3 rows; body row i shows doc row scroll+i.
  const bodyRow2 = frame[3 + 2]!;
  const bodyRow3 = frame[3 + 3]!;
  const bodyRow0 = frame[3]!;
  assert.ok(bodyRow2.includes('▌') && bodyRow2.includes('\x1b[48;5;236m'), 'anchored rows get the gutter bar and tint');
  assert.ok(bodyRow3.includes('▌'), 'every row of the anchored block is marked');
  assert.ok(!bodyRow0.includes('▌'), 'non-anchored rows carry no anchor gutter');

  // A comment on block 2 marks its rows with the commented gutter.
  state = {
    ...state,
    comments: [{ id: 'c1', line: 6, endLine: 6, lineText: 'line six', comment: 'note', createdAt: 'now' }],
  };
  const frame2 = renderReviewFrame(state, 'doc.md', doc, 60, 20);
  assert.ok(frame2[3 + 5]!.includes('▎'), 'commented blocks get the comment gutter marker');
}

console.log('terminal review tests passed');
