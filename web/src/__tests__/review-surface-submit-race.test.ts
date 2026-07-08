import assert from 'node:assert/strict';
import type { ReviewPayload } from '../types.ts';

// `jsdom` ships no type declarations and `@types/jsdom` isn't a dependency
// (app-deck-regression.test.ts is the other consumer) — every jsdom value
// below is handled through `globalThis as any` assignment anyway, so
// suppress the missing-decl diagnostic on this one import rather than
// adding a types package.
// @ts-expect-error jsdom has no bundled types and @types/jsdom isn't installed
import { JSDOM } from 'jsdom';

// ── Component-path regression for MAJOR 3 (submit races the browser's own
// in-flight autosave) ───────────────────────────────────────────────────────
// The independent review's Major-3 finding: `pendingSaveRef` tracked an
// in-flight draft PUT, but the submit effect never awaited it. A normal user
// flow — edit, let the 700ms autosave debounce fire a draft PUT with
// baseVersion N, click Submit before that PUT returns — could reach the
// server with the submit still carrying baseVersion N after the PUT had
// already advanced the server's version to N+1, tripping a false `409
// stale_draft` against the browser's OWN save. The fix makes the submit
// effect await `pendingSaveRef.current` (or run `runDraftSave` itself if
// dirty with nothing in flight) and then submit using the exact
// `{version,comments}` that flush returned, never a stale pre-save snapshot.
//
// This mounts the REAL `App.tsx` (which mounts the REAL `ReviewSurface`,
// unmodified) in jsdom, dirties a comment through actual DOM events, waits
// out the REAL 700ms autosave debounce so the draft PUT fires for real (not
// bypassed via the take-back-ping's immediate-flush path — this is
// deliberately the plain autosave race, not the take-back handshake), holds
// that PUT open on a gate, clicks Submit while it is still in flight, then
// resolves the gate — and asserts the submit POST is only sent AFTER the
// draft PUT resolves, carrying the version the PUT just returned. Run with
// the `web/` tsconfig so the `@/*` path aliases the whole component tree
// depends on resolve — see root `package.json`'s `test` script for the exact
// invocation (`tsx --tsconfig web/tsconfig.json ...`); running this file
// bare from the repo root without that flag fails to resolve `@/*` imports.

// ── jsdom global wiring (copied from review-surface-takeback.test.ts) ──────
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

// Matches ReviewSurface.tsx's private AUTOSAVE_DELAY_MS (700) — this test
// deliberately waits out the REAL debounce (rather than bypassing it via the
// take-back-ping path, which review-surface-takeback.test.ts already
// covers) so it exercises the plain "user clicks Submit while the ordinary
// autosave is mid-flight" race Major 3 is actually about.
const AUTOSAVE_DELAY_MS = 700;

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
    jobId: 'hl-submit-race-test',
    content: 'line one\nline two\nline three\n',
    result: { file: '/abs/source.md', submitted: false, approved: false, comments: [], savedAt: '2026-07-07T00:00:00.000Z' },
    version: 1,
    activated: true,
  };
}

// `gate`, when supplied, is an unresolved promise that PUT /api/review/draft
// blocks on before responding — lets the test hold the autosave's draft PUT
// open while it clicks Submit, so it can assert the submit POST waits for
// that PUT rather than racing it.
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
    if (url === '/api/review/submit' && init?.method === 'POST') {
      order.push('submit-post');
      return { ok: true, status: 200, json: async () => ({ ok: true, output: review.output, submittedAt: '2026-07-07T00:00:01.000Z', result: { ...review.result, submitted: true } }) };
    }
    throw new Error(`unexpected fetch url in review-surface-submit-race test: ${url} ${init?.method ?? 'GET'}`);
  };
  return { calls, order, fetchImpl };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
async function flushAll(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) await flush();
}
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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

