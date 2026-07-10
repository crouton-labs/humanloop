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

// Bounds a promise with a local, explicit failure instead of letting a
// broken implementation hang the raw tsx test process forever — a timeout
// here fails with a clear assertion message rather than a silent hang.
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const bound = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms waiting for: ${label}`)), ms);
  });
  return Promise.race([promise, bound]).finally(() => clearTimeout(timer)) as Promise<T>;
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
  handle.activate();
  writeFileSync(output, JSON.stringify({
    kind: 'review',
    comments: [{ id: 'nvim-draft', line: 1, endLine: 1, lineText: '# Source', comment: 'from nvim', createdAt: '2026-07-07T20:00:00.000Z' }],
    savedAt: '2026-07-07T20:00:01.000Z',
    version: 1,
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
  assert.equal(submitBody.result.submitted, false, 'browser submit proposes; the controller owns canonical finalization');
  assert.equal(existsSync(submitFlag), true, 'review browser submit must write the submit sentinel');
  assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), {
    kind: 'review', comments: [], savedAt: submitBody.submittedAt, version: 3,
  });
  const convergedMessage = await convergedSignal;
  assert.equal(convergedMessage.type, 'converged');
  assert.equal(onSubmitFired, 1);
  assert.equal(submittedResult?.submitted, true, 'the controller callback receives the final proposal');

  ws.close();
  rmSync(dir, { recursive: true, force: true });
  console.log('OK: review endpoints write drafts, reject stale edits, submit with ack ordering, and broadcast signals');
}

// ── Test 5: a persisted draft retains its version even when its contents are unchanged ──

{
  const dir = mkdtempSync(join(tmpdir(), 'hl-review-server-test-'));
  const file = resolve(join(dir, 'source.md'));
  const output = join(dir, 'feedback.json');
  writeFileSync(file, 'body\n');
  writeFileSync(output, JSON.stringify({
    kind: 'review',
    comments: [{ id: 'persisted', line: 1, endLine: 1, lineText: 'body', comment: 'keep version', createdAt: '2026-07-07T20:00:00.000Z' }],
    savedAt: '2026-07-07T20:00:01.000Z',
    version: 4,
  }, null, 2) + '\n');

  const handle = await startReviewWebServer({ jobDir: dir, file, output });
  handle.activate();
  const initial = await fetch(`${handle.url}api/review`);
  const initialBody = await initial.json() as { version: number; result: FeedbackResult };
  assert.equal(initialBody.version, 4, 'the browser must receive the persisted version even when no content refresh is needed');
  assert.equal(initialBody.result.comments[0]!.id, 'persisted');

  const stale = await fetch(`${handle.url}api/review/draft`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseVersion: 0, comments: [] }),
  });
  assert.equal(stale.status, 409, 'a stale base version must not overwrite a persisted draft');

  const update = await fetch(`${handle.url}api/review/draft`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseVersion: 4, comments: [] }),
  });
  assert.equal(update.status, 200);
  assert.equal((await update.json() as { version: number }).version, 5, 'the next durable edit increments from the persisted version');

  await handle.stop();
  rmSync(dir, { recursive: true, force: true });
  console.log('OK: unchanged persisted drafts retain their version token');
}

// ── Test 6: review submit is single-assignment and source 404s ───────────────

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
  handle.activate();

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
  const secondBody = await second.json() as { ok: boolean; error: string; output: string; result: FeedbackResult };
  assert.equal(secondBody.ok, false);
  assert.equal(secondBody.error, 'already_submitted');
  assert.equal(secondBody.output, firstBody.output);
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
  handle.activate();

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

// ── Test 7: draft/submit writes are gated behind activate() (Finding 1) ─────
// Before the terminal observes the handoff flag and calls activate(), the
// browser has no editing authority yet — PUT /api/review/draft and
// POST /api/review/submit must 409 rather than silently accepting writes
// from a tab that was never actually handed off.

{
  const dir = mkdtempSync(join(tmpdir(), 'hl-review-server-test-'));
  const file = resolve(join(dir, 'source.md'));
  const output = join(dir, 'feedback.json');
  const submitFlag = join(dir, 'submitted.flag');
  writeFileSync(file, 'body\n');
  let onSubmitFired = 0;

  const handle = await startReviewWebServer({
    jobDir: dir,
    file,
    output,
    submitFlagPath: submitFlag,
    onSubmit: () => { onSubmitFired++; },
  });

  const validComment = {
    id: 'c1', line: 1, endLine: 1, lineText: 'body', comment: 'not handed off yet', createdAt: '2026-07-07T20:00:00.000Z',
  };

  const draftBefore = await fetch(`${handle.url}api/review/draft`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseVersion: 0, comments: [validComment] }),
  });
  assert.equal(draftBefore.status, 409, 'draft PUT must 409 before activation');
  assert.equal(((await draftBefore.json()) as { error: string }).error, 'not_handed_off');
  assert.equal(existsSync(output), false, 'an unactivated draft PUT must not write output');

  const submitBefore = await fetch(`${handle.url}api/review/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseVersion: 0, comments: [validComment] }),
  });
  assert.equal(submitBefore.status, 409, 'submit POST must 409 before activation');
  assert.equal(((await submitBefore.json()) as { error: string }).error, 'not_handed_off');
  assert.equal(existsSync(output), false, 'an unactivated submit POST must not write output or finalize');
  assert.equal(existsSync(submitFlag), false, 'an unactivated submit POST must not write the submit sentinel');
  assert.equal(onSubmitFired, 0, 'an unactivated submit POST must never fire onSubmit');

  const getBefore = await fetch(`${handle.url}api/review`);
  assert.equal(getBefore.status, 200, 'GET /api/review still works before activation');
  assert.equal(((await getBefore.json()) as { activated: boolean }).activated, false, 'GET /api/review reports activated: false before handoff');

  handle.activate();

  const getAfter = await fetch(`${handle.url}api/review`);
  assert.equal(getAfter.status, 200);
  assert.equal(((await getAfter.json()) as { activated: boolean }).activated, true, 'GET /api/review reports activated: true after handoff');

  const draftAfter = await fetch(`${handle.url}api/review/draft`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseVersion: 0, comments: [validComment] }),
  });
  assert.equal(draftAfter.status, 200, 'draft PUT succeeds once activated');
  assert.equal(existsSync(output), true, 'an activated draft PUT writes output');
  const draftAfterBody = await draftAfter.json() as { version: number };

  const submitAfter = await fetch(`${handle.url}api/review/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseVersion: draftAfterBody.version, comments: [validComment] }),
  });
  assert.equal(submitAfter.status, 200, 'submit POST succeeds once activated');
  assert.equal(existsSync(submitFlag), true, 'an activated submit POST writes the submit sentinel');
  assert.equal(onSubmitFired, 1, 'an activated submit POST fires onSubmit exactly once');

  await handle.stop();
  rmSync(dir, { recursive: true, force: true });
  console.log('OK: draft/submit writes are gated behind activate() (Finding 1)');
}

// ── Test 8: take-back is bounded by takeBackAckTimeoutMs (Finding 2a) ───────
// A tab that never acks the take-back-requested broadcast must not hang
// requestTakeBack() forever — it resolves once the (test-shortened) timeout
// elapses, and the socket still gets the final taken-back broadcast.

{
  const dir = mkdtempSync(join(tmpdir(), 'hl-review-server-test-'));
  const file = resolve(join(dir, 'source.md'));
  const output = join(dir, 'feedback.json');
  writeFileSync(file, 'body\n');

  const handle = await startReviewWebServer({ jobDir: dir, file, output, takeBackAckTimeoutMs: 50 });
  handle.activate();
  const ws = await openWs(handle.url);

  const requestedSignal = withTimeout(nextWsJson(ws), 5000, 'take-back-requested broadcast');
  const start = Date.now();
  const takeBackPromise = withTimeout(handle.requestTakeBack(), 5000, 'requestTakeBack() to resolve');
  const requestedMessage = await requestedSignal;
  assert.equal(requestedMessage.type, 'take-back-requested', 'take-back-requested is broadcast first');

  // Arm the listener for the final broadcast BEFORE the ack-wait resolves —
  // this tab never acks, so requestTakeBack() must fall through on its own
  // bounded timeout rather than hanging.
  const takenBackSignal = withTimeout(nextWsJson(ws), 5000, 'taken-back broadcast');
  await takeBackPromise;
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 1000, `requestTakeBack must resolve bounded by the timeout, not hang (took ${elapsed}ms for a 50ms timeout)`);

  const takenBackMessage = await takenBackSignal;
  assert.equal(takenBackMessage.type, 'taken-back', 'a socket that never acks still receives the final taken-back broadcast');

  ws.close();
  await handle.stop();
  rmSync(dir, { recursive: true, force: true });
  console.log('OK: requestTakeBack() is bounded by takeBackAckTimeoutMs when a tab never acks (Finding 2a)');
}

// ── Test 9: take-back does not drop a pending flush (Finding 2b) ────────────
// The literal protocol-level regression for "take-back must not lose a
// pending dirty edit": on take-back-requested, the browser is expected to
// PUT its dirty draft and THEN POST the ack. requestTakeBack() must not
// resolve (and taken-back must not broadcast) until AFTER that ack lands,
// and the flushed draft must already be on disk before taken-back goes out.

{
  const dir = mkdtempSync(join(tmpdir(), 'hl-review-server-test-'));
  const file = resolve(join(dir, 'source.md'));
  const output = join(dir, 'feedback.json');
  writeFileSync(file, 'body\n');

  // Timeout behavior is not under test here — pass a deliberately long
  // takeBackAckTimeoutMs so the ack-arrival path never races the internal
  // timeout fallback (Test 8 covers the timeout fallback itself).
  const handle = await startReviewWebServer({ jobDir: dir, file, output, takeBackAckTimeoutMs: 60_000 });
  handle.activate();
  const ws = await openWs(handle.url);

  const flushedComment = {
    id: 'flushed', line: 1, endLine: 1, lineText: 'body', comment: 'flushed before ack', createdAt: '2026-07-07T20:00:00.000Z',
  };

  let takeBackResolved = false;
  const requestedSignal = withTimeout(nextWsJson(ws), 5000, 'take-back-requested broadcast');
  const takeBackPromise = withTimeout(handle.requestTakeBack(), 5000, 'requestTakeBack() to resolve').then(() => { takeBackResolved = true; });
  const requestedMessage = await requestedSignal;
  assert.equal(requestedMessage.type, 'take-back-requested');

  // Simulate the browser's forced flush: PUT the dirty draft, THEN ack.
  const draft = await fetch(`${handle.url}api/review/draft`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseVersion: 0, comments: [flushedComment] }),
  });
  assert.equal(draft.status, 200, 'the forced flush PUT succeeds');
  assert.equal(takeBackResolved, false, 'requestTakeBack must not resolve before the ack lands, even after the flush PUT');

  const onDiskBeforeAck = JSON.parse(readFileSync(output, 'utf8')) as { comments: unknown[] };
  assert.equal(onDiskBeforeAck.comments.length, 1, 'the flushed draft is already on disk before the ack is posted');

  const takenBackSignal = withTimeout(nextWsJson(ws), 5000, 'taken-back broadcast');
  const ack = await fetch(`${handle.url}api/review/take-back-ack`, { method: 'POST' });
  assert.equal(ack.status, 200);

  await takeBackPromise;
  assert.equal(takeBackResolved, true, 'requestTakeBack resolves once the ack has landed');

  const takenBackMessage = await takenBackSignal;
  assert.equal(takenBackMessage.type, 'taken-back', 'taken-back is broadcast only after the ack, once the flushed draft is already durable');

  ws.close();
  await handle.stop();
  rmSync(dir, { recursive: true, force: true });
  console.log('OK: take-back waits for the browser to flush its dirty draft and ack before broadcasting taken-back (Finding 2b)');
}

// ── Test 10: the taken-back broadcast survives an immediately-following
// stop() (Finding 3) ─────────────────────────────────────────────────────────
// The causal guarantee the fix provides is LOCAL and same-process: the `ws`
// library's send-flush callback (the payload handed to the OS socket
// buffer) must fire strictly before the immediately-following stop()'s hard
// `ws.terminate()` on that same socket — that's what "broadcast() is
// awaited before teardown" actually buys. That is a DIFFERENT claim from
// "the remote client's own 'message' event fires before the local stop()
// promise resolves" — that crosses a second, independent async boundary
// (the client's own socket/event loop) that this fix makes no promise
// about. Verified empirically while hardening this test (see the reasoning
// doc): that client-side-receipt-vs-local-stop() ordering is NOT a valid
// proxy for the fix — it fails deterministically (5/5 runs) against the
// CORRECT, unreverted code, because stop()'s own work is entirely local
// while message delivery to the client crosses the socket boundary and
// reliably loses that race on this machine regardless of whether the frame
// was flushed first.
//
// So this drives the assertion one level down, at the actual causal
// boundary: monkeypatch `WebSocket.prototype.send`/`.terminate` on the same
// `ws` package `server.ts` uses for its server-side sockets, and record
// when the 'taken-back' payload's send-flush callback fires relative to
// when `terminate()` is called on that socket. Verified empirically: the
// FIXED code always yields ['send-flushed', 'terminate']; temporarily
// reverting broadcast() to fire-and-forget (not awaiting the send callback
// before the caller proceeds to stop()) flips this to
// ['terminate', 'send-flushed'] on every run (5/5) — a clean, non-flaky
// discriminator, unlike the client-side receipt-timing approach above.

{
  const dir = mkdtempSync(join(tmpdir(), 'hl-review-server-test-'));
  const file = resolve(join(dir, 'source.md'));
  const output = join(dir, 'feedback.json');
  writeFileSync(file, 'body\n');

  const order: string[] = [];
  type PatchableWs = { send: (data: unknown, cb?: (err?: Error) => void) => void; terminate: () => void };
  const wsProto = WebSocket.prototype as unknown as PatchableWs;
  const origSend = wsProto.send;
  const origTerminate = wsProto.terminate;
  wsProto.send = function patchedSend(this: WebSocket, data: unknown, cb?: (err?: Error) => void): void {
    origSend.call(this, data, (err?: Error) => {
      let parsed: { type?: string } = {};
      try { parsed = JSON.parse(String(data)) as { type?: string }; } catch { /* not JSON, ignore */ }
      if (parsed.type === 'taken-back') order.push('send-flushed');
      cb?.(err);
    });
  };
  wsProto.terminate = function patchedTerminate(this: WebSocket): void {
    order.push('terminate');
    origTerminate.call(this);
  };

  try {
    const handle = await startReviewWebServer({ jobDir: dir, file, output, takeBackAckTimeoutMs: 50 });
    handle.activate();
    const ws = await openWs(handle.url);

    const requestedSignal = withTimeout(nextWsJson(ws), 5000, 'take-back-requested broadcast');
    const takeBackAndStop = withTimeout((async () => {
      await handle.requestTakeBack();
      await handle.stop();
    })(), 5000, 'requestTakeBack()+stop() to resolve');
    const requestedMessage = await requestedSignal;
    assert.equal(requestedMessage.type, 'take-back-requested', 'take-back-requested is broadcast first');

    // Arm the listener for the final broadcast before requestTakeBack's
    // internal ack-wait resolves, so end-to-end delivery is proven too, not
    // just the local send-before-terminate ordering below.
    const takenBackSignal = withTimeout(nextWsJson(ws), 5000, 'taken-back broadcast');
    await takeBackAndStop;
    const takenBackMessage = await takenBackSignal;
    assert.equal(takenBackMessage.type, 'taken-back', 'the taken-back broadcast is still delivered to the client despite the immediately-following stop()');
    assert.deepEqual(order, ['send-flushed', 'terminate'], 'the taken-back payload must be flushed to the OS socket buffer before the immediately-following stop() hard-terminates the socket — not merely eventually delivered (Finding 3)');

    ws.close();
    rmSync(dir, { recursive: true, force: true });
    console.log('OK: the taken-back WS payload is flushed to the OS socket buffer strictly before the immediately-following stop() terminates the socket — a deterministic send-before-terminate ordering guarantee (Finding 3)');
  } finally {
    wsProto.send = origSend;
    wsProto.terminate = origTerminate;
  }
}

// ── Test 11: the strict validator rejects the malformed probe payload at the
// real HTTP boundary (Finding 4) ─────────────────────────────────────────────

{
  const dir = mkdtempSync(join(tmpdir(), 'hl-review-server-test-'));
  const file = resolve(join(dir, 'source.md'));
  const output = join(dir, 'feedback.json');
  writeFileSync(file, 'body\n');

  const handle = await startReviewWebServer({ jobDir: dir, file, output });
  handle.activate();

  const malformedProbe = {
    id: 'probe',
    comment: 'bad anchor accepted',
    line: 'not-a-line',
    endLine: -5,
    lineText: 123,
    createdAt: null,
  };

  const draft = await fetch(`${handle.url}api/review/draft`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseVersion: 0, comments: [malformedProbe] }),
  });
  assert.equal(draft.status, 400, 'a malformed comment anchor must be rejected, not silently normalized');
  assert.equal(((await draft.json()) as { error: string }).error, 'bad_input');
  assert.equal(existsSync(output), false, 'a rejected malformed draft PUT must not write output');

  await handle.stop();
  rmSync(dir, { recursive: true, force: true });
  console.log('OK: the strict comment validator rejects the malformed probe payload at the real HTTP server boundary (Finding 4)');
}

// ── Test 12: the strict validator rejects a malformed submit at the real
// HTTP boundary too, not just draft PUT (Finding 4 minor) ─────────────────────

{
  const dir = mkdtempSync(join(tmpdir(), 'hl-review-server-test-'));
  const file = resolve(join(dir, 'source.md'));
  const output = join(dir, 'feedback.json');
  const submitFlag = join(dir, 'submitted.flag');
  writeFileSync(file, 'body\n');
  let onSubmitFired = 0;

  const handle = await startReviewWebServer({
    jobDir: dir,
    file,
    output,
    submitFlagPath: submitFlag,
    onSubmit: () => { onSubmitFired++; },
  });
  handle.activate();

  const malformedProbe = {
    id: 'probe',
    comment: 'bad anchor accepted',
    line: 'not-a-line',
    endLine: -5,
    lineText: 123,
    createdAt: null,
  };

  const submit = await fetch(`${handle.url}api/review/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseVersion: 0, comments: [malformedProbe] }),
  });
  assert.equal(submit.status, 400, 'a malformed comment anchor must be rejected on submit too, not just draft');
  assert.equal(((await submit.json()) as { error: string }).error, 'bad_input');
  assert.equal(existsSync(output), false, 'a rejected malformed submit POST must not write output');
  assert.equal(existsSync(submitFlag), false, 'a rejected malformed submit POST must not write the submit sentinel');
  assert.equal(onSubmitFired, 0, 'a rejected malformed submit POST must not fire onSubmit');

  await handle.stop();
  rmSync(dir, { recursive: true, force: true });
  console.log('OK: the strict comment validator rejects the malformed probe payload at the POST /api/review/submit boundary too (Finding 4)');
}

