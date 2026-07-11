import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerInboxRoot } from '../inbox/registry.js';
import { cancelTicket, submitReview } from '../inbox/tickets.js';
import { claimTicket } from '../inbox/claim.js';
import { ReviewAdapter } from '../inbox/review-adapter.js';
import type { TicketResult } from '../types.js';

const temp = mkdtempSync(join(tmpdir(), 'humanloop-review-adapter-'));
const root = join(temp, 'tickets');
const source = join(temp, 'source.md');
const editor = join(temp, 'editor');
writeFileSync(source, '# Source\n');
writeFileSync(editor, '#!/bin/sh\nif [ "$1" = "--version" ]; then exit 0; fi\nsleep 0.1\ntouch "$HL_SUBMIT_FLAG"\n');
chmodSync(editor, 0o755);

registerInboxRoot({ root, owner: 'review-adapter-test' });
const ticket = submitReview({ root, id: 'race', review: { file: source, title: 'Review', source: {} } });
const claim = claimTicket(ticket.dir);
assert.notEqual(claim, null);

let delivered: TicketResult | null = null;
const adapter = new ReviewAdapter({
  dir: ticket.dir,
  descriptor: JSON.parse(readFileSync(join(ticket.dir, 'review.json'), 'utf8')),
  claim: claim!,
  editor,
  onSubmitted: (result) => { delivered = result; },
});
const started = adapter.start();
await new Promise((resolve) => setTimeout(resolve, 30));
const canceled = await cancelTicket(ticket.dir, { reason: 'toggle' });
const result = await started;

assert.equal(canceled.result.kind, 'canceled');
assert.deepEqual(result, canceled.result, 'a proposal that loses to cancellation must resolve to response.json’s canonical result');
assert.deepEqual(delivered, canceled.result, 'the controller callback must receive the canonical result, not the losing proposal');

// M-i inside native review: the editor writes HL_CLOSE_FLAG. onClose must fire,
// the ticket must stay PENDING (no response.json), and the claim released.
const closeEditor = join(temp, 'close-editor');
writeFileSync(closeEditor, '#!/bin/sh\nif [ "$1" = "--version" ]; then exit 0; fi\ntouch "$HL_CLOSE_FLAG"\n');
chmodSync(closeEditor, 0o755);
const closeTicket = submitReview({ root, id: 'close', review: { file: source, title: 'Close', source: {} } });
const closeClaim = claimTicket(closeTicket.dir);
assert.notEqual(closeClaim, null);
let closed = false;
let closeSubmitted: TicketResult | null = null;
const closeAdapter = new ReviewAdapter({
  dir: closeTicket.dir,
  descriptor: JSON.parse(readFileSync(join(closeTicket.dir, 'review.json'), 'utf8')),
  claim: closeClaim!,
  editor: closeEditor,
  onClose: () => { closed = true; },
  onSubmitted: (result) => { closeSubmitted = result; },
});
await closeAdapter.start();
assert.equal(closed, true, 'M-i in native review fires onClose');
assert.equal(closeSubmitted, null, 'M-i close never submits a result');
assert.equal(existsSync(join(closeTicket.dir, 'response.json')), false, 'M-i close leaves the ticket pending');
assert.equal(existsSync(join(closeTicket.dir, 'claim.json')), false, 'M-i close releases the claim');

rmSync(temp, { recursive: true, force: true });
console.log('review adapter race test passed');
