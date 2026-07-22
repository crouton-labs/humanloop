import assert from 'node:assert/strict';
import type { ReviewPayload } from '../types.ts';

// `jsdom` ships no type declarations and `@types/jsdom` isn't a dependency
// (app-deck-regression.test.ts is the other consumer) — every jsdom value
// below is handled through `globalThis as any` assignment anyway, so
// suppress the missing-decl diagnostic on this one import rather than
// adding a types package.
// @ts-expect-error jsdom has no bundled types and @types/jsdom isn't installed
import { JSDOM } from 'jsdom';

// ── Component-path regression for MAJOR 1 (stale-draft auto-clobber) ───────
// The independent verdict on the phase-3 fix pass confirmed MAJOR 1 is fixed
// at the reducer level (reviewReducer.test.ts covers `draft/conflict` /
// `draft/resolve-conflict` in isolation) but flagged that nothing proves the
// REAL component wiring: that the autosave effect's trigger guard
// (`state.saveState !== 'dirty'`, in ReviewSurface.tsx) still excludes
// `'conflict'`, and that no second PUT fires until the human explicitly
// clicks "Save my edits". A future regression — e.g. someone re-adding
// `'conflict'` to that guard, or firing a resave inside the 409 branch
// itself — would sail through the reducer suite untouched.
//
// This mounts the REAL `App.tsx` (which mounts the REAL `ReviewSurface`,
// unmodified) in jsdom, in review mode, and drives a full
// dirty-edit -> debounced-PUT -> 409-conflict -> explicit-resolve ->
// second-PUT cycle through actual DOM events, matching the drive-the-real-
// component pattern established by app-deck-regression.test.ts (mounting
// `ReviewSurface` directly would need to hand-build a `ReviewPayload` +ish
// prop set anyway, so mounting through `App` costs nothing extra and also
// proves the surface-routing wiring stays intact). Run with the `web/`
// tsconfig so the `@/*` path aliases the whole component tree depends on
// resolve — see root `package.json`'s `test` script for the exact
// invocation (`tsx --tsconfig web/tsconfig.json ...`); running this file
// bare from the repo root without that flag fails to resolve `@/*` imports.

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

// This regression verifies which states arm the debounce, not its production
// duration. Shorten only the component's 700ms autosave timers so the real
// effect wiring remains covered without spending most of the test budget idle.
const TEST_AUTOSAVE_DELAY_MS = 100;
const windowSetTimeout = dom.window.setTimeout.bind(dom.window);
dom.window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) =>
  windowSetTimeout(handler, timeout === 700 ? TEST_AUTOSAVE_DELAY_MS : timeout, ...args)) as typeof dom.window.setTimeout;

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
    jobId: 'hl-review-conflict-test',
    content: 'line one\nline two\nline three\n',
    result: { file: '/abs/source.md', submitted: false, approved: false, comments: [], savedAt: '2026-07-07T00:00:00.000Z' },
    version: 1,
    activated: true,
  };
}

// The 1st PUT to /api/review/draft (the autosave triggered by the dirty
// edit) returns a 409 stale_draft; every PUT after that returns 200. This is
// what lets assertion 1 prove something real: if the component ever resent a
// second PUT off the back of the conflict itself (instead of waiting for the
// explicit "Save my edits" click), that 2nd call would ALSO 409 — but the
// call-count assertion catches the extra call regardless of what it returns.
function makeFetchMock(review: ReviewPayload): { calls: FetchCall[]; putCalls: FetchCall[]; fetchImpl: unknown } {
  const calls: FetchCall[] = [];
  const putCalls: FetchCall[] = [];
  const fetchImpl = async (url: string, init?: { method?: string; body?: string }) => {
    calls.push({ url, init });
    if (url === '/api/surface') {
      return { ok: true, status: 200, json: async () => ({ kind: 'review' }) };
    }
    if (url === '/api/review' && init?.method === undefined) {
      return { ok: true, status: 200, json: async () => review };
    }
    if (url === '/api/review/draft' && init?.method === 'PUT') {
      putCalls.push({ url, init });
      if (putCalls.length === 1) {
        return {
          ok: false,
          status: 409,
          json: async () => ({ error: 'stale_draft', version: 5, result: review.result }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ version: 6 }) };
    }
    throw new Error(`unexpected fetch url in review-surface-conflict test: ${url} ${init?.method ?? 'GET'}`);
  };
  return { calls, putCalls, fetchImpl };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
async function flushAll(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) await flush();
}
const waitPastAutosave = () => new Promise<void>((resolve) => setTimeout(resolve, TEST_AUTOSAVE_DELAY_MS + 50));

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