// ── Test 13: the ack waiter is armed BEFORE the take-back-requested broadcast
// (Minor finding) ────────────────────────────────────────────────────────────
// requestTakeBack() used to await the broadcast's own send-flush before
// calling waitForTakeBackAcks() — arming the waiter only AFTER the broadcast
// had (locally) finished flushing. A fast browser can receive the frame and
// POST /api/review/take-back-ack while that local flush is still resolving
// (the underlying `ws.send` writes to the socket immediately; only the JS
// completion callback this code awaits can be delayed), and the old ordering
// drops that ack on the floor — ackWaiter was still null — forcing the full
// takeBackAckTimeoutMs even though the flush already landed.
//
// To make this a deterministic (non-flaky) reproduction, this monkeypatches
// `WebSocket.prototype.send` so ONLY the completion callback for a
// 'take-back-requested' payload is artificially delayed — the real
// underlying send still happens immediately (the client genuinely receives
// the frame right away and can genuinely race an ack into the window before
// the delayed callback fires). The test client acks the instant it receives
// take-back-requested. With the arm-before-broadcast fix, that ack always
// lands inside the (already-armed) window and requestTakeBack() resolves
// almost immediately. Reverting to arm-after-broadcast makes the ack land
// while ackWaiter is still null every run — deterministically forcing the
// full timeout, which this test's elapsed-time assertion catches.

