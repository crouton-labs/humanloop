import assert from 'node:assert/strict';
import type { RenderedDoc } from '../render/termrender.js';
import {
  anchorRowRange,
  closeList,
  commentedUnitSet,
  commitCompose,
  currentAnchor,
  deleteAtListIndex,
  deriveAnchorUnits,
  ensureAnchorVisible,
  initReviewState,
  moveActiveUnit,
  moveListIndex,
  openComposeEdit,
  openComposeNew,
  openList,
  remapUnitIndex,
  renderReviewFrame,
  scrollBy,
  scrollToReveal,
  textBackspace,
  textEnd,
  textHome,
  textInsert,
  textVertical,
  undoLast,
  unitIndexForLine,
  unitRangeForSpan,
} from '../editor/terminal-review.js';

// A small doc: a heading, a two-bullet list, a paragraph. The list is ONE
// top-level block but each bullet carries its own leaf span — so anchoring
// steps bullet-to-bullet, not list-to-list.
const sourceLines = ['# Title', '', '- line three', '- line four', '', 'line six'];
const doc: RenderedDoc = {
  lines: ['TITLE', '', '• row three', '• row four', '', 'row six'],
  rows: [0, null, 1, 1, null, 2],
  spans: [[1, 1], null, [3, 3], [4, 4], null, [6, 6]],
  blocks: [
    { start: 1, end: 1 },
    { start: 3, end: 4 },
    { start: 6, end: 6 },
  ],
};
const anchor = deriveAnchorUnits(doc);
const { units } = anchor;

// deriveAnchorUnits: one unit per leaf span run; rowUnits keys the painter.
{
  assert.equal(units.length, 4, 'each bullet is its own unit — the list block splits');
  assert.deepEqual(units[0], { start: 1, end: 1, firstRow: 0, lastRow: 0 });
  assert.deepEqual(units[1], { start: 3, end: 3, firstRow: 2, lastRow: 2 });
  assert.deepEqual(units[2], { start: 4, end: 4, firstRow: 3, lastRow: 3 });
  assert.deepEqual(units[3], { start: 6, end: 6, firstRow: 5, lastRow: 5 });
  assert.deepEqual(anchor.rowUnits, [0, null, 1, 2, null, 3]);
}

// deriveAnchorUnits: consecutive rows sharing a span (a wrapped bullet)
// collapse into one unit; a mapped row with no leaf span (an unmapped block)
// anchors at its whole block's range; a separator between identical spans
// still splits units.
{
  const d: RenderedDoc = {
    lines: ['a1', 'a2 (wrapped)', '', 'chrome'],
    rows: [0, 0, null, 1],
    spans: [[2, 2], [2, 2], null, null],
    blocks: [
      { start: 1, end: 3 },
      { start: 5, end: 9 },
    ],
  };
  const a = deriveAnchorUnits(d);
  assert.deepEqual(a.units, [
    { start: 2, end: 2, firstRow: 0, lastRow: 1 },
    { start: 5, end: 9, firstRow: 3, lastRow: 3 },
  ]);
  assert.deepEqual(a.rowUnits, [0, 0, null, 1]);
}

// deriveAnchorUnits: a fully unmapped doc degrades to one whole-doc unit.
{
  const d: RenderedDoc = { lines: ['x', 'y'], rows: [null, null], spans: [null, null], blocks: [{ start: 1, end: 7 }] };
  const a = deriveAnchorUnits(d);
  assert.deepEqual(a.units, [{ start: 1, end: 7, firstRow: 0, lastRow: 1 }]);
  assert.deepEqual(a.rowUnits, [0, 0]);
}

// unitIndexForLine: containment, forward snap across gaps, clamp past the end.
{
  assert.equal(unitIndexForLine(units, 1), 0);
  assert.equal(unitIndexForLine(units, 2), 1, 'a gap line snaps forward to the next unit');
  assert.equal(unitIndexForLine(units, 3), 1);
  assert.equal(unitIndexForLine(units, 4), 2);
  assert.equal(unitIndexForLine(units, 6), 3);
  assert.equal(unitIndexForLine(units, 99), 3, 'past the last unit clamps to the last unit');
}

