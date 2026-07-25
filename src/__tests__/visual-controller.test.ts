import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Deck } from '../types.js';
import { InboxController } from '../inbox/controller.js';
import { claimTicket } from '../inbox/claim.js';
import { atomicWriteJson, deckPath, visualsDir } from '../inbox/convention.js';
import { registerInboxRoot } from '../inbox/registry.js';
import { completeDeck, submitDeck } from '../inbox/tickets.js';
import { VISUAL_CAPABILITY, readVisualRequest, startVisualRequest, submitVisualResult } from '../inbox/visual.js';
import { parseKeypress } from '../tui/terminal.js';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

const handler = { command: process.execPath, args: ['-e', ''] };
const deck = (visual = false): Deck => ({
  title: 'Visual decisions',
  source: visual ? { visual: VISUAL_CAPABILITY } : {},
  interactions: [
    { id: 'one', title: 'One', subtitle: 'One requires your attention.', options: [] },
    { id: 'two', title: 'Two', subtitle: 'Two requires your attention.', options: [] },
  ],
});

const temp = mkdtempSync(join(tmpdir(), 'humanloop-visual-controller-'));
process.env.XDG_STATE_HOME = join(temp, 'state');

const markedWithoutHandlerRoot = join(temp, 'marked-without-handler');
registerInboxRoot({ root: markedWithoutHandlerRoot, owner: 'test' });
const markedWithoutHandler = submitDeck({ root: markedWithoutHandlerRoot, id: 'marked-without-handler', deck: deck(true) });
const markedWithoutHandlerController = new InboxController({ roots: [markedWithoutHandlerRoot], cols: 100, rows: 24 });
markedWithoutHandlerController.activate();
assert.ok(!existsSync(visualsDir(markedWithoutHandler.dir)), 'the Visual marker alone does not manufacture capability');
markedWithoutHandlerController.close();

const handlerWithoutMarkerRoot = join(temp, 'handler-without-marker');
registerInboxRoot({ root: handlerWithoutMarkerRoot, owner: 'test', visualHandler: handler });
const handlerWithoutMarker = submitDeck({ root: handlerWithoutMarkerRoot, id: 'handler-without-marker', deck: deck(false) });
const handlerWithoutMarkerController = new InboxController({ roots: [handlerWithoutMarkerRoot], cols: 100, rows: 24 });
handlerWithoutMarkerController.activate();
assert.ok(!existsSync(visualsDir(handlerWithoutMarker.dir)), 'a root handler without the literal marker leaves Visual absent');
handlerWithoutMarkerController.close();

const root = join(temp, 'visual');
registerInboxRoot({ root, owner: 'test', visualHandler: handler });
const ticket = submitDeck({ root, id: 'ticket', deck: deck(true) });
const controller = new InboxController({ roots: [root], cols: 100, rows: 24 });
controller.activate();
const firstIds = readdirSync(visualsDir(ticket.dir)).sort();
assert.equal(firstIds.length, 2, 'a marked ticket with a registered handler eagerly persists one request per interaction');
const first = firstIds.map((requestId) => readVisualRequest(root, ticket.dir, requestId)!);
assert.equal(first[0]!.generationId, first[1]!.generationId, 'all eager requests share the mounted panel generation');
assert.ok(first.every((request) => request.state === 'running'), 'the mounted generation remains current while its results are unresolved');

