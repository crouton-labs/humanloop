import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  registerInboxRoot, listInboxRoots, unregisterInboxRoot,
} from '../inbox/registry.js';
import { submitDeck, submitReview, finalizeDeck, finalizeReview, completeReview, cancelTicketResult, readTicketResult } from '../inbox/tickets.js';
import { claimTicket } from '../inbox/claim.js';
import { scanInbox } from '../inbox/scan.js';
import { atomicWriteJson, deliveryPath, progressPath, responsePath, reviewPath } from '../inbox/convention.js';
import { dispatchCompletion, reconcileCompletions } from '../inbox/completion.js';
import type { Deck, FeedbackResult } from '../types.js';

const temp = mkdtempSync(join(tmpdir(), 'humanloop-inbox-core-'));
process.env.XDG_STATE_HOME = join(temp, 'state');
const root = join(temp, 'tickets');
const source = join(temp, 'source.md');
writeFileSync(source, '# Source\n');
const deck = (blockedSince: string): Deck => ({ title: 'A deck', source: { blockedSince, nodeId: 'node-1' }, interactions: [{ id: 'go', title: 'Go?', options: [{ id: 'yes', label: 'Yes' }] }] });
async function waitFor(paths: string[]): Promise<void> {
  for (let attempts = 0; !paths.every(existsSync); attempts++) {
    if (attempts > 1_000) throw new Error(`workers did not reach barrier: ${paths.join(', ')}`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1));
  }
}

const registration = registerInboxRoot({ root, owner: 'test-owner' });
const rootLink = join(temp, 'tickets-link');
symlinkSync(root, rootLink);
assert.equal(unregisterInboxRoot(rootLink, 'test-owner'), true, 'symlink unregister canonicalizes available roots');
registerInboxRoot({ root, owner: 'test-owner' });
assert.equal(registerInboxRoot({ root, owner: 'test-owner' }).root, registration.root, 'same owner is idempotent');
assert.throws(() => registerInboxRoot({ root, owner: 'other' }), /already owned/, 'owner collision is rejected');
assert.equal(listInboxRoots()[0]?.available, true);

const oldDeck = submitDeck({ root, id: 'z-last', deck: deck('2025-01-01T00:00:00.000Z') });
const newDeck = submitDeck({ root, id: 'a-first', deck: deck('2025-01-02T00:00:00.000Z') });
const review = submitReview({ root, id: 'review', review: { file: source, title: 'Review source', source: { nodeId: 'node-1' }, blockedSince: '2025-01-02T00:00:00.000Z' } });
assert.throws(() => submitReview({ root, id: 'bad-review', review: { file: join(temp, 'missing.md'), title: 'Bad', source: {} } }), /existing absolute markdown/);
assert.equal(existsSync(join(root, 'bad-review')), false, 'invalid submission does not strand an id');
const prepared = join(root, 'prepared');
mkdirSync(prepared);
writeFileSync(join(prepared, 'body.md'), 'prepared body');
const preparedTicket = submitDeck({ root, id: 'prepared', deck: { ...deck('2025-01-02T00:00:00.000Z'), interactions: [{ id: 'go', title: 'Go?', bodyPath: 'body.md', options: [{ id: 'yes', label: 'Yes' }] }] } });
assert.equal(preparedTicket.dir, realpathSync(prepared), 'submission accepts a crouter-precreated direct child and colocated assets');


// Same timestamp is stable by id; progress is resumable work, never a hidden lease.
atomicWriteJson(progressPath(newDeck.dir), { kind: 'deck', responses: [], savedAt: new Date().toISOString() });
const scanned = scanInbox([root]);
assert.deepEqual(scanned.map((item) => item.id), ['a-first', 'prepared', 'review', 'z-last']);
assert.equal(scanned.find((item) => item.id === 'a-first')?.claim, undefined);
assert.equal(scanned.find((item) => item.id === 'review')?.kind, 'review');