// unitRangeForSpan: all units overlapping a source range (chrome units carry
// their block's whole range, so a whole-fence comment covers every fence unit).
{
  assert.deepEqual(unitRangeForSpan(units, 3, 4), { lo: 1, hi: 2 }, 'a two-bullet comment spans both bullet units');
  assert.deepEqual(unitRangeForSpan(units, 6, 6), { lo: 3, hi: 3 });
  assert.deepEqual(unitRangeForSpan(units, 2, 2), { lo: 1, hi: 1 }, 'a gap-only range snaps forward');
  const fence = deriveAnchorUnits({
    lines: ['┌─', 'code a', 'code b', '└─'],
    rows: [0, 0, 0, 0],
    spans: [[5, 10], [6, 6], [7, 7], [5, 10]],
    blocks: [{ start: 5, end: 10 }],
  });
  assert.equal(fence.units.length, 4, 'fence = top chrome + per-line content + bottom chrome');
  assert.deepEqual(unitRangeForSpan(fence.units, 5, 10), { lo: 0, hi: 3 }, 'a whole-fence comment highlights every fence unit');

  // Narrowest-containing lookup: a code line resolves to its own unit even
  // though the whole-block chrome unit sits earlier in rendered order.
  assert.equal(unitIndexForLine(fence.units, 6), 1, 'a code line resolves to its leaf unit, not the fence chrome');
  assert.equal(unitIndexForLine(fence.units, 7), 2);
  assert.equal(unitIndexForLine(fence.units, 5), 0, 'the fence opener resolves to the chrome unit');

  // Resize remapping: an exact source-range match is preserved (chrome and
  // leaf units share source lines), else the narrowest containing unit wins.
  assert.equal(remapUnitIndex(fence.units, { start: 6, end: 6, firstRow: 9, lastRow: 9 }), 1, 'remap keeps a code-line anchor on its code line');
  assert.equal(remapUnitIndex(fence.units, { start: 5, end: 10, firstRow: 9, lastRow: 9 }), 0, 'remap keeps a chrome anchor on the identical-range unit');
  assert.equal(remapUnitIndex(fence.units, { start: 8, end: 9, firstRow: 0, lastRow: 0 }), 0, 'no exact match falls back to the best unit for its first line');
}

// Anchor motion: j/k move unit-to-unit; Shift+j/k extends across units.
{
  let state = initReviewState(sourceLines, anchor, [], 0);
  assert.deepEqual(currentAnchor(state), { line: 1, endLine: 1 });
  state = moveActiveUnit(state, 1, false);
  assert.deepEqual(currentAnchor(state), { line: 3, endLine: 3 }, 'j moves to a single bullet, not the whole list');
  state = moveActiveUnit(state, 1, true);
  assert.deepEqual(currentAnchor(state), { line: 3, endLine: 4 }, 'shift+j extends the selection downward');
  state = moveActiveUnit(state, 1, true);
  assert.deepEqual(currentAnchor(state), { line: 3, endLine: 6 }, 'shift+j extends across the block boundary');
  state = moveActiveUnit(state, -3, true);
  assert.deepEqual(currentAnchor(state), { line: 1, endLine: 3 }, 'shift+k can extend the selection back past the anchor');
  state = moveActiveUnit(state, 1, false);
  assert.deepEqual(currentAnchor(state), { line: 3, endLine: 3 }, 'a plain j/k collapses the selection');
  // Bounds
  state = moveActiveUnit(state, -100, false);
  assert.equal(state.activeUnit, 0, 'anchor cannot move above the first unit');
  state = moveActiveUnit(state, 100, false);
  assert.equal(state.activeUnit, units.length - 1, 'anchor cannot move past the last unit');
}

// currentAnchor over chrome units takes the min/max across the selection.
{
  const fence = deriveAnchorUnits({
    lines: ['┌─', 'code a', '└─'],
    rows: [0, 0, 0],
    spans: [[5, 8], [6, 6], [5, 8]],
    blocks: [{ start: 5, end: 8 }],
  });
  let state = initReviewState(['', '', '', '', '```', 'a', 'b', '```'], fence, [], 0);
  state = moveActiveUnit(state, 1, false); // content line unit
  assert.deepEqual(currentAnchor(state), { line: 6, endLine: 6 });
  state = moveActiveUnit(state, 1, true); // extend onto bottom chrome (5-8)
  assert.deepEqual(currentAnchor(state), { line: 5, endLine: 8 }, 'chrome in the selection widens to the block range');
}

// A draft comment positions the initial anchor on its unit.
{
  const comment = { id: 'c1', line: 6, endLine: 6, lineText: 'line six', comment: 'note', createdAt: 'now' };
  const state = initReviewState(sourceLines, anchor, [comment], 0);
  assert.equal(state.activeUnit, 3);
}