// ── Scenario: Submit is clicked while the ordinary autosave debounce's draft
// PUT is still in flight — the submit POST must wait for it, then carry the
// version the PUT just returned, never a stale pre-save version ───────────
{
  const review = makeReviewFixture();
  let resolveGate!: () => void;
  const gate = new Promise<void>((resolve) => { resolveGate = resolve; });
  const { calls, order, fetchImpl } = makeFetchMock(review, gate);
  const { container, root } = await mountApp(fetchImpl);

  // 1. Dirty the draft via the REAL composer (mirrors review-surface-takeback.test.ts).
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
    nativeTextareaValueSetter.call(textarea, 'racing edit');
    textarea!.dispatchEvent(new Event('input', { bubbles: true }));
    await flushAll();
  });
  const submitCommentButton = findButtonByText(container, (t) => t === 'Add comment');
  await act(async () => {
    submitCommentButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await flushAll();
  });
  assert.ok(container.textContent?.includes('unsaved'), 'the draft is dirty right after the edit, before the debounce fires');
  assert.equal(order.length, 0, 'no PUT has fired yet — the 700ms autosave debounce has not elapsed');

  // 2. Wait out the REAL autosave debounce (deliberately not bypassed via
  // the take-back-ping path) so the draft PUT fires on its own, and holds
  // open on `gate`.
  await act(async () => {
    await wait(AUTOSAVE_DELAY_MS + 100);
    await flushAll();
  });
  assert.deepEqual(order, ['draft-put-start'], 'the autosave debounce fired a real draft PUT, currently held open on the gate');

  // 3. Click Submit WHILE that PUT is still in flight — the regression this
  // test exists to catch: the OLD code read `stateRef.current` directly and
  // would fire the submit POST immediately, racing the in-flight PUT.
  const submitButton = findButtonByText(container, (t) => t === 'Submit review' || t === 'Looks good — submit');
  await act(async () => {
    submitButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await flushAll();
  });
  assert.deepEqual(
    order,
    ['draft-put-start'],
    'THE regression this test exists to catch: clicking Submit while the autosave PUT is in flight must NOT fire the submit POST yet — it must wait for the PUT',
  );
  assert.ok(
    !calls.some((c) => c.url === '/api/review/submit'),
    'no submit POST has been sent while the in-flight autosave PUT is still unresolved',
  );

  // 4. Resolve the gate — the PUT completes, and only THEN should the submit
  // POST fire, carrying the version the PUT just returned (review.version +
  // 1), not the stale pre-save version (review.version).
  await act(async () => {
    resolveGate();
    await flushAll();
  });

  assert.deepEqual(
    order,
    ['draft-put-start', 'draft-put', 'submit-post'],
    'once the in-flight autosave PUT resolves, the submit POST fires strictly after it — never racing it',
  );

  const submitCall = calls.find((c) => c.url === '/api/review/submit' && c.init?.method === 'POST');
  assert.ok(submitCall !== undefined, 'the submit POST was recorded');
  const submitBody = JSON.parse(submitCall!.init!.body!) as { baseVersion: number; comments: unknown[] };
  assert.equal(
    submitBody.baseVersion,
    review.version + 1,
    'submit carries the version the in-flight autosave PUT just returned, not the stale pre-save version — this is exactly what avoids a false 409 stale_draft against the browser\'s own autosave',
  );
  assert.equal(submitBody.comments.length, 1, 'submit carries the racing edit');

  assert.ok(
    container.textContent?.includes('Submitted — the terminal session will converge automatically'),
    'the submit completes successfully with no false stale_draft conflict',
  );

  await unmount(container, root);
}