const firstClaim = claimTicket(newDeck.dir);
assert.notEqual(firstClaim, null);
assert.equal(claimTicket(newDeck.dir), null, 'a second controller cannot claim a live ticket');
// A separate process writes a genuine remote claim whose heartbeat is already
// stale, then exits; this process recovers it — cross-process stale recovery.
const staleDir = submitDeck({ root, id: 'stale', deck: deck('2025-01-03T00:00:00.000Z') }).dir;
const staleClaimReady = join(temp, 'stale-claim-ready');
await new Promise<void>((resolveWorker, rejectWorker) => spawn(process.execPath, ['--import', 'tsx', 'src/__tests__/inbox-stale-claim-worker.ts', staleDir, staleClaimReady], { cwd: process.cwd(), stdio: ['ignore', 'ignore', 'inherit'] }).once('exit', (code) => code === 0 ? resolveWorker() : rejectWorker(new Error('stale-claim worker failed'))));
assert.notEqual(JSON.parse(readFileSync(staleClaimReady, 'utf8')), null, 'a separate process wrote a stale remote claim on disk');
assert.notEqual(claimTicket(staleDir), null, 'a remote claim written by another process recovers once its heartbeat has expired');
const malformedDir = submitDeck({ root, id: 'malformed-claim', deck: deck('2025-01-03T00:00:00.000Z') }).dir;
writeFileSync(join(malformedDir, 'claim.json'), '{');
assert.notEqual(claimTicket(malformedDir), null, 'partial claim crash artifact recovers');

