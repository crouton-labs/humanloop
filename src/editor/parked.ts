import type { FeedbackResult } from '../types.js';

export type ParkedReviewAction =
  | { type: 'submitted'; result: FeedbackResult }
  | { type: 'take-back' }
  | { type: 'cancel' };

/**
 * Park the terminal while the browser owns the review. Watches raw stdin for
 * `w` (take back) and Ctrl+C (cancel), racing those against the browser's
 * submit promise. `takeBackTarget` names the surface `w` returns to in the
 * parked notice (e.g. "nvim", "the terminal review").
 */
export async function waitForParkedReviewSubmit(
  submitted: Promise<FeedbackResult>,
  signal: AbortSignal | undefined,
  takeBackTarget: string,
): Promise<ParkedReviewAction> {
  process.stderr.write(
    '\nhumanloop: browser review handoff is active.\n' +
    '  The terminal surface is parked; the browser is the editing authority.\n' +
    `  Press w to take back into ${takeBackTarget}, or Ctrl+C to exit with an unsubmitted draft.\n\n`,
  );

  return new Promise<ParkedReviewAction>((resolveAction) => {
    const stdin = process.stdin;
    const interactive = stdin.isTTY;
    const wasRaw = stdin.isRaw;
    let settled = false;
    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort);
      if (!interactive) return;
      stdin.off('data', onData);
      if (stdin.setRawMode) stdin.setRawMode(wasRaw);
      stdin.pause();
    };
    const finish = (action: ParkedReviewAction) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolveAction(action);
    };
    const onAbort = () => finish({ type: 'cancel' });
    const onData = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      if (text === 'w' || text === 'W') finish({ type: 'take-back' });
      if (text === '\u0003') finish({ type: 'cancel' });
    };
    if (interactive) {
      stdin.setRawMode(true);
      stdin.resume();
      stdin.on('data', onData);
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    submitted.then(
      (result) => finish({ type: 'submitted', result }),
      () => finish({ type: 'cancel' }),
    );
  });
}
