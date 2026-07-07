import { X } from 'lucide-react';

const ROWS: Array<[string, string]> = [
  ['j / k / ↓ / ↑', 'move active source line'],
  ['shift+j/k or shift+↓/↑', 'extend a keyboard range'],
  ['gg / G', 'first / last source line'],
  ['space then c', 'comment on the active line or selection'],
  ['drag text', 'select rendered markdown and open a source-backed comment'],
  ['space then l', 'toggle comment list'],
  ['space then u', 'undo last comment'],
  ['space then s', 'submit final review'],
  ['u / d / PageUp / PageDown', 'scroll document'],
  ['?', 'toggle this help'],
];

export function ReviewHelpOverlay({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-lg border border-border bg-card p-5 shadow-lg" onClick={(event) => event.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Review keyboard shortcuts</h2>
          <button type="button" onClick={onClose} aria-label="Close review keyboard shortcuts" className="text-muted-foreground hover:text-foreground">
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
      </div>
    </div>
  );
}
