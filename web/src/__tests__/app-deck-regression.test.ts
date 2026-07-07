import assert from 'node:assert/strict';
import type { Deck } from '../types.ts';

// `jsdom` ships no type declarations and `@types/jsdom` isn't a dependency
// (this test file is the only consumer) — every jsdom value below is handled
// through `globalThis as any` assignment anyway, so suppress the missing-decl
// diagnostic on this one import rather than adding a types package.
// @ts-expect-error jsdom has no bundled types and @types/jsdom isn't installed
import { JSDOM } from 'jsdom';

// ── MINOR 7: deck SPA regression coverage through the refactored App shell ──
// The phase 3 review-surface refactor (`App.tsx` now branches on
// `surface: 'deck' | 'review'`) had zero test coverage proving the deck path
// (phase 2's "unchanged" behavior, per `App.tsx`'s own doc comment) actually
// still works end-to-end through the real shell. This mounts the REAL
// `App.tsx` (not a reimplementation of its logic) in jsdom and drives it
// through fetch/WebSocket mocks. Run with the `web/` tsconfig so the `@/*`
// path aliases App.tsx and its whole component tree depend on resolve — see
// root `package.json`'s `test` script for the exact invocation
// (`tsx --tsconfig web/tsconfig.json ...`); running this file bare from the
// repo root without that flag fails to resolve `@/*` imports (tsx resolves
// tsconfig relative to `process.cwd()`, not the file's own directory).

// ── jsdom global wiring ──────────────────────────────────────────────────────
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

function makeFetchMock(deck: Deck, submitStatus: number): { calls: FetchCall[]; fetchImpl: unknown } {
  const calls: FetchCall[] = [];
  const fetchImpl = async (url: string, init?: { method?: string; body?: string }) => {
    calls.push({ url, init });
    if (url === '/api/surface') {
      return { ok: true, status: 200, json: async () => ({ kind: 'deck' }) };
    }
    if (url === '/api/interaction') {
      return { ok: true, status: 200, json: async () => ({ deck }) };
    }
    if (url === '/api/submit') {
      const ok = submitStatus >= 200 && submitStatus < 300;
      return { ok, status: submitStatus, json: async () => ({}) };
    }
    throw new Error(`unexpected fetch url in app-deck-regression test: ${url}`);
  };
  return { calls, fetchImpl };
}

