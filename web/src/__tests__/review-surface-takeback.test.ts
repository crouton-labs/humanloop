import assert from 'node:assert/strict';
import type { ReviewPayload } from '../types.ts';

// `jsdom` ships no type declarations and `@types/jsdom` isn't a dependency
// (app-deck-regression.test.ts is the other consumer) — every jsdom value
// below is handled through `globalThis as any` assignment anyway, so
// suppress the missing-decl diagnostic on this one import rather than
// adding a types package.
// @ts-expect-error jsdom has no bundled types and @types/jsdom isn't installed
import { JSDOM } from 'jsdom';

// ── Component-path regression for Finding 2b (take-back must not drop a
// pending flush) ─────────────────────────────────────────────────────────
// browser-server.test.ts's Test 9 proves the SERVER side of this contract —
// that requestTakeBack() waits for the ack, and the ack must come after the
// dirty draft is durable — but it does so by having the test itself PUT the
// draft and POST the ack manually, simulating what a well-behaved browser is
// expected to do. It cannot catch a regression in the REAL browser-side
// logic that is supposed to do that flushing: ReviewSurface.tsx's
// `takeBackPing` effect, which is what actually issues the immediate PUT off
// a `take-back-requested` WS ping (bypassing the normal 700ms autosave
// debounce) before acking. If that effect were ever removed or neutered, the
// server-side test would still pass (it never exercises the real effect),
// but a real terminal-initiated take-back would silently drop the user's
// in-flight edit.
//
// This mounts the REAL `App.tsx` (which mounts the REAL `ReviewSurface`,
// unmodified) in jsdom, dirties a comment through actual DOM events exactly
// like a human editing in the browser, fires a `take-back-requested` WS
// ping without ever waiting out the debounce, and asserts the dirty draft is
// flushed via an immediate PUT strictly before the take-back-ack POST. Run
// with the `web/` tsconfig so the `@/*` path aliases the whole component
// tree depends on resolve — see root `package.json`'s `test` script for the
// exact invocation (`tsx --tsconfig web/tsconfig.json ...`); running this
// file bare from the repo root without that flag fails to resolve `@/*`
// imports.

// ── jsdom global wiring (copied from app-deck-regression.test.ts /
// review-surface-conflict.test.ts) ──────────────────────────────────────────
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/',
});
(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;
// Node >=21 defines a read-only global `navigator` getter (the fetch-API
// polyfill surface) — plain assignment throws "has only a getter", so this
// one needs `defineProperty` to actually replace it with jsdom's navigator.
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
(globalThis as any).location = dom.window.location;
(globalThis as any).HTMLElement = dom.window.HTMLElement;
(globalThis as any).Node = dom.window.Node;
(globalThis as any).Element = dom.window.Element;
(globalThis as any).getComputedStyle = dom.window.getComputedStyle;
(globalThis as any).MouseEvent = dom.window.MouseEvent;
(globalThis as any).Event = dom.window.Event;
(globalThis as any).requestAnimationFrame = dom.window.requestAnimationFrame ?? ((cb: FrameRequestCallback) => setTimeout(cb, 0));
(globalThis as any).cancelAnimationFrame = dom.window.cancelAnimationFrame ?? clearTimeout;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// ── FakeWebSocket ────────────────────────────────────────────────────────────
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  onmessage: ((ev: { data: string }) => void) | null = null;
  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
  close(): void {}
}
(globalThis as any).WebSocket = FakeWebSocket;

// Load React + the real App only after the DOM globals above exist (React's
// module init reads some of them, and `act` needs `IS_REACT_ACT_ENVIRONMENT`
// set first).
const React = await import('react');
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: App } = await import('../App.tsx');

// ── fetch mock ───────────────────────────────────────────────────────────────
interface FetchCall {
  url: string;
  init?: { method?: string; body?: string };
}

function makeReviewFixture(): ReviewPayload {
  return {
    kind: 'review',
    file: '/abs/source.md',
    output: '/abs/source.md.feedback.json',
    jobId: 'hl-takeback-test',
    content: 'line one\nline two\nline three\n',
    result: { file: '/abs/source.md', submitted: false, approved: false, comments: [], savedAt: '2026-07-07T00:00:00.000Z' },
    version: 1,
    activated: true,
  };
}

