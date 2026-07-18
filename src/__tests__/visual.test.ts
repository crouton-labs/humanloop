import assert from 'node:assert/strict';
import { mountPanel, type Deck, type InteractionResponse, type VisualProvider, type VisualRequest, type VisualResult } from '../index.js';
import { renderMarkdown } from '../render/termrender.js';
import { parseKeypress } from '../tui/terminal.js';

interface PendingVisual {
  request: VisualRequest;
  resolve(result: VisualResult): void;
  cancelCount: number;
}

const pending: PendingVisual[] = [];
const provider: VisualProvider = (request) => {
  let resolve!: (result: VisualResult) => void;
  const result = new Promise<VisualResult>((settle) => { resolve = settle; });
  const entry: PendingVisual = { request, resolve, cancelCount: 0 };
  pending.push(entry);
  return {
    result,
    cancel: () => { entry.cancelCount += 1; },
  };
};

const deck = (prefix: string): Deck => ({ interactions: [
  { id: `${prefix}-one`, title: `${prefix} one`, options: [] },
  { id: `${prefix}-two`, title: `${prefix} two`, options: [] },
] });
const send = (panel: ReturnType<typeof mountPanel>, bytes: string) => {
  const { input, key } = parseKeypress(Buffer.from(bytes));
  panel.handleKey(input, key);
};
const settlePromises = () => new Promise<void>((resolve) => setImmediate(resolve));

const panel = mountPanel({ deck: deck('old'), cols: 20, rows: 20, visualProvider: provider });
assert.equal(pending.length, 2, 'mount eagerly requests Visual once per interaction');
assert.equal(pending[0]!.request.generationId, pending[1]!.request.generationId, 'one mount shares one Visual generation');
assert.notEqual(pending[0]!.request.requestId, pending[1]!.request.requestId, 'each interaction has its own Visual request');
assert.deepEqual(Object.keys(pending[0]!.request).sort(), ['generationId', 'interaction', 'requestId'], 'the provider request is width-free');
send(panel, '\r');
send(panel, '\x1b[Z');
assert.ok(panel.render().join('\n').includes('loading context...'), 'the unresolved current interaction renders loading without blocking mount');

panel.loadDeck(deck('fresh'));
assert.deepEqual(pending.slice(0, 2).map((entry) => entry.cancelCount), [1, 1], 'deck replacement cancels every unresolved request in the old generation');
assert.equal(pending.length, 4, 'the replacement mount requests each replacement interaction once');
assert.notEqual(pending[0]!.request.generationId, pending[2]!.request.generationId, 'replacement work has a new generation identity');
send(panel, '\r');
send(panel, '\x1b[Z');
pending[0]!.resolve({ status: 'ready', markdown: 'stale old generation' });
await settlePromises();
assert.ok(!panel.render().join('\n').includes('stale old generation'), 'a late old-generation result cannot alter the replacement panel');
assert.ok(panel.render().join('\n').includes('loading context...'), 'the replacement remains governed by its own unresolved request');

const markdown = 'alpha beta gamma delta epsilon zeta eta theta iota kappa';
pending[2]!.resolve({ status: 'ready', markdown });
await settlePromises();
assert.ok(panel.render().join('\n').includes(renderMarkdown(markdown, 16)[0]!), 'ready Markdown renders at the current panel width');
panel.handleResize(40, 20);
assert.equal(pending.length, 4, 'resize performs no provider request');
assert.ok(panel.render().join('\n').includes(renderMarkdown(markdown, 36)[0]!), 'resize locally reflows retained Markdown');
panel.unmount();
assert.equal(pending[2]!.cancelCount, 0, 'a settled request is not canceled during unmount');
assert.equal(pending[3]!.cancelCount, 1, 'unmount cancels the remaining unresolved request');
pending[3]!.resolve({ status: 'ready', markdown: 'late after unmount' });
await settlePromises();
assert.deepEqual(panel.render(), [], 'a late unmounted result remains non-renderable');

let standaloneResponses: InteractionResponse[] = [];
const standalone = mountPanel({
  deck: { interactions: [{ id: 'standalone', title: 'Standalone', options: [{ id: 'yes', label: 'Yes' }] }] },
  cols: 80,
  rows: 20,
  onComplete: (responses) => { standaloneResponses = responses; },
});
assert.ok(!standalone.render().join('\n').includes('visual context unavailable'), 'absence of a provider does not manufacture a Visual error');
send(standalone, '\r');
assert.deepEqual(standaloneResponses, [{ id: 'standalone', selectedOptionId: 'yes' }], 'the panel remains answerable without a provider');
standalone.unmount();

console.log('visual tests passed');