const final = finalizeDeck(newDeck.dir, [{ id: 'go', selectedOptionId: 'yes' }], firstClaim?.token);
assert.equal(final.won, true);
assert.equal(readTicketResult(newDeck.dir)?.kind, 'deck');
assert.equal(claimTicket(newDeck.dir), null, 'terminal tickets cannot be claimed');
const exactResults = [
  { schema: 'humanloop.response/v2', kind: 'deck', responses: [], summary: '', completedAt: '2025-01-04T00:00:00.000Z' },
  { schema: 'humanloop.review-response/v1', kind: 'review', result: { file: source, submitted: true, approved: true, comments: [], submittedAt: '2025-01-04T00:00:00.000Z', savedAt: '2025-01-04T00:00:00.000Z' }, completedAt: '2025-01-04T00:00:00.000Z' },
  { schema: 'humanloop.cancel/v1', kind: 'canceled', canceledAt: '2025-01-04T00:00:00.000Z', reason: 'stop', actor: 'test' },
];
for (const [index, result] of exactResults.entries()) {
  const dir = submitDeck({ root, id: `strict-${index}`, deck: deck('2025-01-03T00:00:00.000Z') }).dir;
  writeFileSync(responsePath(dir), JSON.stringify(result));
  assert.equal(readTicketResult(dir)?.kind, result.kind, `strict decoder accepts exact ${result.kind} result`);
}
const validFeedback = exactResults[1].result;
const iso = '2025-01-04T00:00:00.000Z';
const rejectFixtures: { why: string; result: unknown }[] = [
  { why: 'a wrong kind for a known schema', result: { schema: 'humanloop.response/v2', kind: 'review', responses: [], summary: '', completedAt: iso } },
  { why: 'an unknown schema id', result: { schema: 'humanloop.response/v9', kind: 'deck', responses: [], summary: '', completedAt: iso } },
  { why: 'a deck missing its required completedAt', result: { schema: 'humanloop.response/v2', kind: 'deck', responses: [], summary: '' } },
  { why: 'a deck with a non-ISO completedAt', result: { schema: 'humanloop.response/v2', kind: 'deck', responses: [], summary: '', completedAt: 'now' } },
  { why: 'a deck with an unrecognized nested response field', result: { schema: 'humanloop.response/v2', kind: 'deck', responses: [{ id: 'go', bogus: true }], summary: '', completedAt: iso } },
  { why: 'a deck with an extra top-level field', result: { schema: 'humanloop.response/v2', kind: 'deck', responses: [], summary: '', completedAt: iso, extra: true } },
  { why: 'a review missing its required result', result: { schema: 'humanloop.review-response/v1', kind: 'review', completedAt: iso } },
  { why: 'a review whose nested result is not submitted', result: { schema: 'humanloop.review-response/v1', kind: 'review', result: { ...validFeedback, submitted: false }, completedAt: iso } },
  { why: 'a review whose approved flag contradicts its comments', result: { schema: 'humanloop.review-response/v1', kind: 'review', result: { ...validFeedback, approved: true, comments: [{ id: 'c1', line: 1, endLine: 1, lineText: '# Source', comment: 'x', createdAt: iso }] }, completedAt: iso } },
  { why: 'a review nested comment whose endLine precedes its line', result: { schema: 'humanloop.review-response/v1', kind: 'review', result: { ...validFeedback, approved: false, comments: [{ id: 'c1', line: 5, endLine: 2, lineText: '# Source', comment: 'x', createdAt: iso }] }, completedAt: iso } },
  { why: 'a review with an extra top-level field', result: { schema: 'humanloop.review-response/v1', kind: 'review', result: validFeedback, completedAt: iso, extra: true } },
  { why: 'a canceled result missing its required canceledAt', result: { schema: 'humanloop.cancel/v1', kind: 'canceled', reason: 'stop' } },
  { why: 'a canceled result with a non-ISO canceledAt', result: { schema: 'humanloop.cancel/v1', kind: 'canceled', canceledAt: 'now' } },
  { why: 'a canceled result with an extra top-level field', result: { schema: 'humanloop.cancel/v1', kind: 'canceled', canceledAt: iso, extra: true } },
];
for (const [index, fixture] of rejectFixtures.entries()) {
  const dir = submitDeck({ root, id: `strict-reject-${index}`, deck: deck('2025-01-03T00:00:00.000Z') }).dir;
  writeFileSync(responsePath(dir), JSON.stringify(fixture.result));
  assert.equal(readTicketResult(dir), null, `strict decoder rejects ${fixture.why}`);
}
const protocolDir = join(root, 'stale-protocol');
mkdirSync(protocolDir);
writeFileSync(responsePath(protocolDir), '{}');
assert.throws(() => submitDeck({ root, id: 'stale-protocol', deck: deck('2025-01-03T00:00:00.000Z') }), /protocol state/, 'precreated assets may not include humanloop lifecycle state');
const cancelDir = submitDeck({ root, id: 'cancel-race', deck: deck('2025-01-03T00:00:00.000Z') }).dir;
const canceled = cancelTicketResult(cancelDir, { reason: 'stop' });
assert.equal(canceled.status, 'canceled');
assert.equal(cancelTicketResult(cancelDir).status, 'already_resolved', 'first final writer wins');
const finalRaceDir = submitDeck({ root, id: 'final-race', deck: deck('2025-01-03T00:00:00.000Z') }).dir;
const finalRaceClaim = claimTicket(finalRaceDir)!;
const finalBarrier = join(temp, 'final-race-barrier');
const finalReady = join(temp, 'final-race-ready');
const cancelWorker = spawn(process.execPath, ['--import', 'tsx', 'src/__tests__/inbox-cancel-worker.ts', finalRaceDir, finalBarrier, finalReady], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
await waitFor([finalReady]);
writeFileSync(finalBarrier, 'go');
const finalRace = finalizeDeck(finalRaceDir, [{ id: 'go', selectedOptionId: 'yes' }], finalRaceClaim.token);
await new Promise<void>((resolveWorker, rejectWorker) => cancelWorker.once('exit', (code) => code === 0 ? resolveWorker() : rejectWorker(new Error('cancel worker failed'))));
assert.equal(readTicketResult(finalRaceDir)?.kind, finalRace.won ? 'deck' : 'canceled', 'submit and cancellation race has one canonical winner');
const concurrentDir = submitDeck({ root, id: 'concurrent-claim', deck: deck('2025-01-03T00:00:00.000Z') }).dir;
const claimBarrier = join(temp, 'claim-race-barrier');
let claimWorkerNumber = 0;
const claimReadyPaths: string[] = [];
const runClaimWorker = () => new Promise<unknown>((resolveWorker, rejectWorker) => {
  const ready = join(temp, `claim-race-ready-${claimWorkerNumber++}`);
  claimReadyPaths.push(ready);
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/__tests__/inbox-claim-worker.ts', concurrentDir, claimBarrier, ready], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; let errors = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { errors += chunk; });
  child.once('exit', (code) => code === 0 ? resolveWorker(JSON.parse(output)) : rejectWorker(new Error(errors)));
});
const concurrentClaimRuns = [runClaimWorker(), runClaimWorker()];
await waitFor(claimReadyPaths);
writeFileSync(claimBarrier, 'go');
const concurrentClaims = await Promise.all(concurrentClaimRuns);
assert.equal(concurrentClaims.filter((claim) => claim !== null).length, 1, 'separate processes exclusively claim one ticket');

const feedback: FeedbackResult = { file: source, submitted: true, approved: true, comments: [], submittedAt: '2025-01-04T00:00:00.000Z', savedAt: '2025-01-04T00:00:00.000Z' };
assert.throws(() => submitReview({ root, id: 'bad-output', review: { file: source, output: responsePath(review.dir), title: 'Bad output', source: {} } }), /must not alias/, 'review output cannot replace a ticket response');
assert.throws(() => submitReview({ root, id: 'source-output', review: { file: source, output: source, title: 'Bad output', source: {} } }), /must not alias/, 'review output cannot overwrite its source');
const mutableReview = submitReview({ root, id: 'mutable-projection', review: { file: source, title: 'Mutable output', source: {} } });
const mutableClaim = claimTicket(mutableReview.dir)!;
assert.equal(finalizeReview(mutableReview.dir, feedback, mutableClaim.token).won, true);
atomicWriteJson(reviewPath(mutableReview.dir), { schema: 'humanloop.review/v1', file: source, output: source, title: 'Mutable output', source: {}, blockedSince: '2025-01-04T00:00:00.000Z' });
assert.equal(await dispatchCompletion(root, mutableReview.dir), 'pending', 'projection revalidates mutable descriptors at its write boundary');
assert.equal(readFileSync(source, 'utf8'), '# Source\n', 'mutable review descriptor cannot overwrite source');

const eventFile = join(temp, 'events.jsonl');
const failFile = join(temp, 'fail-once');
writeFileSync(failFile, 'fail');
const handler = join(temp, 'handler.cjs');
writeFileSync(handler, "const fs=require('fs'); const [out,fail,projection]=process.argv.slice(2); if (!fs.existsSync(projection)) process.exit(7); if (fs.existsSync(fail)) process.exit(8); fs.appendFileSync(out, fs.readFileSync(0,'utf8')); ");
registerInboxRoot({ root, owner: 'test-owner', handler: { command: process.execPath, args: [handler, eventFile, failFile, review.dir + '/feedback.json'] } });
const reviewClaim = claimTicket(review.dir);
assert.notEqual(reviewClaim, null);
assert.equal((await completeReview(review.dir, feedback, reviewClaim!.token)).won, true);
assert.equal(await dispatchCompletion(root, review.dir), 'pending', 'failed callback remains replayable');
assert.equal(existsSync(deliveryPath(review.dir)), false);
rmSync(failFile);
await reconcileCompletions(root);
assert.equal(existsSync(deliveryPath(review.dir)), true);
const lines = readFileSync(eventFile, 'utf8').trim().split('\n');
const events = lines.map((line) => JSON.parse(line) as { schema: string; kind: string; outcome: string });
const event = events.find((candidate) => candidate.kind === 'review');
assert.equal(event?.schema, 'humanloop.completion/v1');
assert.equal(event?.outcome, 'resolved', 'review projection precedes callback and canonical event is delivered');

rmSync(temp, { recursive: true, force: true });
console.log('inbox core tests passed');
