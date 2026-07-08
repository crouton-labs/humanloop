import assert from 'node:assert/strict';
import type { ReviewPayload } from '../types.ts';

// `jsdom` ships no type declarations and `@types/jsdom` isn't a dependency
// (app-deck-regression.test.ts is the other consumer) — every jsdom value
// below is handled through `globalThis as any` assignment anyway, so
// suppress the missing-decl diagnostic on this one import rather than
// adding a types package.
// @ts-expect-error jsdom has no bundled types and @types/jsdom isn't installed
import { JSDOM } from 'jsdom';

// ── Component-path regression for the Major closed by App.tsx's status
// lattice (a stale submit failure un-freezing a genuinely-terminal surface)
// ───────────────────────────────────────────────────────────────────────────
// The independent review's finding: `App`'s `status` had many independent
// writers, and `handleReviewError` was the one never made monotonic — it
// unconditionally set `status` to `'error'`, which `reviewReadOnly` excludes.
// Ordering: click Submit (status -> 'submitting', surface freezes) -> while
// the submit effect awaits `/api/review/submit`, a TERMINAL event arrives
// (`taken-back` or WS `disconnected`) so the surface is now frozen at a
// genuinely terminal status -> the OLDER submit attempt then fails (500 /
// network) -> `failSubmit()` dispatches `server/unmark-readonly` AND
// `onError()` used to unconditionally overwrite `status` with `'error'`
// (excluded from `reviewReadOnly`) -> the terminal surface became editable
// again.
//
// The fix routes every `status` write in App.tsx through one monotonic
// `transition()` (see App.tsx's status-lattice comment): 'error' (rank 2)
// can never override a terminal status (rank 4), so a stale submit failure
// can at most fail to move `status` at all. This test proves that at the
// REAL component level for both terminal events the verdict named —
// `taken-back` and WS `disconnected` — with two different stale-failure
// shapes (a 500 response, and a network-level rejection). If App.tsx's
// `transition()` guard is reverted (e.g. `statusTransitionAllowed` always
// returning `true`, restoring the old unconditional `setStatus('error')`),
// this test goes RED: the terminal banner is replaced by the generic error
// banner and the "Add comment" control reappears. Run with the `web/`
// tsconfig so the `@/*` path aliases the whole component tree depends on
// resolve — see root `package.json`'s `test` script for the exact invocation
// (`tsx --tsconfig web/tsconfig.json ...`); running this file bare from the
// repo root without that flag fails to resolve `@/*` imports.

// ── jsdom global wiring (copied from app-ws-close.test.ts) ─────────────────
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
// Supports both `onmessage` (for the taken-back push) and `onclose` (for the
// disconnected fallback), like app-ws-close.test.ts's variant.
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
  close(): void {
    this.onclose?.();
  }
}
(globalThis as any).WebSocket = FakeWebSocket;

// Load React + the real App only after the DOM globals above exist (React's
// module init reads some of them, and `act` needs `IS_REACT_ACT_ENVIRONMENT`
// set first).
const React = await import('react');
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: App } = await import('../App.tsx');

