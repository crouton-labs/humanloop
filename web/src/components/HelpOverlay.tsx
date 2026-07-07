import { X } from 'lucide-react';

const ROWS: Array<[string, string]> = [
  ['j / k / ↓ / ↑', 'move focus'],
  ['n / p', 'next / previous interaction'],
  ['enter', 'pick option / confirm / advance'],
  ['space', 'toggle option (multi-select)'],
  ['a-z, 1-9', 'option shortcut (shown on each row)'],
  ['c', 'comment (on the focused option, if freetext is allowed)'],
  ['r', 'open a freetext response (freetext-only interactions)'],
  ['u / d, PageUp / PageDown', 'scroll the body'],
  ['q / esc', 'back a level'],
  ['?', 'toggle this help'],
];

/** `?`-triggered keyboard-help overlay. A plain fixed-position panel (not a
 *  focus-trapping dialog primitive) so it never fights `useDeckKeymap`'s own
 *  global listener — closing it is just another key the keymap hook already
 *  understands (`modalOpen` gate: only Escape/`?` pass through while open). */
export function HelpOverlay({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-lg border border-border bg-card p-5 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Keyboard shortcuts</h2>
          <button type="button" onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="size-4" />
          </button>
        </div>
        <dl className="flex flex-col gap-2 text-sm">
          {ROWS.map(([keys, desc]) => (
            <div key={keys} className="flex items-center justify-between gap-4">
              <dt className="font-mono text-xs text-muted-foreground">{keys}</dt>
              <dd className="text-right">{desc}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-4 text-xs text-muted-foreground">
          Everything above also works with the mouse — click an option to pick it, click a row to focus it.
        </p>
      </div>
    </div>
  );
}
