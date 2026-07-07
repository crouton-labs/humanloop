import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  buildDraftFeedbackResult,
  buildFinalFeedbackResult,
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
