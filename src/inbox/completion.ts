import { mkdirSync, readdirSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { basename, resolve } from 'node:path';
import type { CompletionEvent, TicketResult } from '../types.js';
import { atomicWriteJson, deliveryErrorPath, deliveryPath, responsePath, readJson, reviewPath } from './convention.js';
import { registeredInboxRoot } from './registry.js';
import { readTicketResult, ticketRoot } from './tickets.js';
import { validateReviewDescriptor } from './deck-schema.js';

interface DeliveryReceipt { schema: 'humanloop.delivery/v1'; responsePath: string; deliveredAt: string; }
function receiptMatches(dir: string): boolean {
  const receipt = readJson<DeliveryReceipt>(deliveryPath(dir));
  return receipt?.schema === 'humanloop.delivery/v1' && receipt.responsePath === responsePath(dir);
}
function eventFor(root: string, dir: string, result: TicketResult): CompletionEvent {
  return { schema: 'humanloop.completion/v1', root, dir, ticketId: basename(dir), kind: result.kind, outcome: result.kind === 'canceled' ? 'canceled' : 'resolved', responsePath: responsePath(dir) };
}
function delay(ms: number): Promise<void> { return new Promise((resolvePromise) => setTimeout(resolvePromise, ms)); }
async function withDeliveryLock<T>(dir: string, operation: () => Promise<T>): Promise<T> {
  const lock = `${dir}/.delivery-lock`; let acquired = false;
  for (let attempt = 0; attempt < 200; attempt++) {
    try { mkdirSync(lock, { mode: 0o700 }); acquired = true; break; } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try { if (Date.now() - statSync(lock).mtimeMs > 35_000) rmSync(lock, { recursive: true, force: true }); } catch { /* holder released */ }
      await delay(10);
    }
  }
  if (!acquired) throw new Error('delivery lock acquisition timed out');
  try { return await operation(); } finally { rmSync(lock, { recursive: true, force: true }); }
}

async function runHandler(command: string, args: string[], event: CompletionEvent): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { stdio: ['pipe', 'ignore', 'ignore'] });
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 30_000);
    child.once('error', (error) => { clearTimeout(timeout); rejectPromise(error); });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      if (timedOut) rejectPromise(new Error('completion handler timed out after 30 seconds'));
      else if (code === 0) resolvePromise();
      else rejectPromise(new Error(`completion handler failed (${signal ?? code ?? 'unknown'})`));
    });
    child.stdin.end(`${JSON.stringify(event)}\n`);
  });
}

function projectReview(dir: string, result: TicketResult): void {
  if (result.kind !== 'review') return;
  const descriptor = validateReviewDescriptor(readJson<unknown>(reviewPath(dir)));
  atomicWriteJson(descriptor.output, result.result);
}

/** Deliver one canonical result. It is safe to call repeatedly after crashes. */
export async function dispatchCompletion(root: string, dir: string): Promise<'delivered' | 'pending' | 'none'> {
  const registration = registeredInboxRoot(root);
  const canonicalRoot = ticketRoot(dir);
  if (registration === null || canonicalRoot !== registration.root) throw new Error('ticket is not a canonical direct child of a registered root');
  return withDeliveryLock(resolve(dir), async () => {
    const result = readTicketResult(dir);
    if (result === null) return 'none';
    try { projectReview(dir, result); } catch (error) {
      atomicWriteJson(deliveryErrorPath(dir), { schema: 'humanloop.delivery-error/v1', responsePath: responsePath(dir), failedAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) });
      return 'pending';
    }
    if (registration.handler === undefined) return 'none';
    if (receiptMatches(dir)) return 'delivered';
    const event = eventFor(registration.root, resolve(dir), result);
    try {
      await runHandler(registration.handler.command, registration.handler.args, event);
      atomicWriteJson(deliveryPath(dir), { schema: 'humanloop.delivery/v1', responsePath: event.responsePath, deliveredAt: new Date().toISOString() } satisfies DeliveryReceipt);
      try { unlinkSync(deliveryErrorPath(dir)); } catch { /* no prior error */ }
      return 'delivered';
    } catch (error) {
      atomicWriteJson(deliveryErrorPath(dir), { schema: 'humanloop.delivery-error/v1', responsePath: event.responsePath, failedAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) });
      return 'pending';
    }
  });
}

/** Event-driven startup/root-change reconciliation for results lacking an ack. */
export async function reconcileCompletions(root: string): Promise<void> {
  const registration = registeredInboxRoot(root);
  if (registration === null) return;
  let entries: string[];
  try { entries = readdirSync(registration.root); } catch { return; }
  for (const entry of entries) {
    const dir = resolve(registration.root, entry);
    try { if (!statSync(dir).isDirectory()) continue; } catch { continue; }
    if (ticketRoot(dir) === registration.root && readTicketResult(dir) !== null && !receiptMatches(dir)) await dispatchCompletion(registration.root, dir);
  }
}