// `gate`, when supplied, is an unresolved promise that PUT /api/review/draft
// blocks on before responding — lets a test hold the flush PUT open to
// inspect the surface mid-flush, before it resolves (the handshake window
// Major 1 requires the surface to already be frozen through).
function makeFetchMock(
  review: ReviewPayload,
  gate?: Promise<void>,
): { calls: FetchCall[]; order: string[]; fetchImpl: unknown } {
  const calls: FetchCall[] = [];
  const order: string[] = [];
  const fetchImpl = async (url: string, init?: { method?: string; body?: string }) => {
    calls.push({ url, init });
    if (url === '/api/surface') {
      return { ok: true, status: 200, json: async () => ({ kind: 'review' }) };
    }
    if (url === '/api/review' && init?.method === undefined) {
      return { ok: true, status: 200, json: async () => review };
    }
    if (url === '/api/review/draft' && init?.method === 'PUT') {
      order.push('draft-put-start');
      if (gate) await gate;
      order.push('draft-put');
      return { ok: true, status: 200, json: async () => ({ version: review.version + 1 }) };
    }
    if (url === '/api/review/take-back-ack' && init?.method === 'POST') {
      order.push('take-back-ack');
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    throw new Error(`unexpected fetch url in review-surface-takeback test: ${url} ${init?.method ?? 'GET'}`);
  };
  return { calls, order, fetchImpl };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
async function flushAll(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) await flush();
}

async function mountApp(fetchImpl: unknown): Promise<{ container: HTMLDivElement; root: import('react-dom/client').Root }> {
  (globalThis as any).fetch = fetchImpl;
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(App));
    await flushAll();
  });
  return { container, root };
}

async function unmount(container: HTMLDivElement, root: import('react-dom/client').Root): Promise<void> {
  await act(async () => {
    root.unmount();
  });
  container.remove();
}

function findButtonByText(container: HTMLDivElement, matcher: (text: string) => boolean): HTMLButtonElement {
  const buttons = Array.from(container.querySelectorAll('button'));
  const found = buttons.find((b) => matcher((b.textContent ?? '').trim()));
  assert.ok(found !== undefined, `expected a button matching ${matcher.toString()}`);
  return found as HTMLButtonElement;
}

// ── Scenario: a dirty edit is flushed via an immediate PUT before the
// take-back-ack POST, bypassing the 700ms autosave debounce ────────────────
{
  const review = makeReviewFixture();
  const { calls, order, fetchImpl } = makeFetchMock(review);
  const { container, root } = await mountApp(fetchImpl);

  assert.ok(calls.some((c) => c.url === '/api/review'), 'the review payload was fetched');

  // 1. Dirty the draft via the REAL composer (mirrors review-surface-conflict.test.ts).
  const openComposerButton = findButtonByText(container, (t) => t.startsWith('Add comment on'));
  await act(async () => {
    openComposerButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await flushAll();
  });
  const textarea = container.querySelector('textarea');
  assert.ok(textarea !== null, 'composer textarea rendered after opening the composer');
  const nativeTextareaValueSetter = Object.getOwnPropertyDescriptor(
    dom.window.HTMLTextAreaElement.prototype,
    'value',
  )!.set!;
  await act(async () => {
    nativeTextareaValueSetter.call(textarea, 'urgent edit');
    textarea!.dispatchEvent(new Event('input', { bubbles: true }));
    await flushAll();
  });
  const submitCommentButton = findButtonByText(container, (t) => t === 'Add comment');
  await act(async () => {
    submitCommentButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await flushAll();
  });
  assert.ok(container.textContent?.includes('unsaved'), 'the draft is dirty right after the edit, before the debounce fires');
  assert.equal(order.length, 0, 'no PUT/ack has fired yet — no real time has passed and no take-back ping has arrived');

  // 2. Fire a take-back-requested WS ping — the real server message shape
  // (App.tsx's WS handler bumps takeBackPing on this, exactly like the
  // production `requestTakeBack()` broadcast).
  const ws = FakeWebSocket.instances.at(-1);
  assert.ok(ws !== undefined, 'App constructed a WebSocket on mount');
  await act(async () => {
    ws!.onmessage?.({ data: JSON.stringify({ type: 'take-back-requested' }) });
    await flushAll();
  });

  // 3. THE regression this test exists to catch: the dirty draft must be
  // flushed via an IMMEDIATE PUT off the ping — bypassing the 700ms autosave
  // debounce, which was deliberately never waited out above — and that PUT
  // must land strictly BEFORE the take-back-ack POST. The
  // browser-server.test.ts server-side test (Test 9) simulates this exact
  // sequence itself, so it can't catch a reverted ReviewSurface takeBackPing
  // effect; only driving the REAL component proves it. If the effect were
  // removed, `order` would stay empty (no debounce has elapsed). If ack
  // fired before the flush, `order` would read ['take-back-ack', ...] or
  // omit 'draft-put' entirely.
  assert.deepEqual(
    order,
    ['draft-put-start', 'draft-put', 'take-back-ack'],
    'the dirty draft is flushed via an immediate PUT, strictly before the take-back-ack POST, bypassing the 700ms debounce',
  );

  const putCall = calls.find((c) => c.url === '/api/review/draft' && c.init?.method === 'PUT');
  assert.ok(putCall !== undefined, 'the flush PUT was recorded');
  const putBody = JSON.parse(putCall!.init!.body!) as { comments: unknown[] };
  assert.equal(putBody.comments.length, 1, 'the flush PUT carries the dirty edit');

  await unmount(container, root);
}

