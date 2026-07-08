import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  buildDraftFeedbackResult,
  buildFinalFeedbackResult,
  parseFeedbackComments,
  readStoredDraftFeedbackResult,
  sanitizeFeedbackComments,
  serializeFeedbackResult,
  writeDraftFeedbackResult,
  writeFinalFeedbackResult,
  writeSubmitFlag,
} from '../editor/feedback.js';

const dir = mkdtempSync(join(tmpdir(), 'hl-feedback-test-'));
try {
  const file = resolve(join(dir, 'source.md'));
  const output = join(dir, 'feedback.json');
  const rawComments = [
    {
      id: 'keep',
      line: 2,
      endLine: 3,
      quote: 'raw quote',
      colStart: 1,
      colEnd: 5,
      lineText: 'line two\nline three',
      comment: '  tighten this  ',
      createdAt: '2026-07-07T20:00:00.000Z',
    },
    { id: 'drop-empty', line: 4, comment: '   ' },
    { id: 'drop-cols', line: 5, endLine: 5, colStart: 8, colEnd: 8, lineText: 'line five', comment: 'bad cols' },
  ];

  const comments = sanitizeFeedbackComments(rawComments);
  assert.deepEqual(comments, [
    {
      id: 'keep',
      line: 2,
      endLine: 3,
      quote: 'raw quote',
      colStart: 1,
      colEnd: 5,
      lineText: 'line two\nline three',
      comment: 'tighten this',
      createdAt: '2026-07-07T20:00:00.000Z',
    },
    {
      id: 'drop-cols',
      line: 5,
      endLine: 5,
      colStart: undefined,
      colEnd: undefined,
      quote: undefined,
      lineText: 'line five',
      comment: 'bad cols',
      createdAt: comments[1]!.createdAt,
    },
  ]);

  const draft = buildDraftFeedbackResult(file, comments, '2026-07-07T20:01:00.000Z');
  assert.deepEqual(draft, {
    file,
    submitted: false,
    approved: false,
    comments,
    savedAt: '2026-07-07T20:01:00.000Z',
  });
  assert.equal(serializeFeedbackResult(draft).endsWith('\n'), true, 'feedback JSON must end with a trailing newline');
  writeDraftFeedbackResult(output, file, comments, '2026-07-07T20:01:00.000Z');
  assert.equal(readFileSync(output, 'utf8'), JSON.stringify(draft, null, 2) + '\n');
  assert.deepEqual(readStoredDraftFeedbackResult(output, file), draft);

  const final = buildFinalFeedbackResult(file, comments, '2026-07-07T20:02:00.000Z');
  assert.deepEqual(final, {
    file,
    submitted: true,
    approved: false,
    comments,
    submittedAt: '2026-07-07T20:02:00.000Z',
    savedAt: '2026-07-07T20:02:00.000Z',
  });
  writeFinalFeedbackResult(output, file, comments, '2026-07-07T20:02:00.000Z');
  assert.equal(readFileSync(output, 'utf8'), JSON.stringify(final, null, 2) + '\n');
  assert.equal(readStoredDraftFeedbackResult(output, file), null, 'submitted feedback is not reloadable as a draft');

  const approved = buildFinalFeedbackResult(file, [], '2026-07-07T20:03:00.000Z');
  assert.equal(approved.approved, true, 'zero-comment final feedback is approved');

  const submitFlag = join(dir, 'submit.flag');
  writeSubmitFlag(submitFlag);
  assert.equal(existsSync(submitFlag), true, 'submit sentinel must be written');

  console.log('OK: feedback helpers preserve draft/final JSON semantics');
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// ── parseFeedbackComments: the strict per-item validator for the browser-
// write API (PUT /api/review/draft, POST /api/review/submit). Distinct from
// sanitizeFeedbackComments (above), which stays the permissive path for
// loading legacy on-disk drafts and must keep tolerating malformed items by
// silently dropping/normalizing them. This validator instead rejects the
// whole payload with `{ok:false}` on any malformed item — no silent
// normalization at the write boundary.
{
  const fullComment = {
    id: 'c1',
    line: 2,
    endLine: 2,
    colStart: 1,
    colEnd: 5,
    quote: 'a quote',
    lineText: 'line two',
    comment: '  needs work  ',
    createdAt: '2026-07-07T20:00:00.000Z',
  };

  const validFull = parseFeedbackComments([fullComment]);
  assert.equal(validFull.ok, true, 'a valid full comment is accepted');
  if (validFull.ok) {
    assert.deepEqual(validFull.comments, [{
      id: 'c1',
      line: 2,
      endLine: 2,
      colStart: 1,
      colEnd: 5,
      quote: 'a quote',
      lineText: 'line two',
      comment: 'needs work',
      createdAt: '2026-07-07T20:00:00.000Z',
    }], 'the exact shape is preserved, including a trimmed comment');
  }

  const noCols = parseFeedbackComments([{ id: 'c2', line: 1, endLine: 1, lineText: 'l1', comment: 'ok', createdAt: '2026-07-07T20:00:00.000Z' }]);
  assert.equal(noCols.ok, true, 'a valid comment with no colStart/colEnd is accepted');
  if (noCols.ok) {
    assert.equal(noCols.comments[0]!.colStart, undefined);
    assert.equal(noCols.comments[0]!.colEnd, undefined);
  }

  assert.equal(parseFeedbackComments([{ ...fullComment, id: '' }]).ok, false, 'empty id is rejected');
  assert.equal(parseFeedbackComments([{ ...fullComment, id: undefined }]).ok, false, 'missing id is rejected');
  assert.equal(parseFeedbackComments([{ ...fullComment, comment: '   ' }]).ok, false, 'blank comment is rejected');
  assert.equal(parseFeedbackComments([{ ...fullComment, comment: undefined }]).ok, false, 'missing comment is rejected');
  assert.equal(parseFeedbackComments([{ ...fullComment, line: 'not-a-line' }]).ok, false, 'non-numeric line is rejected');
  assert.equal(parseFeedbackComments([{ ...fullComment, endLine: -5 }]).ok, false, 'negative endLine is rejected');
  assert.equal(parseFeedbackComments([{ ...fullComment, line: 5, endLine: 3 }]).ok, false, 'endLine < line is rejected');
  assert.equal(parseFeedbackComments([{ ...fullComment, lineText: 123 }]).ok, false, 'non-string lineText is rejected');
  assert.equal(parseFeedbackComments([{ ...fullComment, createdAt: null }]).ok, false, 'null createdAt is rejected');
  assert.equal(parseFeedbackComments([{ ...fullComment, colStart: 1, colEnd: undefined }]).ok, false, 'colStart without colEnd is rejected');
  assert.equal(parseFeedbackComments([{ ...fullComment, colStart: undefined, colEnd: 5 }]).ok, false, 'colEnd without colStart is rejected');
  assert.equal(
    parseFeedbackComments([{ ...fullComment, line: 2, endLine: 2, colStart: 5, colEnd: 5 }]).ok,
    false,
    'same-line colEnd <= colStart is rejected',
  );
  assert.equal(
    parseFeedbackComments([{ ...fullComment, line: 2, endLine: 2, colStart: 8, colEnd: 3 }]).ok,
    false,
    'same-line colEnd < colStart is rejected',
  );

  const multiLine = parseFeedbackComments([{
    id: 'c-multi', line: 1, endLine: 2, colStart: 8, colEnd: 3, lineText: 'l1\nl2', comment: 'spans lines', createdAt: '2026-07-07T20:00:00.000Z',
  }]);
  assert.equal(multiLine.ok, true, 'a multi-line range with colEnd <= colStart is legitimate and accepted');

  // A parser that only validates raw[0] and silently accepts/normalizes
  // everything after it would still pass every single-element case above.
  // This proves the whole-payload contract: ANY malformed item, wherever it
  // sits in the array, rejects the whole payload.
  const mixedArray = parseFeedbackComments([fullComment, { ...fullComment, id: 'c2', line: 'not-a-line' }]);
  assert.equal(mixedArray.ok, false, 'a later (non-first) malformed item still poisons the whole payload');

  // The literal reproduction of the validation finding's direct probe.
  const probe = parseFeedbackComments([{
    comment: 'bad anchor accepted', line: 'not-a-line', endLine: -5, lineText: 123, createdAt: null,
  }]);
  assert.equal(probe.ok, false, 'the malformed probe payload must be rejected, not silently normalized');

  console.log('OK: parseFeedbackComments strictly validates comment anchors');
}
