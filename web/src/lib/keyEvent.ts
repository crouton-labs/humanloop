// ── Pure key-event predicates ────────────────────────────────────────────────
// The judgment calls every "vim keys on a webpage" surface needs, factored out
// of `hooks/useGlobalKeydown.ts` (which re-exports them for existing deck
// callers) so both the React hooks AND the pure, DOM-free keymap cores
// (`lib/reviewKeymap.ts`) share ONE implementation instead of drifting copies.
// Every predicate is structurally typed (duck-typed) so it works identically
// against a real `KeyboardEvent`/DOM target in the browser and against the plain
// object fixtures the pure keymap tests feed it.

interface ModifierState {
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

interface ComposingState {
  isComposing?: boolean;
  keyCode?: number;
}

interface EditableTargetShape {
  tagName?: string;
  isContentEditable?: boolean;
  type?: string;
}

/** True when `target` is a live text-editing surface — a `<textarea>`,
 *  text-ish `<input>`, or `contenteditable` region. Callers should generally
 *  bail out of global single-key shortcuts (`j`, `k`, `n`, `p`, ...) when this
 *  is true, since the user is typing, not navigating. Duck-typed on `tagName`/
 *  `isContentEditable` so a non-element target (window, document, null) reads
 *  as not-editable and the pure keymap can be tested off-DOM. */
export function isEditableTarget(target: unknown): boolean {
  if (typeof target !== 'object' || target === null) return false;
  const el = target as EditableTargetShape;
  if (el.tagName === 'TEXTAREA') return true;
  if (el.isContentEditable === true) return true;
  if (el.tagName === 'INPUT') {
    const type = el.type ?? '';
    return type === 'text' || type === 'search' || type === 'email' || type === 'url' || type === '';
  }
  return false;
}

/** No Ctrl/Cmd/Alt held — the shape every plain single-letter vim shortcut
 *  (`j`, `n`, `c`, ...) should require, so it never shadows a real browser/OS
 *  shortcut built on Ctrl/Cmd/Alt (Cmd+F, Ctrl+W, ...).
 *
 *  Deliberately Shift-agnostic — `Shift+j` still counts as "plain" here. A
 *  keymap where Shift means something (e.g. the review surface's range/selection
 *  extension) must NOT reuse this for that decision — use `hasNoModifiers`
 *  instead, which also requires Shift to be up. */
export function hasNoCtrlMetaAlt(e: ModifierState): boolean {
  return !e.ctrlKey && !e.metaKey && !e.altKey;
}

/** No modifier keys held at all, Shift included — the shape a keymap should
 *  require when Shift is meaningful (e.g. Shift+click-style range extension)
 *  so a Shift-chord never gets misread as the bare shortcut. */
export function hasNoModifiers(e: ModifierState): boolean {
  return !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
}

/** True when `target` is a native `<button>` (or a button-like `<input>` —
 *  `type="button"|"submit"|"reset"`). Global single-key/Enter/Space shortcuts
 *  must bail out when this is true: a keyboard or screen-reader user who has
 *  TAB-ed focus onto a button (e.g. a composer's Cancel/Save) and presses
 *  Enter/Space expects NATIVE button activation, not a global keymap hijacking
 *  the same key into an unrelated app action. Duck-typed like `isEditableTarget`
 *  so it works off-DOM against plain fixtures in the pure keymap tests. */
export function isButtonTarget(target: unknown): boolean {
  if (typeof target !== 'object' || target === null) return false;
  const el = target as EditableTargetShape;
  if (el.tagName === 'BUTTON') return true;
  if (el.tagName === 'INPUT') {
    const type = el.type ?? '';
    return type === 'button' || type === 'submit' || type === 'reset';
  }
  return false;
}

/** True while an IME composition is in progress (`e.isComposing`, plus the
 *  legacy `keyCode === 229` some browsers still fire for the commit
 *  keystroke). Callers with a text-entry surface must check this BEFORE
 *  treating Enter/Escape/Tab as a shortcut — during composition those keys
 *  belong to the IME (confirm/cancel a candidate), not the app. */
export function isComposingKey(e: ComposingState): boolean {
  return e.isComposing === true || e.keyCode === 229;
}
