import { useEffect, useRef } from 'react';

// ── Generic, reusable keyboard primitive ────────────────────────────────────
// This file has NO deck knowledge — it's the low-level plumbing phase 3
// (nvim-review web UI) reuses as-is: a window-level keydown listener with
// correct effect lifecycle. The event predicates every "vim keys on a webpage"
// surface needs — whether the target is being typed into, modifier shape, IME
// composition — live in the DOM-free `lib/keyEvent.ts` so the React hooks here
// AND the pure keymap cores share one implementation; re-exported below so deck
// callers keep importing them from this module unchanged.
//
// Deck-specific bindings (`useDeckKeymap.ts`) are built ON TOP of this, not
// merged into it — phase 3's review keymap is a different key→action mapping
// entirely, but it needs exactly this same "attach one global listener,
// bail out of typing targets" foundation.

export { isEditableTarget, hasNoCtrlMetaAlt, hasNoModifiers, isComposingKey } from '@/lib/keyEvent';

/**
 * Attach a single `keydown` listener to `window` for the lifetime of the
 * component, always dispatching to the LATEST `handler` without re-attaching
 * the listener on every render (the ref indirection is what makes that safe —
 * callers can pass an inline closure on every render with no perf/listener-churn
 * cost). Pass `enabled: false` to fully detach (e.g. while a modal owns
 * keyboard focus).
 */
export function useGlobalKeydown(handler: (e: KeyboardEvent) => void, enabled = true): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (!enabled) return;
    const listener = (e: KeyboardEvent): void => handlerRef.current(e);
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [enabled]);
}
