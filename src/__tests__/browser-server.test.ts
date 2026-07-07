import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { startReviewWebServer, startWebServer } from '../browser/server.js';
import type { Deck, FeedbackResult } from '../index.js';

// Regression tests for the phase 1 review's two Major findings at the
// /api/submit seam:
//   1. The HTTP submit ack must always reach the caller before any
//      onSubmit-triggered teardown (stop()/closeAllConnections()) can close
//      the socket it's still writing to.
//   2. /api/submit must be single-assignment: a second submit never
//      re-writes response.json or re-fires onSubmit; it gets a deterministic
//      409 with the canonical result instead.

const deck: Deck = {
  title: 'Regression deck',
  interactions: [
    { id: 'q1', title: 'Ship it?', options: [{ id: 'yes', label: 'Yes', shortcut: 'y' }] },
  ],
};

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hl-server-test-'));
  writeFileSync(join(dir, 'deck.json'), JSON.stringify(deck));
  return dir;
}

// ── Test 1: submit ack survives an onSubmit that stops the server ────────────
// Reproduces the reviewer's UND_ERR_SOCKET repro: the TUI's onSubmit calls
// finalize() -> h.stop() -> closeAllConnections(), which used to race the
// still-in-flight POST response.

{
  const dir = makeDir();
  let onSubmitFired = 0;

  const handle = await startWebServer({
    dir,
    deck,
    onSubmit: () => {
      onSubmitFired++;
      // Mimic the TUI's finalize(): tear the server down synchronously from
      // inside the callback.
      void handle.stop();
    },
  });

  const res = await fetch(`${handle.url}api/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ responses: [{ id: 'q1', selectedOptionId: 'yes' }] }),
  });

  assert.equal(res.status, 200, 'submit must still return 200 even though onSubmit stops the server');
  const body = await res.json() as { ok: boolean; responsePath: string; completedAt: string };
  assert.equal(body.ok, true, 'submit response body must report ok: true');
  assert.equal(typeof body.responsePath, 'string', 'submit response must include responsePath');
  assert.equal(typeof body.completedAt, 'string', 'submit response must include completedAt');
  assert.equal(onSubmitFired, 1, 'onSubmit must fire exactly once');

  const written = JSON.parse(readFileSync(join(dir, 'response.json'), 'utf8')) as { responses: unknown };
  assert.deepEqual(written.responses, [{ id: 'q1', selectedOptionId: 'yes' }], 'response.json must hold the submitted responses');

  rmSync(dir, { recursive: true, force: true });
  console.log('OK: submit ack survives onSubmit-triggered teardown');
}

// ── Test 2: submit is single-assignment; a second submit 409s ────────────────

{
  const dir = makeDir();
  let onSubmitFired = 0;
  let onSubmitResponses: unknown = null;

  const handle = await startWebServer({
    dir,
    deck,
    onSubmit: (responses) => {
      onSubmitFired++;
      onSubmitResponses = responses;
    },
  });

  const first = await fetch(`${handle.url}api/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ responses: [{ id: 'q1', selectedOptionId: 'yes' }] }),
  });
  assert.equal(first.status, 200, 'first submit must succeed with 200');
  const firstBody = await first.json() as { ok: boolean; responsePath: string; completedAt: string };
  assert.equal(firstBody.ok, true);

  const second = await fetch(`${handle.url}api/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // Deliberately a different (stale/racing) payload — it must never win.
    body: JSON.stringify({ responses: [{ id: 'q1', freetext: 'a second, stale submit' }] }),
  });
  assert.equal(second.status, 409, 'a second submit must be rejected with 409');
  const secondBody = await second.json() as { ok: boolean; error: string; responsePath: string; completedAt: string };
  assert.equal(secondBody.ok, false, 'second submit response must report ok: false');
  assert.equal(secondBody.error, 'already_submitted', 'second submit must report the already_submitted error code');
  assert.equal(secondBody.responsePath, firstBody.responsePath, 'second submit must echo the first submit\'s canonical responsePath');
  assert.equal(secondBody.completedAt, firstBody.completedAt, 'second submit must echo the first submit\'s canonical completedAt');

  assert.equal(onSubmitFired, 1, 'onSubmit must fire exactly once across both submits');
  assert.deepEqual(onSubmitResponses, [{ id: 'q1', selectedOptionId: 'yes' }], 'onSubmit must have been called with the FIRST submit\'s responses');

  const written = JSON.parse(readFileSync(join(dir, 'response.json'), 'utf8')) as { responses: unknown };
  assert.deepEqual(
    written.responses,
    [{ id: 'q1', selectedOptionId: 'yes' }],
    'response.json must reflect exactly the first (canonical) submit, never the stale second one',
  );

  await handle.stop();
  rmSync(dir, { recursive: true, force: true });
  console.log('OK: submit is single-assignment; a second submit 409s with the canonical result');
}

// ── Test 3: baseline contract still holds (GET, static 404, clean stop) ───────

{
  const dir = makeDir();
  const handle = await startWebServer({ dir, deck });

  const surface = await fetch(`${handle.url}api/surface`);
  assert.equal(surface.status, 200);
  assert.deepEqual(await surface.json(), { kind: 'deck' });

  const got = await fetch(`${handle.url}api/interaction`);
  assert.equal(got.status, 200);
  const gotBody = await got.json() as { dir: string; deck: Deck };
  assert.equal(gotBody.dir, dir);
  assert.deepEqual(gotBody.deck, deck);

  const wrongReview = await fetch(`${handle.url}api/review`);
  assert.equal(wrongReview.status, 404);
  assert.deepEqual(await wrongReview.json(), { error: 'wrong_surface', expected: 'deck' });

  await handle.stop();
  assert.equal(existsSync(join(dir, 'response.json')), false, 'read-only deck GET/stop path must not write response.json');
  assert.equal(existsSync(join(dir, 'progress.json')), false, 'browser deck server must not write progress.json during GET/stop');
  rmSync(dir, { recursive: true, force: true });
  console.log('OK: baseline GET/stop contract unchanged');
}

function wsEndpoint(url: string): string {
  return url.replace(/^http:/, 'ws:') + 'ws';
}

function openWs(url: string): Promise<WebSocket> {
  return new Promise((resolveOpen, rejectOpen) => {
    const ws = new WebSocket(wsEndpoint(url));
    ws.once('open', () => resolveOpen(ws));
    ws.once('error', rejectOpen);
  });
}

function nextWsJson(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolveMessage, rejectMessage) => {
    ws.once('message', (data) => {
      try {
        resolveMessage(JSON.parse(data.toString()) as Record<string, unknown>);
      } catch (err) {
        rejectMessage(err);
      }
    });
    ws.once('error', rejectMessage);
  });
}

// ── Test 4: review endpoints own draft/version/submit semantics ─────────────

{
  const dir = mkdtempSync(join(tmpdir(), 'hl-review-server-test-'));
  const file = resolve(join(dir, 'source.md'));
  const output = join(dir, 'feedback.json');
  const submitFlag = join(dir, 'submitted.flag');
  writeFileSync(file, '# Source\n\nbody\n');
  let onSubmitFired = 0;
  let submittedResult: FeedbackResult | null = null;

  const handle = await startReviewWebServer({
    jobDir: dir,
    file,
    output,
    submitFlagPath: submitFlag,
    onSubmit: (result) => {
      onSubmitFired++;
      submittedResult = result;
      void handle.stop();
    },
  });
  writeFileSync(output, JSON.stringify({
    file,
    submitted: false,
    approved: false,
    comments: [{ id: 'nvim-draft', line: 1, endLine: 1, lineText: '# Source', comment: 'from nvim', createdAt: '2026-07-07T20:00:00.000Z' }],
    savedAt: '2026-07-07T20:00:01.000Z',
  }, null, 2) + '\n');
  const ws = await openWs(handle.url);

  const surface = await fetch(`${handle.url}api/surface`);
  assert.equal(surface.status, 200);
  assert.deepEqual(await surface.json(), { kind: 'review' });

  const wrongDeck = await fetch(`${handle.url}api/interaction`);
  assert.equal(wrongDeck.status, 404);
  assert.deepEqual(await wrongDeck.json(), { error: 'wrong_surface', expected: 'review' });

  const initial = await fetch(`${handle.url}api/review`);
  assert.equal(initial.status, 200);
  const initialBody = await initial.json() as { content: string; file: string; output: string; version: number; result: FeedbackResult };
  assert.equal(initialBody.file, file);
  assert.equal(initialBody.output, output);
  assert.equal(initialBody.content, '# Source\n\nbody\n');
  assert.equal(initialBody.version, 1, 'importing a draft written after server start must advance the version token');
  assert.equal(initialBody.result.submitted, false);
  assert.equal(initialBody.result.comments.length, 1, 'GET /api/review must pick up the draft nvim saved after server start');
  assert.equal(initialBody.result.comments[0]!.id, 'nvim-draft');

  const badJson = await fetch(`${handle.url}api/review/draft`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: '{',
  });
  assert.equal(badJson.status, 400);
  assert.equal(((await badJson.json()) as { error: string }).error, 'bad_json');

  const badInput = await fetch(`${handle.url}api/review/draft`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ comments: 'nope', baseVersion: 1 }),
  });
  assert.equal(badInput.status, 400);
  assert.equal(((await badInput.json()) as { error: string }).error, 'bad_input');

  const draftSignal = nextWsJson(ws);
  const draft = await fetch(`${handle.url}api/review/draft`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      baseVersion: 1,
      comments: [
        { id: 'c1', line: 3, endLine: 3, lineText: 'body', comment: '  needs work  ', createdAt: '2026-07-07T20:00:00.000Z' },
        { id: 'empty', line: 1, comment: '   ' },
      ],
    }),
  });
  assert.equal(draft.status, 200);
  const draftBody = await draft.json() as { ok: boolean; version: number; result: FeedbackResult };
  assert.equal(draftBody.ok, true);
  assert.equal(draftBody.version, 2);
  assert.equal(draftBody.result.submitted, false);
  assert.equal(draftBody.result.approved, false);
  assert.equal(draftBody.result.comments.length, 1);
  assert.equal(draftBody.result.comments[0]!.comment, 'needs work');
  assert.equal(readFileSync(output, 'utf8').endsWith('\n'), true, 'draft output must include trailing newline');
  const draftMessage = await draftSignal;
  assert.equal(draftMessage.type, 'review-draft-updated');
  assert.equal(draftMessage.version, 2);

  const staleDraft = await fetch(`${handle.url}api/review/draft`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ comments: [], baseVersion: 1 }),
  });
  assert.equal(staleDraft.status, 409);
  assert.equal(((await staleDraft.json()) as { error: string }).error, 'stale_draft');

  const convergedSignal = nextWsJson(ws);
  const submit = await fetch(`${handle.url}api/review/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ comments: [], baseVersion: 2 }),
  });
  assert.equal(submit.status, 200, 'review submit ack must survive onSubmit-triggered teardown');
  const submitBody = await submit.json() as { ok: boolean; output: string; submittedAt: string; result: FeedbackResult };
  assert.equal(submitBody.ok, true);
  assert.equal(submitBody.output, output);
  assert.equal(submitBody.result.submitted, true);
  assert.equal(submitBody.result.approved, true);
  assert.equal(submitBody.result.submittedAt, submitBody.submittedAt);
  assert.equal(submitBody.result.savedAt, submitBody.submittedAt);
  assert.equal(existsSync(submitFlag), true, 'review browser submit must write the submit sentinel');
  assert.equal(readFileSync(output, 'utf8'), JSON.stringify(submitBody.result, null, 2) + '\n');
  const convergedMessage = await convergedSignal;
  assert.equal(convergedMessage.type, 'converged');
  assert.equal(onSubmitFired, 1);
  assert.deepEqual(submittedResult, submitBody.result);

  ws.close();
  rmSync(dir, { recursive: true, force: true });
  console.log('OK: review endpoints write drafts, reject stale edits, submit with ack ordering, and broadcast signals');
}