{
  const dir = mkdtempSync(join(tmpdir(), 'hl-review-server-test-'));
  const file = resolve(join(dir, 'source.md'));
  const output = join(dir, 'feedback.json');
  writeFileSync(file, 'body\n');

  const SEND_FLUSH_DELAY_MS = 150;
  const TIMEOUT_MS = 2000;

  type PatchableWs = { send: (data: unknown, cb?: (err?: Error) => void) => void };
  const wsProto = WebSocket.prototype as unknown as PatchableWs;
  const origSend = wsProto.send;
  wsProto.send = function patchedSend(this: WebSocket, data: unknown, cb?: (err?: Error) => void): void {
    let parsed: { type?: string } = {};
    try { parsed = JSON.parse(String(data)) as { type?: string }; } catch { /* not JSON, ignore */ }
    if (parsed.type === 'take-back-requested') {
      // The real send still happens synchronously right now (the client
      // genuinely receives the frame immediately) — only OUR completion
      // callback (what requestTakeBack()'s broadcast() Promise awaits) is
      // delayed, widening the local window between "broadcast dispatched"
      // and "broadcast's promise resolves" so a fast concurrent ack can
      // land inside it.
      origSend.call(this, data, (err?: Error) => {
        setTimeout(() => cb?.(err), SEND_FLUSH_DELAY_MS);
      });
    } else {
      origSend.call(this, data, cb);
    }
  };

  try {
    const handle = await startReviewWebServer({ jobDir: dir, file, output, takeBackAckTimeoutMs: TIMEOUT_MS });
    handle.activate();
    const ws = await openWs(handle.url);
    // Ack the instant the client receives take-back-requested — this is the
    // "very fast browser" the finding describes.
    ws.on('message', (data) => {
      const parsed = JSON.parse(data.toString()) as { type?: string };
      if (parsed.type === 'take-back-requested') {
        void fetch(`${handle.url}api/review/take-back-ack`, { method: 'POST' });
      }
    });

    const start = Date.now();
    await withTimeout(handle.requestTakeBack(), TIMEOUT_MS + 5000, 'requestTakeBack() to resolve');
    const elapsed = Date.now() - start;
    assert.ok(
      elapsed < 1000,
      `requestTakeBack() must resolve promptly once the fast ack lands, not fall through to the ${TIMEOUT_MS}ms timeout (took ${elapsed}ms) — the ack waiter must be armed BEFORE the take-back-requested broadcast`,
    );

    ws.close();
    await handle.stop();
    rmSync(dir, { recursive: true, force: true });
    console.log('OK: the take-back ack waiter is armed before the take-back-requested broadcast, so a fast ack is never dropped (Minor)');
  } finally {
    wsProto.send = origSend;
  }
}

console.log('OK');
