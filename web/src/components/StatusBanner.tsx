export type SurfaceStatus = 'loading' | 'ready' | 'submitting' | 'submitted' | 'taking-back' | 'taken-back' | 'pending-handoff' | 'disconnected' | 'error';

/** Banners for the surface's convergence/frozen statuses: `taking-back`,
 *  `taken-back`, `submitted` (own submit or the 409 `already_submitted`
 *  race), `pending-handoff`, and `disconnected` are each a distinct status
 *  with its own copy — they render read-only but are NOT interchangeable
 *  (e.g. `disconnected` deliberately can't claim which of taken-back/
 *  converged actually happened, and `taking-back` is careful not to claim
 *  the handoff is complete yet). */
export function StatusBanner({ status, error }: { status: SurfaceStatus; error: string | null }) {
  if (status === 'taking-back') {
    return (
      <div className="rounded-md border border-amber-500/50 bg-amber-500/10 px-4 py-3 text-sm text-amber-900 dark:text-amber-200">
        Handing control back to the terminal — flushing your last edit. This page is now read-only.
      </div>
    );
  }
  if (status === 'taken-back') {
    return (
      <div className="rounded-md border border-amber-500/50 bg-amber-500/10 px-4 py-3 text-sm text-amber-900 dark:text-amber-200">
        The terminal took control back. This page is now read-only — you can close this tab.
      </div>
    );
  }
  if (status === 'pending-handoff') {
    return (
      <div className="rounded-md border border-slate-500/50 bg-slate-500/10 px-4 py-3 text-sm text-slate-900 dark:text-slate-200">
        Waiting for the terminal to hand off editing authority. Reload once <code>&lt;Space&gt;w</code> has been pressed.
      </div>
    );
  }
  if (status === 'disconnected') {
    return (
      <div className="rounded-md border border-slate-500/50 bg-slate-500/10 px-4 py-3 text-sm text-slate-900 dark:text-slate-200">
        Connection to the terminal session closed. This page is now read-only.
      </div>
    );
  }
  if (status === 'submitted') {
    return (
      <div className="rounded-md border border-emerald-500/50 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-900 dark:text-emerald-200">
        Submitted — the terminal session will converge automatically. You can close this tab.
      </div>
    );
  }
  if (status === 'error') {
    return (
      <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
        {error ?? 'Something went wrong.'}
      </div>
    );
  }
  return null;
}
