import assert from 'node:assert/strict';
import {
  deriveAnchorUnits,
  unitIndexForLine,
  remapUnitIndex,
  unitRangeForSpan,
  unitBoundsForRange,
  type AnchorUnit,
} from '../lib/anchorUnits.ts';

// deriveAnchorUnits mirrors the terminal's leaf granularity, derived from the
// SOURCE markdown AST (the browser has no termrender spans).

// ── A single bullet is its own unit; siblings split ─────────────────────────
{
  const md = '- alpha\n- bravo\n- charlie\n';
  const units = deriveAnchorUnits(md);
  assert.deepEqual(units, [{ start: 1, end: 1 }, { start: 2, end: 2 }, { start: 3, end: 3 }], 'three bullets → three units');
}

// ── Nested list items get their own units; a parent's text spans only its own line ─
{
  const md = '- parent\n  - child one\n  - child two\n- sibling\n';
  const units = deriveAnchorUnits(md);
  // parent text (line 1), child one (2), child two (3), sibling (4).
  assert.deepEqual(units, [
    { start: 1, end: 1 },
    { start: 2, end: 2 },
    { start: 3, end: 3 },
    { start: 4, end: 4 },
  ], 'parent text is trimmed above its nested list; nested items are their own units');
}

// ── GFM table: one unit per source row (delimiter line has no unit) ─────────
{
  const md = '| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n';
  const units = deriveAnchorUnits(md);
  // header row (line 1), body rows (lines 3, 4). Line 2 (delimiter) has no unit.
  assert.deepEqual(units, [{ start: 1, end: 1 }, { start: 3, end: 3 }, { start: 4, end: 4 }], 'each table row is its own unit');
}

// ── Fenced code: each content line is its own unit (chrome/fences excluded) ──
{
  const md = '```js\nconst a = 1;\nconst b = 2;\n```\n';
  const units = deriveAnchorUnits(md);
  // fence line 1, content lines 2 & 3, closing fence line 4.
  assert.deepEqual(units, [{ start: 2, end: 2 }, { start: 3, end: 3 }], 'each code content line is its own unit, fences excluded');
}

// ── A fence whose only content line is blank still anchors that content line ──
{
  // remark gives both an empty fence and a blank-only fence `value === ''`;
  // the unit must be the real (blank) content line, NOT the whole fence — a
  // whole-fence unit would record a comment against the ``` lines.
  assert.deepEqual(deriveAnchorUnits('```js\n\n```\n'), [{ start: 2, end: 2 }], 'a blank-only fence anchors its content line (line 2), not the fences');
  // A genuinely contentless fence (```lang immediately followed by ```) has no
  // content line — fall back to the whole block.
  assert.deepEqual(deriveAnchorUnits('```js\n```\n'), [{ start: 1, end: 2 }], 'a contentless fence falls back to the whole block');
}

// ── A parent list item with text AFTER its nested list does not swallow it ───
{
  const md = '- parent\n  - child\n\n  next parent paragraph\n- sibling\n';
  const units = deriveAnchorUnits(md);
  // parent's own text splits at the nested list: line 1 before, line 4 after;
  // the nested child (line 2) is its own unit; sibling is line 5. NO unit spans
  // the nested child's line.
  assert.deepEqual(units, [
    { start: 1, end: 1 },
    { start: 2, end: 2 },
    { start: 4, end: 4 },
    { start: 5, end: 5 },
  ], 'a parent unit never spans its nested children');
}

// ── Mermaid fence is ONE whole-block unit (SVG has no per-line text) ─────────
{
  const md = '```mermaid\nflowchart LR\n  A --> B\n  B --> C\n```\n';
  const units = deriveAnchorUnits(md);
  assert.deepEqual(units, [{ start: 1, end: 5 }], 'a whole mermaid diagram is a single unit spanning the fence');
}

// ── Paragraph / heading are whole-block units; soft breaks stay one unit ────
{
  const md = '# Title\n\nA paragraph\nwith a soft break.\n\nNext para.\n';
  const units = deriveAnchorUnits(md);
  assert.deepEqual(units, [
    { start: 1, end: 1 }, // heading
    { start: 3, end: 4 }, // paragraph across two soft-broken lines
    { start: 6, end: 6 }, // next paragraph
  ]);
}