// ── Test 5: review submit is single-assignment and source 404s ───────────────

{
  const dir = mkdtempSync(join(tmpdir(), 'hl-review-server-test-'));
  const file = resolve(join(dir, 'source.md'));
  const output = join(dir, 'feedback.json');
  writeFileSync(file, 'body\n');
  let onSubmitFired = 0;

  const handle = await startReviewWebServer({
    jobDir: dir,
    file,
    output,
    onSubmit: () => {
      onSubmitFired++;
    },
  });

  const first = await fetch(`${handle.url}api/review/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ comments: [{ id: 'c1', line: 1, endLine: 1, lineText: 'body', comment: 'first', createdAt: '2026-07-07T20:00:00.000Z' }], baseVersion: 0 }),
  });
  assert.equal(first.status, 200);
  const firstBody = await first.json() as { output: string; submittedAt: string; result: FeedbackResult };

  const second = await fetch(`${handle.url}api/review/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ comments: [], baseVersion: 0 }),
  });
  assert.equal(second.status, 409);
  const secondBody = await second.json() as { ok: boolean; error: string; output: string; submittedAt: string; result: FeedbackResult };
  assert.equal(secondBody.ok, false);
  assert.equal(secondBody.error, 'already_submitted');
  assert.equal(secondBody.output, firstBody.output);
  assert.equal(secondBody.submittedAt, firstBody.submittedAt);
  assert.deepEqual(secondBody.result, firstBody.result);
  assert.equal(onSubmitFired, 1, 'review onSubmit must fire once for the first accepted submit');

  await handle.stop();
  rmSync(file, { force: true });
  const missingHandle = await startReviewWebServer({ jobDir: dir, file, output });
  const missing = await fetch(`${missingHandle.url}api/review`);
  assert.equal(missing.status, 404);
  assert.equal(((await missing.json()) as { error: string }).error, 'source_not_found');
  await missingHandle.stop();
  rmSync(dir, { recursive: true, force: true });
  console.log('OK: review submit is single-assignment and missing source returns source_not_found');
}

