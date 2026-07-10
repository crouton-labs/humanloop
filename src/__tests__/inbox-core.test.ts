import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  registerInboxRoot, listInboxRoots,
} from '../inbox/registry.js';
import { submitDeck, submitReview, finalizeDeck, completeReview, cancelTicketResult, readTicketResult } from '../inbox/tickets.js';
import { claimTicket } from '../inbox/claim.js';
import { scanInbox } from '../inbox/scan.js';
import { atomicWriteJson, deliveryPath, progressPath, responsePath } from '../inbox/convention.js';
import { dispatchCompletion, reconcileCompletions } from '../inbox/completion.js';
import type { Deck, FeedbackResult } from '../types.js';

const temp = mkdtempSync(join(tmpdir(), 'humanloop-inbox-core-'));
process.env.XDG_STATE_HOME = join(temp, 'state');
const root = join(temp, 'tickets');
const source = join(temp, 'source.md');
writeFileSync(source, '# Source\n');
const deck = (blockedSince: string): Deck => ({ title: 'A deck', source: { blockedSince, nodeId: 'node-1' }, interactions: [{ id: 'go', title: 'Go?', options: [{ id: 'yes', label: 'Yes' }] }] });

const registration = registerInboxRoot({ root, owner: 'test-owner' });
assert.equal(registerInboxRoot({ root, owner: 'test-owner' }).root, registration.root, 'same owner is idempotent');
assert.throws(() => registerInboxRoot({ root, owner: 'other' }), /already owned/, 'owner collision is rejected');
assert.equal(listInboxRoots()[0]?.available, true);

const oldDeck = submitDeck({ root, id: 'z-last', deck: deck('2025-01-01T00:00:00.000Z') });
const newDeck = submitDeck({ root, id: 'a-first', deck: deck('2025-01-02T00:00:00.000Z') });
const review = submitReview({ root, id: 'review', review: { file: source, title: 'Review source', source: { nodeId: 'node-1' }, blockedSince: '2025-01-02T00:00:00.000Z' } });
assert.throws(() => submitReview({ root, id: 'bad-review', review: { file: join(temp, 'missing.md'), title: 'Bad', source: {} } }), /existing absolute markdown/);

// Same timestamp is stable by id; progress is resumable work, never a hidden lease.
atomicWriteJson(progressPath(newDeck.dir), { kind: 'deck', responses: [], savedAt: new Date().toISOString() });
const scanned = scanInbox([root]);
assert.deepEqual(scanned.map((item) => item.id), ['a-first', 'review', 'z-last']);
assert.equal(scanned.find((item) => item.id === 'a-first')?.claim, undefined);
assert.equal(scanned.find((item) => item.id === 'review')?.kind, 'review');

const firstClaim = claimTicket(newDeck.dir);
assert.notEqual(firstClaim, null);
assert.equal(claimTicket(newDeck.dir), null, 'a second controller cannot claim a live ticket');
const staleDir = submitDeck({ root, id: 'stale', deck: deck('2025-01-03T00:00:00.000Z') }).dir;
const stale = claimTicket(staleDir, { host: 'other-host', pid: 1, now: new Date(Date.now() - 31_000) });
assert.notEqual(stale, null);
assert.notEqual(claimTicket(staleDir), null, 'expired remote claim recovers');

const final = finalizeDeck(newDeck.dir, [{ id: 'go', selectedOptionId: 'yes' }], firstClaim?.token);
assert.equal(final.won, true);
assert.equal(readTicketResult(newDeck.dir)?.kind, 'deck');
writeFileSync(responsePath(oldDeck.dir), JSON.stringify({ schema: 'humanloop.response/v2', kind: 'deck', responses: [], summary: '', completedAt: 'now', extra: true }));
assert.equal(readTicketResult(oldDeck.dir), null, 'result decoder rejects extra fields');
const cancelDir = submitDeck({ root, id: 'cancel-race', deck: deck('2025-01-03T00:00:00.000Z') }).dir;
const canceled = cancelTicketResult(cancelDir, { reason: 'stop' });
assert.equal(canceled.status, 'canceled');
assert.equal(cancelTicketResult(cancelDir).status, 'already_resolved', 'first final writer wins');

const eventFile = join(temp, 'events.jsonl');
const failFile = join(temp, 'fail-once');
writeFileSync(failFile, 'fail');
const handler = join(temp, 'handler.cjs');
writeFileSync(handler, "const fs=require('fs'); const [out,fail,projection]=process.argv.slice(2); if (!fs.existsSync(projection)) process.exit(7); if (fs.existsSync(fail)) process.exit(8); fs.appendFileSync(out, fs.readFileSync(0,'utf8')); ");
registerInboxRoot({ root, owner: 'test-owner', handler: { command: process.execPath, args: [handler, eventFile, failFile, review.dir + '/feedback.json'] } });
const feedback: FeedbackResult = { file: source, submitted: true, approved: true, comments: [], submittedAt: '2025-01-04T00:00:00.000Z', savedAt: '2025-01-04T00:00:00.000Z' };
const reviewClaim = claimTicket(review.dir);
assert.notEqual(reviewClaim, null);
assert.equal((await completeReview(review.dir, feedback, reviewClaim!.token)).won, true);
assert.equal(await dispatchCompletion(root, review.dir), 'pending', 'failed callback remains replayable');
assert.equal(existsSync(deliveryPath(review.dir)), false);
rmSync(failFile);
await reconcileCompletions(root);
assert.equal(existsSync(deliveryPath(review.dir)), true);
const lines = readFileSync(eventFile, 'utf8').trim().split('\n');
const event = JSON.parse(lines.at(-1) ?? '') as { schema: string; kind: string; outcome: string };
assert.equal(event.schema, 'humanloop.completion/v1');
assert.equal(event.kind, 'review');
assert.equal(event.outcome, 'resolved', 'review projection precedes callback and canonical event is delivered');

rmSync(temp, { recursive: true, force: true });
console.log('inbox core tests passed');
