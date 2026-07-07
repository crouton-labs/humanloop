import { useEffect, useRef } from 'react';

// ── Generic, reusable keyboard primitive ────────────────────────────────────
// This file has NO deck knowledge — it's the low-level plumbing phase 3
// (nvim-review web UI) should reuse as-is: a window-level keydown listener
// with correct effect lifecycle + a helper for the one judgment call every
// "vim keys on a webpage" surface needs — whether the event target is
// something the user is actively typing into, in which case navigation
// shortcuts must get out of the way and let native text-editing behavior
// (cursor motion, selection, IME composition) win.
//
// Deck-specific bindings (`useDeckKeymap.ts`) are built ON TOP of this, not
// merged into it — phase 3's review keymap is a different key→action mapping
// entirely, but it needs exactly this same "attach one global listener,
// bail out of typing targets" foundation.

/** True when `target` is a live text-editing surface — a `<textarea>`,
 *  text-ish `<input>`, or `contenteditable` region. Callers should generally
 *  bail out of global single-key shortcuts (`j`, `k`, `n`, `p`, ...) when this
 *  is true, since the user is typing, not navigating. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'TEXTAREA') return true;
  if (target.isContentEditable) return true;
  if (tag === 'INPUT') {
    const type = (target as HTMLInputElement).type;
    return type === 'text' || type === 'search' || type === 'email' || type === 'url' || type === '';
  }
  return false;
}

/** No modifier keys held — the shape every plain single-letter vim shortcut
 *  (`j`, `n`, `c`, ...) should require, so it never shadows a real browser/OS
 *  shortcut built on Ctrl/Cmd/Alt (Cmd+F, Ctrl+W, ...). */
export function isPlainKey(e: KeyboardEvent): boolean {
  return !e.ctrlKey && !e.metaKey && !e.altKey;
}

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
