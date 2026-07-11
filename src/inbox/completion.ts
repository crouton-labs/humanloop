import { readdirSync, statSync, unlinkSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { basename, resolve } from 'node:path';
import type { CompletionEvent, TicketResult } from '../types.js';
import { atomicWriteJson, deliveryErrorPath, deliveryPath, responsePath, readJson, reviewPath, withExclusiveDirectoryLockAsync } from './convention.js';
import { registeredInboxRoot } from './registry.js';
import { readTicketResult, ticketRoot } from './tickets.js';
import { validateReviewProjection } from './deck-schema.js';

interface DeliveryReceipt { schema: 'humanloop.delivery/v1'; responsePath: string; deliveredAt: string; }
function receiptMatches(dir: string): boolean {
  const receipt = readJson<DeliveryReceipt>(deliveryPath(dir));
  return receipt?.schema === 'humanloop.delivery/v1' && receipt.responsePath === responsePath(dir);
}
function eventFor(root: string, dir: string, result: TicketResult): CompletionEvent {
  return { schema: 'humanloop.completion/v1', root, dir, ticketId: basename(dir), kind: result.kind, outcome: result.kind === 'canceled' ? 'canceled' : 'resolved', responsePath: responsePath(dir) };
}

async function runHandler(command: string, args: string[], event: CompletionEvent): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    // stdout stays ignored (a handler acknowledges by exit code, never stdout),
    // but stderr is captured so a nonzero exit surfaces the handler's own
    // diagnostics in the delivery-error record instead of a bare exit code.
    const child = spawn(command, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (chunk) => { stderr += chunk; if (stderr.length > 8192) stderr = stderr.slice(-8192); });
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 30_000);
    child.once('error', (error) => { clearTimeout(timeout); rejectPromise(error); });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      const detail = stderr.trim() === '' ? '' : `: ${stderr.trim()}`;
      if (timedOut) rejectPromise(new Error(`completion handler timed out after 30 seconds${detail}`));
      else if (code === 0) resolvePromise();
      else rejectPromise(new Error(`completion handler failed (${signal ?? code ?? 'unknown'})${detail}`));
    });
    child.stdin.end(`${JSON.stringify(event)}\n`);
  });
}

function projectReview(dir: string, result: TicketResult): void {
  if (result.kind !== 'review') return;
  const descriptor = validateReviewProjection(dir, readJson<unknown>(reviewPath(dir)));
  atomicWriteJson(descriptor.output, result.result);
}

/** Deliver one canonical result. It is safe to call repeatedly after crashes. */
export async function dispatchCompletion(root: string, dir: string): Promise<'delivered' | 'pending' | 'none'> {
  const registration = registeredInboxRoot(root);
  const canonicalRoot = ticketRoot(dir);
  if (registration === null || canonicalRoot !== registration.root) throw new Error('ticket is not a canonical direct child of a registered root');
  return withExclusiveDirectoryLockAsync(`${resolve(dir)}/.delivery-lock`, async () => {
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