atomicWriteJson(deckPath(ticket.dir), deck(true));
controller.reloadSelectedDeck();
const allIds = readdirSync(visualsDir(ticket.dir)).sort();
assert.equal(allIds.length, 4, 'reload creates exactly one fresh durable request per interaction');
const reloaded = allIds.map((requestId) => readVisualRequest(root, ticket.dir, requestId)!);
const current = reloaded.filter((request) => request.state === 'running');
assert.equal(current.length, 2, 'reload leaves only the replacement generation current');
assert.notEqual(current[0]!.generationId, first[0]!.generationId, 'reload mints a new generation');
assert.ok(first.every((request) => readVisualRequest(root, ticket.dir, request.requestId)?.state === 'canceled'), 'reload state-first cancels the old generation');
assert.equal(submitVisualResult(root, ticket.dir, {
  requestId: first[0]!.requestId,
  generationId: first[0]!.generationId,
  interactionId: first[0]!.interactionId,
  interaction: first[0]!.interaction,
  claimToken: first[0]!.claim.token,
  status: 'ready',
  markdown: 'late stale result',
}).published, false, 'a late old-generation result cannot become renderable');
registerInboxRoot({ root, owner: 'test' });
controller.reloadSelectedDeck();
assert.equal(readdirSync(visualsDir(ticket.dir)).length, 4, 'reload removes automatic capability when the current handler is removed');
assert.ok(current.every((request) => readVisualRequest(root, ticket.dir, request.requestId)?.state === 'canceled'), 'handler-removal reload cancels the old current generation');
registerInboxRoot({ root, owner: 'test', visualHandler: handler });
controller.reloadSelectedDeck();
const remounted = readdirSync(visualsDir(ticket.dir)).map((requestId) => readVisualRequest(root, ticket.dir, requestId)!).filter((request) => request.state === 'running');
assert.equal(remounted.length, 2, 'reload re-derives a restored handler and starts only its new generation');
controller.close();
assert.ok(remounted.every((request) => readVisualRequest(root, ticket.dir, request.requestId)?.state === 'running'), 'closing the inbox leaves every unresolved request running');

const reopened = new InboxController({ roots: [root], cols: 100, rows: 24 });
reopened.activate();
assert.equal(readdirSync(visualsDir(ticket.dir)).length, 6, 'reopening adopts the detached generation instead of duplicating requests');
const readyRequest = remounted.find((request) => request.interactionId === 'one')!;
assert.equal(submitVisualResult(root, ticket.dir, {
  requestId: readyRequest.requestId,
  generationId: readyRequest.generationId,
  interactionId: readyRequest.interactionId,
  interaction: readyRequest.interaction,
  claimToken: readyRequest.claim.token,
  status: 'ready',
  markdown: 'saved Visual result',
}).published, true);
await tick();
for (const bytes of ['\r', '\x1b[Z']) {
  const parsed = parseKeypress(Buffer.from(bytes));
  reopened.handleKey(parsed.input, parsed.key);
}
await waitFor(
  () => reopened.render().join('\n').includes('saved Visual result'),
  'the adopted running request renders when its durable result arrives',
);
reopened.close();

const reopenedAfterResult = new InboxController({ roots: [root], cols: 100, rows: 24 });
reopenedAfterResult.activate();
assert.equal(readdirSync(visualsDir(ticket.dir)).length, 6, 'reopening after completion adopts the saved result without a new request');
for (const bytes of ['\r', '\x1b[Z']) {
  const parsed = parseKeypress(Buffer.from(bytes));
  reopenedAfterResult.handleKey(parsed.input, parsed.key);
}
await tick();
assert.ok(reopenedAfterResult.render().join('\n').includes('saved Visual result'), 'a completed Visual result survives closing and reopening');
reopenedAfterResult.close();

const completing = submitDeck({ root, id: 'completing', deck: deck(true) });
const completingClaim = claimTicket(completing.dir);
assert.ok(completingClaim !== null);
const completingRequest = startVisualRequest({
  root,
  dir: completing.dir,
  claimToken: completingClaim.token,
  request: { requestId: randomUUID(), generationId: randomUUID(), interaction: { id: 'one', title: 'One', subtitle: 'One requires your attention.', options: [] } },
}).request;
await completeDeck(completing.dir, [], completingClaim.token);
assert.equal(readVisualRequest(root, completing.dir, completingRequest.requestId)?.state, 'canceled', 'primary completion persists Visual cancellation before publishing its owner delivery');

rmSync(temp, { recursive: true, force: true });
console.log('visual controller tests passed');