// Compose: commit builds a comment anchored to the selected units' source range.
{
  let state = initReviewState(sourceLines, anchor, [], 0);
  state = moveActiveUnit(state, 1, false); // bullet unit → L3
  state = moveActiveUnit(state, 1, true); // extend → L3-4
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
  assert.equal(comment!.lineText, '- line three\n- line four');
  assert.equal(comment!.comment, 'needs a rewrite');
  assert.equal(comment!.createdAt, '2024-01-01T00:00:00.000Z');

  // Empty compose cancels rather than adding a blank comment.
  state = openComposeNew(state);
  state = commitCompose(state);
  assert.equal(state.comments.length, 1, 'an empty buffer commit is a no-op cancel');
  assert.equal(state.mode, 'view');

  // Editing from the list updates the comment in place, returns to list mode,
  // and moves the visible anchor onto the comment's units.
  state = moveActiveUnit(state, -100, false); // move anchor away first
  state = openList(state);
  state = openComposeEdit(state, 0);
  assert.equal(state.compose?.editingId, comment!.id);
  assert.equal(state.activeUnit, 2, 'editing re-anchors onto the comment\'s last unit');
  assert.equal(state.selectionAnchor, 1, 'the comment\'s full unit range is selected');
  state = { ...state, compose: { ...state.compose!, buffer: 'edited note' } };
  state = commitCompose(state);
  assert.equal(state.mode, 'list', 'editing from the list returns to the list');
  assert.equal(state.comments[0]!.comment, 'edited note');
  assert.equal(state.comments[0]!.line, 3, 'editing preserves the original anchor');

  // The commented unit set marks every unit overlapped by the comment.
  assert.deepEqual([...commentedUnitSet(state)], [1, 2]);

  state = closeList(state);
  assert.equal(state.mode, 'view');

  // Undo and delete both remove comments.
  state = undoLast(state);
  assert.equal(state.comments.length, 0);
}

// List navigation and delete-by-index.
{
  let state = initReviewState(sourceLines, anchor, [], 0);
  state = openComposeNew(state);
  state = { ...state, compose: { ...state.compose!, buffer: 'first' } };
  state = commitCompose(state);
  state = moveActiveUnit(state, 1, false);
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

// anchorRowRange: the rendered rows spanned by a unit range.
{
  assert.deepEqual(anchorRowRange(units, 1, 2), { first: 2, last: 3 });
  assert.deepEqual(anchorRowRange(units, 0, 3), { first: 0, last: 5 });
  assert.equal(anchorRowRange(units, 9, 9), null);
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

// ensureAnchorVisible follows the active unit's rendered rows.
{
  let state = initReviewState(sourceLines, anchor, [], 0);
  state = { ...state, activeUnit: 3, scroll: 0 };
  state = ensureAnchorVisible(state, doc, 2);
  assert.equal(state.scroll, 4, 'the anchored unit\'s rows scroll into view');
}

// Scroll clamps to [0, totalLines - bodyHeight] and never goes negative.
{
  let state = initReviewState(sourceLines, anchor, [], 0);
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

// Render frame: the anchor highlight (gutter bar + tint) covers exactly the
// active unit's rows — one bullet, not the whole list — plus commented-unit
// markers and a key-hints-only footer.
{
  let state = initReviewState(sourceLines, anchor, [], 0);
  state = moveActiveUnit(state, 1, false); // first bullet (rendered row 2)
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
  assert.ok(bodyRow2.includes('▌') && bodyRow2.includes('\x1b[48;5;236m'), 'the anchored bullet row gets the gutter bar and tint');
  assert.ok(!bodyRow3.includes('▌'), 'the sibling bullet in the same list block is NOT highlighted');
  assert.ok(!bodyRow0.includes('▌'), 'non-anchored rows carry no anchor gutter');

  // A comment on the paragraph marks its rows with the commented gutter.
  state = {
    ...state,
    comments: [{ id: 'c1', line: 6, endLine: 6, lineText: 'line six', comment: 'note', createdAt: 'now' }],
  };
  const frame2 = renderReviewFrame(state, 'doc.md', doc, 60, 20);
  assert.ok(frame2[3 + 5]!.includes('▎'), 'commented units get the comment gutter marker');
  assert.ok(!frame2[3 + 3]!.includes('▎'), 'uncommented sibling units carry no comment marker');
}

console.log('terminal review tests passed');
