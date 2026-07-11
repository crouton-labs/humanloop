import { completeReview } from './tickets.js';
import { heartbeatClaim, releaseClaim, type TicketClaim } from './claim.js';
import { progressPath } from './convention.js';
import { launchReview, type ReviewOptions } from '../editor/review.js';
import type { ReviewDescriptor, TicketResult } from '../types.js';

export interface ReviewAdapterOptions {
  dir: string;
  descriptor: ReviewDescriptor;
  claim: TicketClaim;
  editor?: ReviewOptions['editor'];
  onSubmitted?: (result: TicketResult) => Promise<void> | void;
  /** Human pressed Option/Alt+I inside the editor: close the whole inbox. */
  onClose?: () => Promise<void> | void;
}

/** Controller-owned native review child. It persists drafts but delegates the sole final write to tickets.ts. */
export class ReviewAdapter {
  private readonly abortController = new AbortController();
  private readonly heartbeat: ReturnType<typeof setInterval>;
  private running: Promise<TicketResult | null> | null = null;
  private stopped = false;

  constructor(private readonly opts: ReviewAdapterOptions) {
    this.heartbeat = setInterval(() => {
      if (!this.stopped) heartbeatClaim(this.opts.dir, this.opts.claim.token);
    }, 10_000);
  }

  start(): Promise<TicketResult | null> {
    if (this.running !== null) return this.running;
    let canonical: TicketResult | null = null;
    this.running = launchReview(this.opts.descriptor.file, {
      output: progressPath(this.opts.dir),
      jobDir: this.opts.dir,
      editor: this.opts.editor,
      signal: this.abortController.signal,
      onClose: this.opts.onClose,
      onPropose: async (proposal) => {
        if (this.stopped || this.abortController.signal.aborted) return;
        const completed = await completeReview(this.opts.dir, proposal, this.opts.claim.token);
        canonical = completed.result;
        await this.opts.onSubmitted?.(canonical);
      },
    }).then(() => canonical).finally(() => {
      clearInterval(this.heartbeat);
      releaseClaim(this.opts.dir, this.opts.claim.token);
      this.stopped = true;
    });
    return this.running;
  }

  /** Toggle, cancellation, and controller teardown all take this same path. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.abortController.abort();
    try { await this.running; } finally {
      clearInterval(this.heartbeat);
      releaseClaim(this.opts.dir, this.opts.claim.token);
    }
  }
}
