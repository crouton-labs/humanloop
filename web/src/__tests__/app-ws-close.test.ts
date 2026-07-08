import assert from 'node:assert/strict';
import type { Deck, ReviewPayload } from '../types.ts';

// `jsdom` ships no type declarations and `@types/jsdom` isn't a dependency
// (app-deck-regression.test.ts and review-surface-conflict.test.ts are the
// other consumers) — every jsdom value below is handled through
// `globalThis as any` assignment anyway, so suppress the missing-decl
// diagnostic on this one import rather than adding a types package.
// @ts-expect-error jsdom has no bundled types and @types/jsdom isn't installed
import { JSDOM } from 'jsdom';

// ── Finding 3 (SPA-side): the WS `onclose` fallback ─────────────────────────
// The server-side half of Finding 3 (browser-server.test.ts) proves
// taken-back/converged broadcasts survive teardown. But if the frame is
// STILL somehow lost — a network hiccup, or the terminal process itself
// crashing mid-handoff without ever broadcasting — the SPA had no fallback
// at all: `App.tsx`'s WS handler only reacted to `onmessage`, so a tab whose
// socket just closes with no prior convergence message stayed stuck in
// `'ready'` forever (editable, autosaving into a void). This mounts the REAL
// `App.tsx` in jsdom, in review mode, closes the WS without ever sending
// `taken-back`/`converged`, and asserts the SPA falls back to the
// `'disconnected'` status: the StatusBanner text renders and the review
// surface reads read-only. Run with the `web/` tsconfig so the `@/*` path
// aliases the whole component tree depends on resolve — see root
// `package.json`'s `test` script for the exact invocation
// (`tsx --tsconfig web/tsconfig.json ...`); running this file bare from the
// repo root without that flag fails to resolve `@/*` imports.

// ── jsdom global wiring (copied from app-deck-regression.test.ts) ──────────
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
// Extends the app-deck-regression.test.ts pattern with `onclose` support: a
// settable field the test can invoke directly to simulate a lost/closed
// connection without ever having sent a taken-back/converged message first.
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
    jobId: 'hl-ws-close-test',
    content: 'line one\nline two\nline three\n',
    result: { file: '/abs/source.md', submitted: false, approved: false, comments: [], savedAt: '2026-07-07T00:00:00.000Z' },
    version: 1,
    activated: true,
  };
}

// `gate`, when supplied, is an unresolved promise the `/api/review` fetch
// blocks on before responding — lets a test hold the initial-load fetch open
// so it can invoke `ws.onclose()` first (landing a terminal 'disconnected'
// status) and only then let the deferred fetch resolve, reproducing the
// Major-2 early-load race (the reviewer's own repro reproduced this on the
// deck variant; see `makeDeckFetchMock` below for that half).
function makeFetchMock(review: ReviewPayload, gate?: Promise<void>): { calls: FetchCall[]; fetchImpl: unknown } {
  const calls: FetchCall[] = [];
  const fetchImpl = async (url: string, init?: { method?: string; body?: string }) => {
    calls.push({ url, init });
    if (url === '/api/surface') {
      return { ok: true, status: 200, json: async () => ({ kind: 'review' }) };
    }
    if (url === '/api/review' && init?.method === undefined) {
      if (gate) await gate;
      return { ok: true, status: 200, json: async () => review };
    }
    throw new Error(`unexpected fetch url in app-ws-close test: ${url} ${init?.method ?? 'GET'}`);
  };
  return { calls, fetchImpl };
}

function makeDeckFixture(): Deck {
  return {
    title: 'WS-Close Deck',
    interactions: [
      {
        id: 'q1',
        title: 'Ship it?',
        options: [{ id: 'yes', label: 'Yes', shortcut: 'y' }],
      },
    ],
  };
}