// ── Test 6: multi-line comment columns survive the server persistence path ──
// Regression for MAJOR 3 (server side): sanitizeFeedbackComments used to gate
// colStart/colEnd on `colEnd > colStart`, which is only meaningful WITHIN a
// single line. For a genuine multi-line range (endLine > line), colEnd is
// relative to a DIFFERENT line than colStart, so a valid range like
// {line:1, endLine:2, colStart:4, colEnd:1} was silently downgraded to
// line-only columns (both undefined) on draft save AND on submit. This drives
// the REAL server persistence boundary (PUT /api/review/draft and
// POST /api/review/submit), not just the web-side unit helper.

{
  const dir = mkdtempSync(join(tmpdir(), 'hl-review-server-test-'));
  const file = resolve(join(dir, 'source.md'));
  const output = join(dir, 'feedback.json');
  writeFileSync(file, 'first line\nsecond line\n');

  const multiLineComment = {
    id: 'c-multiline',
    line: 1,
    endLine: 2,
    colStart: 4,
    colEnd: 1,
    quote: 'line\ns',
    lineText: 'first line\nsecond line',
    comment: 'spans two lines',
    createdAt: '2026-07-07T20:00:00.000Z',
  };

  const handle = await startReviewWebServer({ jobDir: dir, file, output });

  const draft = await fetch(`${handle.url}api/review/draft`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseVersion: 0, comments: [multiLineComment] }),
  });
  assert.equal(draft.status, 200);
  const draftBody = await draft.json() as { ok: boolean; version: number; result: FeedbackResult };
  assert.equal(draftBody.ok, true);
  assert.equal(draftBody.result.comments.length, 1);
  assert.equal(draftBody.result.comments[0]!.colStart, 4, 'PUT /api/review/draft must preserve a valid multi-line colStart');
  assert.equal(draftBody.result.comments[0]!.colEnd, 1, 'PUT /api/review/draft must preserve a valid multi-line colEnd');

  const onDiskDraft = JSON.parse(readFileSync(output, 'utf8')) as { comments: FeedbackResult['comments'] };
  assert.equal(onDiskDraft.comments[0]!.colStart, 4, 'the persisted draft file must keep the multi-line colStart');
  assert.equal(onDiskDraft.comments[0]!.colEnd, 1, 'the persisted draft file must keep the multi-line colEnd');

  const submit = await fetch(`${handle.url}api/review/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseVersion: draftBody.version, comments: [multiLineComment] }),
  });
  assert.equal(submit.status, 200);
  const submitBody = await submit.json() as { ok: boolean; result: FeedbackResult };
  assert.equal(submitBody.ok, true);
  assert.equal(submitBody.result.comments.length, 1);
  assert.equal(submitBody.result.comments[0]!.colStart, 4, 'POST /api/review/submit must preserve a valid multi-line colStart');
  assert.equal(submitBody.result.comments[0]!.colEnd, 1, 'POST /api/review/submit must preserve a valid multi-line colEnd');

  const onDiskSubmitted = JSON.parse(readFileSync(output, 'utf8')) as { comments: FeedbackResult['comments'] };
  assert.equal(onDiskSubmitted.comments[0]!.colStart, 4, 'the persisted submitted file must keep the multi-line colStart');
  assert.equal(onDiskSubmitted.comments[0]!.colEnd, 1, 'the persisted submitted file must keep the multi-line colEnd');

  await handle.stop();
  rmSync(dir, { recursive: true, force: true });
  console.log('OK: multi-line comment columns survive PUT /api/review/draft and POST /api/review/submit');
}

console.log('OK');