// ── Scenario: Submit freezes the review surface immediately — a second edit
// attempted while submit awaits the in-flight autosave PUT must be rejected by
// the UI (the second-round Major this scenario exists to catch: `reviewReadOnly`
// omitted 'submitting', so `ReviewSurface` stayed interactive and a post-click
// comment landed after the flush snapshot submit was about to use, silently
// dropping it). Reproduces the reviewer's exact repro: dirty comment → autosave
// PUT starts and is held open → click Submit → assert the "Add comment" control
// is gone (surface is read-only), not still offered.
{
  const review = makeReviewFixture();
  let resolveGate!: () => void;
  const gate = new Promise<void>((resolve) => { resolveGate = resolve; });
  const { order, fetchImpl } = makeFetchMock(review, gate);
  const { container, root } = await mountApp(fetchImpl);

  // 1. Dirty the draft via the real composer.
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
    nativeTextareaValueSetter.call(textarea, 'first comment');
    textarea!.dispatchEvent(new Event('input', { bubbles: true }));
    await flushAll();
  });
  const submitCommentButton = findButtonByText(container, (t) => t === 'Add comment');
  await act(async () => {
    submitCommentButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await flushAll();
  });

  // 2. Wait out the real autosave debounce so the draft PUT fires and holds
  // open on `gate`.
  await act(async () => {
    await wait(AUTOSAVE_DELAY_MS + 100);
    await flushAll();
  });
  assert.deepEqual(order, ['draft-put-start'], 'the autosave PUT is in flight, held open on the gate');

  // 3. Click Submit while that PUT is still in flight.
  const submitButton = findButtonByText(container, (t) => t === 'Submit review' || t === 'Looks good — submit');
  await act(async () => {
    submitButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await flushAll();
  });

  // 4. THE regression this scenario exists to catch: with `reviewReadOnly`
  // omitted 'submitting', the surface stayed interactive here and a second
  // "Add comment" control was still on offer — clicking it (and saving a
  // second comment) would have been silently dropped from the submit that's
  // already in flight above. Once the fix freezes the surface at
  // 'submitting', the control must be gone entirely (rendering is gated on
  // `!effectiveReadOnly`), not merely disabled.
  const addCommentButtons = Array.from(container.querySelectorAll('button')).filter((b) =>
    (b.textContent ?? '').trim().startsWith('Add comment on'));
  assert.equal(
    addCommentButtons.length,
    0,
    'the "Add comment" control must be gone while submit is awaiting the in-flight autosave — the review surface must be frozen the instant Submit is clicked, not just once the submit POST actually fires',
  );
  assert.ok(
    (submitButton as HTMLButtonElement).disabled,
    'the Submit button itself is also disabled while submit is in flight',
  );

  // 5. Release the gate so the submit completes normally and the surface
  // reaches its terminal 'submitted' state — the freeze must not deadlock the
  // happy path.
  await act(async () => {
    resolveGate();
    await flushAll();
  });
  assert.deepEqual(
    order,
    ['draft-put-start', 'draft-put', 'submit-post'],
    'submit still completes normally once the held-open autosave PUT resolves',
  );
  assert.ok(
    container.textContent?.includes('Submitted — the terminal session will converge automatically'),
    'the surface reaches the submitted terminal state, not stuck in submitting',
  );

  await unmount(container, root);
}

// ── Scenario: a submit that ERRORS must not leave the surface permanently
// frozen — freezing on 'submitting' must release again once status moves to
// 'error', or every failed submit would deadlock the tab read-only forever.
{
  const review = makeReviewFixture();
  const fetchImpl = async (url: string, init?: { method?: string; body?: string }) => {
    if (url === '/api/surface') return { ok: true, status: 200, json: async () => ({ kind: 'review' }) };
    if (url === '/api/review' && init?.method === undefined) return { ok: true, status: 200, json: async () => review };
    if (url === '/api/review/submit' && init?.method === 'POST') {
      return { ok: false, status: 500, json: async () => ({ error: 'boom' }) };
    }
    throw new Error(`unexpected fetch url in review-surface-submit-error test: ${url} ${init?.method ?? 'GET'}`);
  };
  const { container, root } = await mountApp(fetchImpl);

  // Submit with a clean draft (no comments) — goes straight to the submit
  // POST, which the mock fails with a 500.
  const submitButton = findButtonByText(container, (t) => t === 'Looks good — submit' || t === 'Submit review');
  await act(async () => {
    submitButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await flushAll();
  });

  assert.ok(container.textContent?.includes('boom'), 'the surface shows the submit error');
  const addCommentButtonsAfterError = Array.from(container.querySelectorAll('button')).filter((b) =>
    (b.textContent ?? '').trim().startsWith('Add comment on'));
  assert.equal(
    addCommentButtonsAfterError.length,
    1,
    'a failed submit must NOT leave the surface permanently frozen — the "Add comment" control must reappear once status leaves \'submitting\' for \'error\', proving the freeze released rather than deadlocking',
  );
  assert.ok(
    !(findButtonByText(container, (t) => t === 'Looks good — submit' || t === 'Submit review') as HTMLButtonElement).disabled,
    'the Submit button is re-enabled after a failed submit, not stuck disabled forever',
  );

  await unmount(container, root);
}

console.log('OK: review-surface-submit-race (Major 3: submit awaits the browser\'s own in-flight autosave PUT instead of racing it; second-round Major: submit freezes the surface immediately and releases again on a failed submit rather than deadlocking)');
