import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Deck, TicketSummary } from '../types.js';
import { inboxLayout } from '../inbox/layout.js';
import { InboxController } from '../inbox/controller.js';
import { buildInboxLines } from '../inbox/tui.js';
import { registerInboxRoot } from '../inbox/registry.js';
import { submitDeck, cancelTicketResult } from '../inbox/tickets.js';
import { scanInbox } from '../inbox/scan.js';

const key = (part: Partial<import('../tui/terminal.js').Key> = {}) => ({ ctrl: false, meta: false, upArrow: false, downArrow: false, leftArrow: false, rightArrow: false, wordLeft: false, wordRight: false, home: false, end: false, pageUp: false, pageDown: false, del: false, return: false, newline: false, escape: false, tab: false, backspace: false, ...part });
const item = (id: string): TicketSummary => ({ dir: `/tickets/${id}`, id, kind: 'deck', title: id, source: {}, blockedSince: '2025-01-01T00:00:00.000Z' });

assert.deepEqual(inboxLayout(120, 30), { mode: 'two-column', listWidth: 40, detailWidth: 79, height: 30 });
assert.equal(inboxLayout(80, 24).mode, 'list');
assert.equal(inboxLayout(80, 24, 'detail').mode, 'detail');
assert.equal(inboxLayout(59, 18).mode, 'minimum');
const crowded = Array.from({ length: 20 }, (_, index) => item(`ticket-${index}`));
const visibleRows = buildInboxLines(crowded, 40, 10, 8).join('\n');
assert.ok(visibleRows.includes('ticket-10'), 'list viewport keeps the selected ticket visible');
assert.ok(visibleRows.includes('↑') && visibleRows.includes('↓'), 'list viewport signals tickets above and below');

let rows = [item('b'), item('a')];
const stable = new InboxController({ cols: 100, rows: 24, scan: () => rows });
stable.handleKey('j', key());
assert.equal(stable.snapshot().selectedDir, '/tickets/a');
rows = [item('new'), ...rows];
stable.rescan();
assert.equal(stable.snapshot().selectedDir, '/tickets/a', 'prepend preserves selected ticket id');
rows = [item('new'), item('b')];
stable.rescan();
assert.equal(stable.snapshot().selectedDir, '/tickets/b', 'removed selection chooses prior visual index');

const temp = mkdtempSync(join(tmpdir(), 'humanloop-controller-'));
process.env.XDG_STATE_HOME = join(temp, 'state');
const root = join(temp, 'tickets');
registerInboxRoot({ root, owner: 'test' });
const deck = (id: string): Deck => ({ title: id, source: { blockedSince: new Date().toISOString() }, interactions: [{ id: 'note', title: 'Notes', options: [], allowFreetext: true }] });
const first = submitDeck({ root, id: 'first', deck: deck('first') });
const active = new InboxController({ roots: [root], cols: 100, rows: 24, completeDeck: async () => undefined });
active.activate();
active.handleKey('r', key());
for (const char of 'draft') active.handleKey(char, key());
submitDeck({ root, id: 'arrival', deck: deck('arrival') });
active.rescan();
assert.equal(active.snapshot().selectedDir, first.dir, 'arrival does not steal active selection');
assert.equal(active.snapshot().inputBuffer, 'draft', 'arrival does not alter freetext input');
cancelTicketResult(first.dir);
active.rescan();
assert.equal(active.snapshot().screen, 'list', 'cancellation invalidation returns to list');
assert.equal(active.snapshot().selectedDir !== first.dir, true);
active.close();

const navigation = submitDeck({ root, id: 'navigation', deck: { title: 'navigation', interactions: [
  { id: 'one', title: 'One', options: [{ id: 'yes', label: 'Yes', shortcut: 'y' }] },
  { id: 'two', title: 'Two', options: [{ id: 'no', label: 'No', shortcut: 'n' }] },
] } });
let finished: import('../types.js').InteractionResponse[] | undefined;
const keys = new InboxController({ roots: [root], cols: 100, rows: 24, completeDeck: async (_dir, responses) => { finished = responses; } });
while (keys.snapshot().selectedDir !== navigation.dir) keys.handleKey('j', key());
keys.activate();
keys.handleKey('', key({ escape: true }));
assert.equal(keys.snapshot().screen, 'list', 'Esc at deck top returns to the list without resolving');
keys.activate();
keys.handleKey('y', key());
keys.handleKey('q', key());
keys.handleKey('q', key());
keys.handleKey('', key({ return: true }));
await new Promise((resolve) => setImmediate(resolve));
assert.deepEqual(finished, [{ id: 'one', selectedOptionId: 'yes' }], 'q finishes the current partial deck rather than closing the inbox');
keys.close();