// ── Scenario: the surface freezes THE INSTANT take-back-requested arrives —
// before the flush PUT even resolves, not just once the later taken-back
// message lands (Major 1) ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// The independent review's Major-1 finding: receiving take-back-requested
// used to only bump takeBackPing — nothing made the SPA read-only until the
// LATER taken-back message arrived (after the flush + ack round trip). A
// user could add/edit/submit a comment during that whole handshake window
// and the edit would never make it into the forced-save snapshot. The fix
// (App.tsx) sets status to 'taking-back' in the SAME state update as the
// takeBackPing bump, so `reviewReadOnly` — and therefore the composer/submit
// controls — freezes on the very render that kicks off the flush, not on
// some later message.
//
// This holds the flush PUT open on a manually-resolved gate so the test can
// inspect the surface mid-handshake, strictly before the PUT (let alone the
// ack) has resolved, and assert it is ALREADY frozen. If the fix were
// reverted (take-back-requested only bumping takeBackPing, with no status
// change), the surface stays editable through this whole window — the
// composer button remains present and pointer-events-none is absent — which
// is exactly what this test would catch.
{
  const review = makeReviewFixture();
  let resolveGate!: () => void;
  const gate = new Promise<void>((resolve) => { resolveGate = resolve; });
  const { order, fetchImpl } = makeFetchMock(review, gate);
  const { container, root } = await mountApp(fetchImpl);

  // 1. Dirty the draft via the REAL composer.
  const openComposerButton = findButtonByText(container, (t) => t.startsWith('Add comment on'));
  await act(async () => {
    openComposerButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await flushAll();
  });
  const textarea = container.querySelector('textarea');
  assert.ok(textarea !== null, 'composer textarea rendered after opening the composer');
  const nativeTextareaValueSetter = Object.getOwnPropertyDescriptor(
    dom.window.HTMLTextAreaElement.prototype,
    'value',
  )!.set!;
  await act(async () => {
    nativeTextareaValueSetter.call(textarea, 'urgent edit');
    textarea!.dispatchEvent(new Event('input', { bubbles: true }));
    await flushAll();
  });
  const submitCommentButton = findButtonByText(container, (t) => t === 'Add comment');
  await act(async () => {
    submitCommentButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await flushAll();
  });
  assert.ok(container.textContent?.includes('unsaved'), 'the draft is dirty right after the edit');

  // Sanity: before take-back-requested, the surface is still editable.
  assert.ok(
    container.textContent?.includes('Add comment on'),
    'before take-back-requested, the review surface is still editable',
  );
  const surfaceBefore = container.querySelector('div.flex.flex-col.gap-4');
  assert.ok(surfaceBefore !== null, 'the review surface wrapper renders');
  assert.ok(
    !surfaceBefore!.className.includes('pointer-events-none'),
    'before take-back-requested, the review surface carries no read-only marker',
  );

  // 2. Fire take-back-requested. The flush PUT it triggers is held open on
  // `gate` — it has started (order records 'draft-put-start') but not yet
  // resolved, so neither the PUT's own completion nor the take-back-ack POST
  // that follows it have happened yet.
  const ws = FakeWebSocket.instances.at(-1);
  assert.ok(ws !== undefined, 'App constructed a WebSocket on mount');
  await act(async () => {
    ws!.onmessage?.({ data: JSON.stringify({ type: 'take-back-requested' }) });
    await flushAll();
  });

  assert.deepEqual(
    order,
    ['draft-put-start'],
    'the flush PUT has started but is deliberately held open — neither it nor the take-back-ack POST has resolved yet',
  );

  // 3. THE regression this test exists to catch: the surface must already be
  // frozen here, strictly before the flush PUT (let alone the ack) resolves.
  assert.ok(
    container.textContent?.includes('Handing control back to the terminal'),
    'the taking-back StatusBanner renders the instant take-back-requested arrives, before the flush resolves',
  );
  assert.ok(
    !container.textContent?.includes('Add comment on'),
    'the "Add comment" affordance is already gone during the flush window — no further edit can be made',
  );
  const surfaceDuringFlush = container.querySelector('div.flex.flex-col.gap-4');
  assert.ok(surfaceDuringFlush !== null, 'the review surface wrapper still renders during the flush window');
  assert.ok(
    surfaceDuringFlush!.className.includes('pointer-events-none'),
    'the review surface is already read-only (pointer-events-none) during the flush window, before the ack — not just after the later taken-back message',
  );

  // 4. Let the flush complete and confirm the handshake still finishes.
  await act(async () => {
    resolveGate();
    await flushAll();
  });
  assert.deepEqual(
    order,
    ['draft-put-start', 'draft-put', 'take-back-ack'],
    'once unblocked, the flush PUT completes and the take-back-ack POST still follows it',
  );

  await unmount(container, root);
}

console.log('OK: review-surface-takeback (Finding 2b component-path regression, plus Major 1: the surface freezes the instant take-back-requested arrives, before the flush PUT resolves)');