// ── A mixed document keeps units ordered by source line ─────────────────────
{
  const md = [
    '# Heading',        // 1
    '',                 // 2
    'Intro paragraph.', // 3
    '',                 // 4
    '- one',            // 5
    '- two',            // 6
    '',                 // 7
    '```mermaid',       // 8
    'flowchart LR',     // 9
    '  A --> B',        // 10
    '```',              // 11
    '',                 // 12
    '| h1 | h2 |',      // 13
    '| -- | -- |',      // 14
    '| r1 | r2 |',      // 15
  ].join('\n') + '\n';
  const units = deriveAnchorUnits(md);
  assert.deepEqual(units, [
    { start: 1, end: 1 },   // heading
    { start: 3, end: 3 },   // intro paragraph
    { start: 5, end: 5 },   // bullet one
    { start: 6, end: 6 },   // bullet two
    { start: 8, end: 11 },  // whole mermaid diagram
    { start: 13, end: 13 }, // table header row
    { start: 15, end: 15 }, // table body row
  ]);
  // Units are strictly ordered by start line.
  for (let i = 1; i < units.length; i++) assert.ok(units[i]!.start >= units[i - 1]!.start, 'units are ordered');
}

// ── Degenerate document → one whole-doc unit ────────────────────────────────
{
  assert.deepEqual(deriveAnchorUnits(''), [{ start: 1, end: 1 }], 'empty document is one unit');
  assert.deepEqual(deriveAnchorUnits('\n\n\n'), [{ start: 1, end: 4 }], 'blank-only document is one whole-doc unit');
}

// ── unitIndexForLine: narrowest containing, snap-forward, clamp ─────────────
{
  const units: AnchorUnit[] = [{ start: 1, end: 1 }, { start: 3, end: 3 }, { start: 5, end: 5 }];
  assert.equal(unitIndexForLine(units, 1), 0);
  assert.equal(unitIndexForLine(units, 3), 1);
  assert.equal(unitIndexForLine(units, 2), 1, 'a line no unit contains snaps FORWARD to the next unit');
  assert.equal(unitIndexForLine(units, 9), 2, 'past the end clamps to the last unit');

  // Narrowest-containing wins when a wide unit overlaps a narrow one (a whole
  // block unit can share lines with a finer inner unit).
  const overlapping: AnchorUnit[] = [{ start: 1, end: 5 }, { start: 3, end: 3 }];
  assert.equal(unitIndexForLine(overlapping, 3), 1, 'the narrowest containing unit is chosen over the wide block');
}

// ── remapUnitIndex: exact range match, else narrowest for its start line ────
{
  const units: AnchorUnit[] = [{ start: 1, end: 1 }, { start: 3, end: 3 }, { start: 5, end: 5 }];
  assert.equal(remapUnitIndex(units, { start: 3, end: 3 }), 1, 'exact source-range match wins');
  assert.equal(remapUnitIndex(units, { start: 3, end: 9 }), 1, 'no exact match → best unit for the first line');
}

// ── unitRangeForSpan + unitBoundsForRange: comment range ↔ unit selection ────
{
  const units: AnchorUnit[] = [{ start: 1, end: 1 }, { start: 3, end: 3 }, { start: 5, end: 5 }];
  assert.deepEqual(unitRangeForSpan(units, 3, 5), { lo: 1, hi: 2 }, 'a range spanning units 1..2');
  assert.deepEqual(unitRangeForSpan(units, 2, 2), { lo: 1, hi: 1 }, 'a range touching no unit snaps');
  assert.deepEqual(unitBoundsForRange(units, 1, 2), { line: 3, endLine: 5 }, 'unit index range → source-line bounds');
  assert.deepEqual(unitBoundsForRange(units, 0, 0), { line: 1, endLine: 1 });
}

console.log('OK: browser anchor units (leaf granularity from the markdown AST)');