const notificationBody = ['Notification body that must be visible before acknowledgement.', ...Array.from({ length: 30 }, (_, index) => `- Notice detail ${index}`)].join('\n');
const notification = submitDeck({ root, id: 'notification', deck: { title: 'notification', interactions: [{ id: 'notify', title: 'Read this', kind: 'notify', subtitle: 'Read the complete notice', body: notificationBody, options: [{ id: 'ok', label: 'OK' }] }] } });
let acknowledgement: import('../types.js').InteractionResponse[] | undefined;
const notifyController = new InboxController({ roots: [root], cols: 100, rows: 24, completeDeck: async (_dir, responses) => { acknowledgement = responses; } });
while (notifyController.snapshot().selectedDir !== notification.dir) notifyController.handleKey('j', key());
assert.ok(notifyController.render().join('\n').includes('Notification body'), 'passive deck preview renders notification bodies');
assert.ok(notifyController.render().join('\n').includes('Enter') && notifyController.render().join('\n').includes('c comment'), 'preview keeps full-ticket controls visible');
notifyController.handleKey('d', key());
assert.ok(notifyController.render().join('\n').includes('↑ more above'), 'd scrolls the passive preview');
const beforeMove = notifyController.snapshot().selectedDir;
notifyController.handleKey('j', key());
const returnKey = notifyController.snapshot().selectedDir === beforeMove ? 'j' : 'k';
if (returnKey === 'j') notifyController.handleKey('k', key());
while (notifyController.snapshot().selectedDir !== notification.dir) notifyController.handleKey(returnKey, key());
assert.ok(!notifyController.render().join('\n').includes('↑ more above'), 'selection changes reset passive preview scrolling');
notifyController.handleKey('a', key());
await new Promise((resolve) => setImmediate(resolve));
assert.equal(notifyController.snapshot().screen, 'detail', 'activation opens a notification in its deck');
assert.equal(acknowledgement, undefined, 'activation does not acknowledge a notification');
notifyController.close();

const replacement = submitDeck({ root, id: 'replace', deck: { title: 'replace', interactions: [{ id: 'keep', title: 'Keep', options: [{ id: 'yes', label: 'Yes', shortcut: 'y' }] }, { id: 'drop', title: 'Drop', options: [{ id: 'no', label: 'No', shortcut: 'n' }] }] } });
const live = new InboxController({ roots: [root], cols: 100, rows: 24, completeDeck: async () => undefined });
while (live.snapshot().selectedDir !== replacement.dir) live.handleKey('j', key());
live.activate();
live.handleKey('y', key());
const replacementDeck: Deck = { title: 'replace', interactions: [{ id: 'keep', title: 'Keep', options: [{ id: 'yes', label: 'Yes', shortcut: 'y' }] }] };
await import('../inbox/convention.js').then(({ atomicWriteJson, deckPath }) => atomicWriteJson(deckPath(replacement.dir), replacementDeck));
live.reloadSelectedDeck();
assert.ok(live.render().join('\n').includes('Current: Yes'), 'deck replacement keeps surviving answer');
live.close();

const browserDeck = submitDeck({ root, id: 'browser', deck: deck('browser') });
let openedUrl: string | undefined;
let browserStopped = false;
const browserHandle = {
  url: 'http://127.0.0.1:9999/',
  port: 9999,
  activate: () => {},
  requestTakeBack: async () => {},
  stop: async () => { browserStopped = true; },
};
const browserController = new InboxController({
  roots: [root],
  cols: 100,
  rows: 24,
  completeDeck: async () => undefined,
  startDeckBrowser: async () => browserHandle,
  openBrowser: (url) => { openedUrl = url; },
});
while (browserController.snapshot().selectedDir !== browserDeck.dir) browserController.handleKey('j', key());
browserController.activate();
browserController.handleKey('w', key());
await new Promise((resolve) => setImmediate(resolve));
assert.equal(openedUrl, browserHandle.url, 'w hands an active inbox deck to the browser');
assert.ok(browserController.render().join('\n').includes('Handed off to the browser'));
browserController.handleKey('w', key());
await new Promise((resolve) => setImmediate(resolve));
assert.equal(browserStopped, true, 'w takes the inbox deck back from the browser');
assert.equal(browserController.snapshot().screen, 'detail');
browserController.close();

rmSync(temp, { recursive: true, force: true });
console.log('inbox controller tests passed');