// ── Scenario: dirty edit -> debounced autosave -> 409 conflict -> no retry
// -> explicit "Save my edits" -> second PUT ─────────────────────────────────
{
  const review = makeReviewFixture();
  const { calls, putCalls, fetchImpl } = makeFetchMock(review);
  const { container, root } = await mountApp(fetchImpl);

  // Sanity: mounted the review surface (not the deck path).
  assert.ok(calls.some((c) => c.url === '/api/review'), 'review payload was fetched');
  assert.ok(container.textContent?.includes('humanloop — review') || container.querySelector('h1') !== null, 'review surface rendered a heading');

  // 1. Open the composer on the default active line (L1, no selection yet)
  // via the REAL "Add comment on L1" button, type a comment, and submit it
  // via the REAL composer's "Add comment" button — this is what actually
  // flips `saveState` to `dirty` and arms the autosave effect, exactly as a
  // human editing in the browser would.
  const openComposerButton = findButtonByText(container, (t) => t.startsWith('Add comment on'));
  await act(async () => {
    openComposerButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await flushAll();
  });

  const textarea = container.querySelector('textarea');
  assert.ok(textarea !== null, 'composer textarea rendered after opening the composer');
  // React's controlled-input tracking intercepts the plain `.value` setter, so
  // a direct assignment never registers as a "real" change and `onChange`
  // never fires — go through the native prototype setter (the standard jsdom
  // + React workaround) so React's value tracker sees an actual diff.
  const nativeTextareaValueSetter = Object.getOwnPropertyDescriptor(
    dom.window.HTMLTextAreaElement.prototype,
    'value',
  )!.set!;
  await act(async () => {
    nativeTextareaValueSetter.call(textarea, 'needs work');
    textarea!.dispatchEvent(new Event('input', { bubbles: true }));
    await flushAll();
  });

  const submitCommentButton = findButtonByText(container, (t) => t === 'Add comment');
  await act(async () => {
    submitCommentButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await flushAll();
  });
  assert.ok(container.textContent?.includes('unsaved'), 'saveState reads "unsaved" (dirty) right after the edit, before the debounce fires');

  // 2. Wait past the autosave debounce + let the PUT + its 409 handler
  // resolve. Exactly one PUT should have gone out.
  await act(async () => {
    await waitPastAutosave();
    await flushAll();
  });
  assert.equal(putCalls.length, 1, 'the debounced autosave issued exactly one PUT /api/review/draft');
  assert.equal(putCalls[0]!.init?.method, 'PUT', 'the autosave call is a PUT');
  const firstBody = JSON.parse(putCalls[0]!.init!.body!) as { comments: unknown[]; baseVersion: number };
  assert.equal(firstBody.comments.length, 1, 'the autosave PUT carries the one edit made');
  assert.equal(firstBody.baseVersion, review.version, 'the first autosave uses the original version as baseVersion');

  // 3. The conflict UI appears: the "Save my edits" button and its banner
  // text (reviewReducer's `draft/conflict` message).
  assert.ok(container.textContent?.includes('Save my edits'), 'the conflict banner\'s "Save my edits" button rendered');
  assert.ok(
    container.textContent?.includes('Draft changed elsewhere'),
    'the conflict banner surfaces the stale-draft notice text',
  );
  assert.ok(container.textContent?.includes('conflict'), 'the save-state label reads "conflict"');

  // 4. THE regression this test exists to catch: wait past another full
  // debounce window with NO further user action. If the autosave effect's
  // trigger guard ever regresses to include `'conflict'` (or the 409 branch
  // itself ever fires a silent resave), a second PUT would appear here. It
  // must not — the whole point of MAJOR 1's fix is that only an explicit
  // human action re-arms the save.
  await act(async () => {
    await waitPastAutosave();
    await flushAll();
  });
  assert.equal(putCalls.length, 1, 'no second PUT was issued while sitting in the conflict state — the autosave guard genuinely excludes "conflict"');

  // 5. Click "Save my edits" (dispatches `draft/resolve-conflict`, which
  // flips saveState back to `dirty` and re-arms the SAME autosave effect —
  // proving the retry path is the real effect, not a bespoke one-off).
  const saveMineButton = findButtonByText(container, (t) => t === 'Save my edits');
  await act(async () => {
    saveMineButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await flushAll();
  });
  assert.equal(putCalls.length, 1, 'clicking "Save my edits" does not itself PUT synchronously — it re-arms the debounce');

  await act(async () => {
    await waitPastAutosave();
    await flushAll();
  });
  assert.equal(putCalls.length, 2, 'the explicit "Save my edits" click drove a second PUT /api/review/draft after its own debounce');
  const secondBody = JSON.parse(putCalls[1]!.init!.body!) as { comments: unknown[]; baseVersion: number };
  assert.equal(secondBody.baseVersion, 5, 'the retry uses the server-supplied conflict version (5) as its new baseVersion');
  assert.ok(!container.textContent?.includes('Save my edits'), 'the conflict banner is gone after the retry succeeds');

  await unmount(container, root);
}

console.log('OK: review-surface-conflict (MAJOR 1 component-path regression: dirty -> autosave -> 409 conflict -> no auto-retry -> explicit resolve -> second PUT)');
