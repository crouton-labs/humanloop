export type SurfaceStatus = 'loading' | 'ready' | 'submitting' | 'submitted' | 'taken-back' | 'error';

/** Banners for the three convergence outcomes the contract defines as
 *  equivalent "go read-only" states: this tab's own successful submit, the
 *  409 `already_submitted` race (another tab/the terminal already
 *  converged), and the WS `taken-back` push. All three render the same
 *  read-only messaging via `status`. */
export function StatusBanner({ status, error }: { status: SurfaceStatus; error: string | null }) {
  if (status === 'taken-back') {
    return (
      <div className="rounded-md border border-amber-500/50 bg-amber-500/10 px-4 py-3 text-sm text-amber-900 dark:text-amber-200">
        The terminal took control back. This page is now read-only — you can close this tab.
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