// Single-interaction, single-option deck: `buildInitialState` (deckState.ts)
// starts directly at `phase: 'item-review'` (skips overview for
// single-interaction decks), and picking the one option drives
// `submitOption` -> `advanceToNextUnanswered` (phase -> 'final', nothing left
// unanswered) -> `withAutoExitCheck` -> `computeAutoExit` (phase === 'final',
// every interaction answered, the just-picked interaction isn't
// `multiSelect`) => `autoSubmit: true` in the SAME dispatch — confirmed by
// reading `deckState.ts`/`deckReducer.ts` directly rather than assuming a
// second click/confirm step is needed. `DeckSurface`'s effect watches
// `state.autoSubmit` and fires `onSubmit` immediately, so one click on "Yes"
// is expected to reach `/api/submit` with no intermediate Final-summary
// interaction required.
function makeDeckFixture(): Deck {
  return {
    title: 'Regression Deck',
    interactions: [
      {
        id: 'q1',
        title: 'Ship it?',
        subtitle: 'Body *text*',
        options: [{ id: 'yes', label: 'Yes', shortcut: 'y' }],
      },
    ],
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

// ── Scenario A: mount, render, submit (200) ─────────────────────────────────
{
  const deck = makeDeckFixture();
  const { calls, fetchImpl } = makeFetchMock(deck, 200);
  const { container, root } = await mountApp(fetchImpl);

  // 1. fetch call order: /api/surface then /api/interaction.
  assert.ok(calls.length >= 2, 'at least surface + interaction were fetched');
  assert.equal(calls[0]!.url, '/api/surface', 'first fetch is /api/surface');
  assert.equal(calls[1]!.url, '/api/interaction', 'second fetch is /api/interaction (deck path)');

  // 2. deck renders: title, interaction title, option label.
  const h1 = container.querySelector('h1');
  assert.ok(h1 !== null, 'h1 heading renders');
  assert.equal(h1!.textContent, 'Regression Deck', 'h1 shows the deck title');
  assert.ok(container.textContent?.includes('Ship it?'), 'interaction title renders');
  assert.ok(container.textContent?.includes('Yes'), 'option label renders');

  // 3. width gating: deck surface keeps max-w-3xl, never review's max-w-5xl.
  const wrapper = container.querySelector('div.mx-auto');
  assert.ok(wrapper !== null, 'top-level mx-auto shell wrapper renders');
  assert.ok(wrapper!.className.includes('max-w-3xl'), 'deck surface uses max-w-3xl');
  assert.ok(!wrapper!.className.includes('max-w-5xl'), 'deck surface does NOT pick up review\'s max-w-5xl');

  // 4. deck Markdown is NOT instrumented: ItemReview renders `interaction.subtitle`
  // via <Markdown> with no `sourceMap` prop, so `rehypeSourceSpans` never runs —
  // no `data-source-start-byte` anywhere in the deck DOM (that's a review-only
  // concern; confirmed by reading ItemReview.tsx and Markdown.tsx directly).
  assert.equal(
    container.querySelector('[data-source-start-byte]'),
    null,
    'deck subtitle/body markdown carries no source-span instrumentation',
  );

  // 5. click "Yes" -> auto-submits -> POST /api/submit with the right responses,
  // and a 200 ack shows the submitted banner.
  const optionButton = container.querySelector('[role="button"]');
  assert.ok(optionButton !== null, 'the single option row renders with role="button"');
  await act(async () => {
    optionButton!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await flushAll();
  });

  const submitCall = calls.find((c) => c.url === '/api/submit');
  assert.ok(submitCall !== undefined, 'clicking the only option auto-submitted (no separate confirm step)');
  assert.equal(submitCall!.init?.method, 'POST', 'submit is a POST');
  const submittedBody = JSON.parse(submitCall!.init!.body!) as { responses: unknown };
  assert.deepEqual(
    submittedBody.responses,
    [{ id: 'q1', selectedOptionId: 'yes' }],
    'submit payload carries the picked option in InteractionResponse shape',
  );
  assert.ok(
    container.textContent?.includes('Submitted — the terminal session will converge automatically'),
    'a 200 submit ack renders the submitted StatusBanner text',
  );

  await unmount(container, root);
}

// ── Scenario B: a SEPARATE mount where /api/submit returns 409 ─────────────
// (already-submitted race — another tab/the terminal converged first).
// `App.tsx`'s `submitDeck`: `if (!r.ok && r.status !== 409) throw ...` — a 409
// must still read as "submitted", not "error". This is flagged as the
// highest-value assertion in the whole test (the one silent-regression risk
// explicitly called out), so it gets its own fresh mount rather than being
// folded into scenario A.
{
  const deck = makeDeckFixture();
  const { calls, fetchImpl } = makeFetchMock(deck, 409);
  const { container, root } = await mountApp(fetchImpl);

  const optionButton = container.querySelector('[role="button"]');
  assert.ok(optionButton !== null, 'option row renders in the 409 scenario too');
  await act(async () => {
    optionButton!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await flushAll();
  });

  assert.ok(calls.some((c) => c.url === '/api/submit'), '409 scenario still issued the submit POST');
  assert.ok(
    container.textContent?.includes('Submitted — the terminal session will converge automatically'),
    '409 on /api/submit is treated as convergence: submitted banner renders, not an error',
  );
  assert.ok(
    !container.textContent?.includes('Something went wrong'),
    '409 on /api/submit must not fall through to the generic error banner',
  );

  await unmount(container, root);
}

// ── Scenario C: WebSocket push handling (taken-back / converged / unknown) ──
{
  const deck = makeDeckFixture();
  const { fetchImpl } = makeFetchMock(deck, 200);
  const { container, root } = await mountApp(fetchImpl);

  const ws = FakeWebSocket.instances.at(-1);
  assert.ok(ws !== undefined, 'App constructed a WebSocket on mount');
  assert.ok(ws!.onmessage !== null, 'App attached an onmessage handler');

  await act(async () => {
    ws!.onmessage!({ data: JSON.stringify({ type: 'taken-back' }) });
    await flushAll();
  });
  assert.ok(
    container.textContent?.includes('The terminal took control back'),
    'a taken-back WS push renders the taken-back StatusBanner',
  );

  await act(async () => {
    ws!.onmessage!({ data: JSON.stringify({ type: 'converged' }) });
    await flushAll();
  });
  assert.ok(
    container.textContent?.includes('The terminal took control back'),
    'converged must NOT downgrade an already-taken-back tab back to submitted (App.tsx: setStatus((s) => (s === "taken-back" ? s : "submitted")))',
  );
  assert.ok(
    !container.textContent?.includes('Submitted — the terminal session will converge automatically'),
    'the submitted banner must not appear after converged follows taken-back',
  );

  await act(async () => {
    ws!.onmessage!({ data: JSON.stringify({ type: 'something-new' }) });
    await flushAll();
  });
  assert.ok(
    container.textContent?.includes('The terminal took control back'),
    'an unknown WS message type is ignored per the protocol-growth contract: no throw, no status change',
  );

  await unmount(container, root);
}

console.log('OK: app-deck-regression (deck path through the real App shell survives the review-surface refactor)');