function makeReviewFixture(jobId: string): ReviewPayload {
  return {
    kind: 'review',
    file: '/abs/source.md',
    output: '/abs/source.md.feedback.json',
    jobId,
    content: 'line one\nline two\nline three\n',
    result: { file: '/abs/source.md', submitted: false, approved: false, comments: [], savedAt: '2026-07-07T00:00:00.000Z' },
    version: 1,
    activated: true,
  };
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

function noAddCommentControl(container: HTMLDivElement): boolean {
  return !Array.from(container.querySelectorAll('button')).some((b) =>
    (b.textContent ?? '').trim().startsWith('Add comment on'));
}

function surfaceIsFrozen(container: HTMLDivElement): boolean {
  const surface = container.querySelector('div.flex.flex-col.gap-4');
  return surface !== null && surface.className.includes('pointer-events-none');
}

// ── Scenario A: submit in flight -> WS 'taken-back' arrives -> the stale
// submit then fails with a 500 -> the surface must stay frozen at
// 'taken-back', not fall back to the generic error banner ─────────────────
{
  const review = makeReviewFixture('hl-stale-failure-taken-back');
  let resolveGate!: () => void;
  const gate = new Promise<void>((resolve) => { resolveGate = resolve; });
  const fetchImpl = async (url: string, init?: { method?: string; body?: string }) => {
    if (url === '/api/surface') return { ok: true, status: 200, json: async () => ({ kind: 'review' }) };
    if (url === '/api/review' && init?.method === undefined) return { ok: true, status: 200, json: async () => review };
    if (url === '/api/review/submit' && init?.method === 'POST') {
      await gate;
      return { ok: false, status: 500, json: async () => ({ error: 'boom' }) };
    }
    throw new Error(`unexpected fetch url in stale-submit-failure test (taken-back): ${url} ${init?.method ?? 'GET'}`);
  };
  const { container, root } = await mountApp(fetchImpl);

  // 1. Click Submit on a clean draft — goes straight to the submit POST
  // (no autosave to flush first), which is held open on `gate`.
  const submitButton = findButtonByText(container, (t) => t === 'Looks good — submit' || t === 'Submit review');
  await act(async () => {
    submitButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await flushAll();
  });
  assert.ok(noAddCommentControl(container), 'the surface is already frozen once submit is in flight (status: submitting)');

  // 2. While that OLDER submit is still in flight, a terminal WS event
  // arrives: the terminal took control back.
  const ws = FakeWebSocket.instances.at(-1);
  assert.ok(ws !== undefined, 'App constructed a WebSocket on mount');
  await act(async () => {
    ws!.onmessage?.({ data: JSON.stringify({ type: 'taken-back' }) });
    await flushAll();
  });
  assert.ok(container.textContent?.includes('The terminal took control back'), 'the taken-back banner renders while the stale submit is still in flight');
  assert.ok(noAddCommentControl(container), 'the surface is frozen at taken-back, before the stale submit even resolves');
  assert.ok(surfaceIsFrozen(container), 'the review surface carries the read-only marker at taken-back');

  // 3. THE regression this test exists to catch: the OLDER submit attempt
  // now fails (500) — it must NOT resurrect an editable surface or replace
  // the terminal 'taken-back' status with 'error'.
  await act(async () => {
    resolveGate();
    await flushAll();
  });

  assert.ok(
    container.textContent?.includes('The terminal took control back'),
    'THE regression this test exists to catch: a stale submit failure arriving AFTER taken-back must not overwrite the terminal banner with the generic error text',
  );
  assert.ok(
    !container.textContent?.includes('boom'),
    'the stale failure\'s error text must not surface once the surface is terminal',
  );
  assert.ok(
    noAddCommentControl(container),
    'THE regression this test exists to catch: the "Add comment" control must stay gone — a stale submit failure must not un-freeze a terminal surface',
  );
  assert.ok(surfaceIsFrozen(container), 'the review surface still carries the read-only marker after the stale failure resolves');
  assert.ok(
    (findButtonByText(container, (t) => t === 'Looks good — submit' || t === 'Submit review') as HTMLButtonElement).disabled,
    'the Submit button stays disabled — the surface never un-freezes',
  );

  await unmount(container, root);
}

// ── Scenario B: submit in flight -> WS closes (disconnected fallback) -> the
// stale submit then rejects with a network error -> the surface must stay
// frozen at 'disconnected', not fall back to the generic error banner ─────
{
  const review = makeReviewFixture('hl-stale-failure-disconnected');
  let resolveGate!: () => void;
  const gate = new Promise<void>((resolve) => { resolveGate = resolve; });
  const fetchImpl = async (url: string, init?: { method?: string; body?: string }) => {
    if (url === '/api/surface') return { ok: true, status: 200, json: async () => ({ kind: 'review' }) };
    if (url === '/api/review' && init?.method === undefined) return { ok: true, status: 200, json: async () => review };
    if (url === '/api/review/submit' && init?.method === 'POST') {
      await gate;
      throw new Error('network error');
    }
    throw new Error(`unexpected fetch url in stale-submit-failure test (disconnected): ${url} ${init?.method ?? 'GET'}`);
  };
  const { container, root } = await mountApp(fetchImpl);

  // 1. Click Submit on a clean draft — the submit POST is held open on `gate`.
  const submitButton = findButtonByText(container, (t) => t === 'Looks good — submit' || t === 'Submit review');
  await act(async () => {
    submitButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await flushAll();
  });
  assert.ok(noAddCommentControl(container), 'the surface is already frozen once submit is in flight (status: submitting)');

  // 2. While that OLDER submit is still in flight, the WS connection drops
  // with no prior convergence message — the disconnected fallback.
  const ws = FakeWebSocket.instances.at(-1);
  assert.ok(ws !== undefined, 'App constructed a WebSocket on mount');
  await act(async () => {
    ws!.close();
    await flushAll();
  });
  assert.ok(container.textContent?.includes('Connection to the terminal session closed'), 'the disconnected banner renders while the stale submit is still in flight');
  assert.ok(noAddCommentControl(container), 'the surface is frozen at disconnected, before the stale submit even resolves');
  assert.ok(surfaceIsFrozen(container), 'the review surface carries the read-only marker at disconnected');

  // 3. THE regression this test exists to catch: the OLDER submit attempt
  // now fails with a network-level rejection — it must NOT resurrect an
  // editable surface or replace the terminal 'disconnected' status with
  // 'error'.
  await act(async () => {
    resolveGate();
    await flushAll();
  });

  assert.ok(
    container.textContent?.includes('Connection to the terminal session closed'),
    'THE regression this test exists to catch: a stale submit network failure arriving AFTER disconnected must not overwrite the terminal banner with the generic error text',
  );
  assert.ok(
    !container.textContent?.includes('network error'),
    'the stale failure\'s error text must not surface once the surface is terminal',
  );
  assert.ok(
    noAddCommentControl(container),
    'THE regression this test exists to catch: the "Add comment" control must stay gone — a stale submit failure must not un-freeze a terminal surface',
  );
  assert.ok(surfaceIsFrozen(container), 'the review surface still carries the read-only marker after the stale failure resolves');
  assert.ok(
    (findButtonByText(container, (t) => t === 'Looks good — submit' || t === 'Submit review') as HTMLButtonElement).disabled,
    'the Submit button stays disabled — the surface never un-freezes',
  );

  await unmount(container, root);
}

console.log('OK: review-surface-stale-submit-failure (a stale submit failure racing a terminal taken-back/disconnected event cannot un-freeze the terminal surface or overwrite the terminal status — App.tsx\'s monotonic status lattice)');