// Same gate pattern as `makeFetchMock` above, but for the deck path's
// `/api/interaction` fetch — the reviewer's own repro was specifically this
// variant, so it gets its own mock rather than overloading the review one.
function makeDeckFetchMock(deck: Deck, gate?: Promise<void>): { calls: FetchCall[]; fetchImpl: unknown } {
  const calls: FetchCall[] = [];
  const fetchImpl = async (url: string, init?: { method?: string; body?: string }) => {
    calls.push({ url, init });
    if (url === '/api/surface') {
      return { ok: true, status: 200, json: async () => ({ kind: 'deck' }) };
    }
    if (url === '/api/interaction') {
      if (gate) await gate;
      return { ok: true, status: 200, json: async () => ({ deck }) };
    }
    throw new Error(`unexpected fetch url in app-ws-close test: ${url} ${init?.method ?? 'GET'}`);
  };
  return { calls, fetchImpl };
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

// ── Scenario: WS closes with no prior taken-back/converged message ─────────
{
  const review = makeReviewFixture();
  const { calls, fetchImpl } = makeFetchMock(review);
  const { container, root } = await mountApp(fetchImpl);

  assert.ok(calls.some((c) => c.url === '/api/review'), 'the review payload was fetched');

  const ws = FakeWebSocket.instances.at(-1);
  assert.ok(ws !== undefined, 'App constructed a WebSocket on mount');
  assert.ok(ws!.onclose !== null, 'App attached an onclose handler');

  // Sanity: before the close, the surface is live/editable — the "Add
  // comment" affordance renders and the surface carries no read-only marker.
  assert.ok(
    container.textContent?.includes('Add comment on'),
    'before the WS closes, the review surface is editable ("Add comment" affordance renders)',
  );
  const surfaceBefore = container.querySelector('div.flex.flex-col.gap-4');
  assert.ok(surfaceBefore !== null, 'the review surface wrapper renders');
  assert.ok(
    !surfaceBefore!.className.includes('pointer-events-none'),
    'before the WS closes, the review surface carries no read-only marker',
  );

  // The lost/closed connection: invoke onclose directly, without the app
  // ever having received a taken-back or converged message.
  await act(async () => {
    ws!.close();
    await flushAll();
  });

  assert.ok(
    container.textContent?.includes('Connection to the terminal session closed'),
    'a WS close with no prior convergence message renders the disconnected StatusBanner text',
  );
  assert.ok(
    !container.textContent?.includes('The terminal took control back'),
    'disconnected is a distinct status from taken-back (onclose alone cannot disambiguate which convergence happened)',
  );
  assert.ok(
    !container.textContent?.includes('Submitted — the terminal session will converge automatically'),
    'disconnected must not be confused with a successful submit',
  );

  const surfaceAfter = container.querySelector('div.flex.flex-col.gap-4');
  assert.ok(surfaceAfter !== null, 'the review surface wrapper still renders after disconnect');
  assert.ok(
    surfaceAfter!.className.includes('pointer-events-none'),
    'after the WS closes, the review surface reads read-only (pointer-events-none from reviewReadOnly)',
  );
  assert.ok(
    !container.textContent?.includes('Add comment on'),
    'after the WS closes, the "Add comment" affordance is gone (readOnly hides it)',
  );

  await unmount(container, root);
}

// ── Scenario: WS closes AFTER a prior taken-back status — must not downgrade ─
{
  const review = makeReviewFixture();
  const { fetchImpl } = makeFetchMock(review);
  const { container, root } = await mountApp(fetchImpl);

  const ws = FakeWebSocket.instances.at(-1);
  assert.ok(ws !== undefined, 'App constructed a WebSocket on mount');

  await act(async () => {
    ws!.onmessage?.({ data: JSON.stringify({ type: 'taken-back' }) });
    await flushAll();
  });
  assert.ok(container.textContent?.includes('The terminal took control back'), 'taken-back status renders its own banner before any close');

  await act(async () => {
    ws!.close();
    await flushAll();
  });

  assert.ok(
    container.textContent?.includes('The terminal took control back'),
    'a later WS close must not downgrade a prior taken-back status to generic disconnected',
  );
  assert.ok(
    !container.textContent?.includes('Connection to the terminal session closed'),
    'the disconnected banner must not replace the more specific taken-back banner',
  );

  await unmount(container, root);
}

// ── Scenario: WS closes AFTER a prior converged/submitted status — must not downgrade ─
{
  const review = makeReviewFixture();
  const { fetchImpl } = makeFetchMock(review);
  const { container, root } = await mountApp(fetchImpl);

  const ws = FakeWebSocket.instances.at(-1);
  assert.ok(ws !== undefined, 'App constructed a WebSocket on mount');

  await act(async () => {
    ws!.onmessage?.({ data: JSON.stringify({ type: 'converged' }) });
    await flushAll();
  });
  assert.ok(
    container.textContent?.includes('Submitted — the terminal session will converge automatically'),
    'converged status renders its own submitted banner before any close',
  );

  await act(async () => {
    ws!.close();
    await flushAll();
  });

  assert.ok(
    container.textContent?.includes('Submitted — the terminal session will converge automatically'),
    'a later WS close must not downgrade a prior converged/submitted status to generic disconnected',
  );
  assert.ok(
    !container.textContent?.includes('Connection to the terminal session closed'),
    'the disconnected banner must not replace the more specific submitted banner',
  );

  await unmount(container, root);
}

// ── Scenario: early-load race, DECK path — onclose lands BEFORE the initial
// /api/interaction fetch resolves (Major 2) ────────────────────────────────
// The independent review's own repro: the fetch chain and the WS effect run
// independently, so a WS onclose can set status to 'disconnected' while
// /api/interaction is still in flight; the OLD code's unconditional
// `setStatus('ready')` in that fetch's `.then()` continuation would then
// stomp the terminal 'disconnected' status back to editable the instant the
// late fetch resolved. The fix (App.tsx) makes that write functional and
// monotonic: `setStatus((s) => (s === 'loading' ? 'ready' : s))`.
{
  const deck = makeDeckFixture();
  let resolveGate!: () => void;
  const gate = new Promise<void>((resolve) => { resolveGate = resolve; });
  const { calls, fetchImpl } = makeDeckFetchMock(deck, gate);
  const { container, root } = await mountApp(fetchImpl);

  assert.ok(calls.some((c) => c.url === '/api/interaction'), 'the interaction fetch was issued (though gated/pending)');
  assert.ok(
    container.textContent?.includes('Loading'),
    'while /api/interaction is still pending, the loading placeholder renders (deck has not landed yet)',
  );

  const ws = FakeWebSocket.instances.at(-1);
  assert.ok(ws !== undefined, 'App constructed a WebSocket on mount');

  // The onclose fallback fires strictly BEFORE the deferred /api/interaction
  // resolves — this ordering is the whole point of the race.
  await act(async () => {
    ws!.close();
    await flushAll();
  });
  assert.ok(
    container.textContent?.includes('Connection to the terminal session closed'),
    'onclose landing before the deck fetch resolves renders the disconnected banner',
  );

  // Now let the deferred /api/interaction resolve.
  await act(async () => {
    resolveGate();
    await flushAll();
  });

  assert.ok(
    container.textContent?.includes('Connection to the terminal session closed'),
    'THE regression this scenario exists to catch: the late-resolving deck fetch must not stomp disconnected back to ready',
  );
  assert.ok(
    container.textContent?.includes('Ship it?'),
    'the deck itself does land once the late fetch resolves (the fetch was never rejected, only delayed)',
  );
  const deckSurface = container.querySelector('div.flex.flex-col.gap-4.transition-opacity');
  assert.ok(deckSurface !== null, 'the deck surface wrapper renders once the late fetch resolves');
  assert.ok(
    deckSurface!.className.includes('pointer-events-none'),
    'the deck surface renders disabled (disabled={status !== "ready"}) — disconnected must not re-enable it',
  );

  await unmount(container, root);
}

// ── Scenario: early-load race, REVIEW path — onclose lands BEFORE the
// initial /api/review fetch resolves (Major 2) ──────────────────────────────
// Same race as above, but the review branch's continuation
// (`setStatus((s) => { if (s !== 'loading') return s; ... })`) derives one of
// submitted/pending-handoff/ready — all of which must lose to an
// already-landed terminal status exactly like the deck branch.
{
  const review = makeReviewFixture();
  let resolveGate!: () => void;
  const gate = new Promise<void>((resolve) => { resolveGate = resolve; });
  const { calls, fetchImpl } = makeFetchMock(review, gate);
  const { container, root } = await mountApp(fetchImpl);

  assert.ok(calls.some((c) => c.url === '/api/review'), 'the review fetch was issued (though gated/pending)');
  assert.ok(
    container.textContent?.includes('Loading'),
    'while /api/review is still pending, the loading placeholder renders (review has not landed yet)',
  );

  const ws = FakeWebSocket.instances.at(-1);
  assert.ok(ws !== undefined, 'App constructed a WebSocket on mount');

  await act(async () => {
    ws!.close();
    await flushAll();
  });
  assert.ok(
    container.textContent?.includes('Connection to the terminal session closed'),
    'onclose landing before the review fetch resolves renders the disconnected banner',
  );

  await act(async () => {
    resolveGate();
    await flushAll();
  });

  assert.ok(
    container.textContent?.includes('Connection to the terminal session closed'),
    'THE regression this scenario exists to catch: the late-resolving review fetch must not stomp disconnected back to ready/pending-handoff/submitted',
  );
  assert.ok(
    !container.textContent?.includes('Add comment on'),
    'the review surface stays read-only once the late fetch resolves — the "Add comment" affordance never appears',
  );
  const reviewSurface = container.querySelector('div.flex.flex-col.gap-4');
  assert.ok(reviewSurface !== null, 'the review surface wrapper renders once the late fetch resolves');
  assert.ok(
    reviewSurface!.className.includes('pointer-events-none'),
    'the review surface remains read-only (pointer-events-none) once the late fetch resolves',
  );

  await unmount(container, root);
}

console.log('OK: app-ws-close (SPA falls back to the disconnected status on a lost WS frame, Finding 3; and the early-load race from a late /api/interaction or /api/review resolution cannot stomp it, Major 2)');
