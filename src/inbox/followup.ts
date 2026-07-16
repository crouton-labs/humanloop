import { realpathSync } from 'node:fs';
import { basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicWriteJson, followupRequestPath, followupResultPath, readJson, runHandler, withExclusiveDirectoryLock } from './convention.js';
import { registeredInboxRoot } from './registry.js';
import { ticketRoot } from './tickets.js';
import { checkMarkdown } from '../render/termrender.js';

// ── Generic follow-up consultation seam (crouter-agnostic) ─────────────────
// The provider is reached only as an opaque `{command,args}` handler fed a
// JSON event on stdin. humanloop knows nothing about what answers it.

export interface FollowUpRequestEvent {
  schema: 'humanloop.followup-request/v1';
  action: 'start' | 'cancel';
  capability: 'humanloop.follow-up/v1';
  owner: string;
  root: string;
  dir: string;
  ticketId: string;
  requestId: string;
  question: string;
}

/** followup-request.json — humanloop-owned. A state machine, not delete-on-cancel;
 *  the sole writer is humanloop, always under `.followup-lock`. */
export interface FollowUpRequest {
  schema: 'humanloop.followup-request/v1';
  requestId: string;
  question: string;
  state: 'running' | 'canceled' | 'superseded' | 'terminal';
  askedAt: string;
  settledAt?: string;
}

/** followup-result.json — the provider's writer, via `submitFollowUpResult`'s
 *  compare-and-publish gate. */
export interface FollowUpResult {
  schema: 'humanloop.followup-result/v1';
  requestId: string;
  status: 'ready' | 'error';
  markdown?: string;
  error?: string;
  completedAt: string;
}

const CAPABILITY = 'humanloop.follow-up/v1' as const;

function lockPath(dir: string): string { return `${dir}/.followup-lock`; }

function requireCanonicalTicket(root: string, dir: string): { root: string; dir: string; owner: string; followUpHandler?: { command: string; args: string[] } } {
  const registration = registeredInboxRoot(root);
  let canonicalDir: string;
  try { canonicalDir = realpathSync(dir); } catch { throw new Error('ticket is not a canonical direct child of a registered root'); }
  if (registration === null || ticketRoot(canonicalDir) !== registration.root) throw new Error('ticket is not a canonical direct child of a registered root');
  return { root: registration.root, dir: canonicalDir, owner: registration.owner, followUpHandler: registration.followUpHandler };
}

function requireFollowUpHandler(root: string, dir: string): { root: string; dir: string; owner: string; followUpHandler: { command: string; args: string[] } } {
  const ticket = requireCanonicalTicket(root, dir);
  if (ticket.followUpHandler === undefined) throw new Error('root has no registered follow-up handler');
  return { ...ticket, followUpHandler: ticket.followUpHandler };
}

function normalizeResult(result: { requestId: string; status: 'ready' | 'error'; markdown?: string; error?: string }): FollowUpResult {
  const completedAt = new Date().toISOString();
  if (result.status === 'ready') {
    if (typeof result.markdown !== 'string' || result.markdown.trim().length === 0) {
      return { schema: 'humanloop.followup-result/v1', requestId: result.requestId, status: 'error', error: 'ready result requires non-empty markdown', completedAt };
    }
    const check = checkMarkdown(result.markdown);
    if (!check.ok) return { schema: 'humanloop.followup-result/v1', requestId: result.requestId, status: 'error', error: check.error, completedAt };
    return { schema: 'humanloop.followup-result/v1', requestId: result.requestId, status: 'ready', markdown: result.markdown, completedAt };
  }
  return { schema: 'humanloop.followup-result/v1', requestId: result.requestId, status: 'error', error: result.error ?? 'unknown error', completedAt };
}

/** Supersede any running request, write a fresh `running` request, and fire a
 *  best-effort `start` kickoff to the registered handler. */
export function requestFollowUp(root: string, dir: string, opts: { question: string }): FollowUpRequest {
  const { root: canonicalRoot, dir: canonicalDir, owner, followUpHandler } = requireFollowUpHandler(root, dir);
  const request: FollowUpRequest = {
    schema: 'humanloop.followup-request/v1',
    requestId: randomUUID(),
    question: opts.question,
    state: 'running',
    askedAt: new Date().toISOString(),
  };
  withExclusiveDirectoryLock(lockPath(canonicalDir), () => {
    const current = readJson<FollowUpRequest>(followupRequestPath(canonicalDir));
    if (current !== null && current.state === 'running') {
      atomicWriteJson(followupRequestPath(canonicalDir), { ...current, state: 'superseded', settledAt: new Date().toISOString() });
    }
    atomicWriteJson(followupRequestPath(canonicalDir), request);
  });
  const event: FollowUpRequestEvent = {
    schema: 'humanloop.followup-request/v1', action: 'start', capability: CAPABILITY,
    owner, root: canonicalRoot, dir: canonicalDir, ticketId: basename(canonicalDir),
    requestId: request.requestId, question: opts.question,
  };
  void runHandler(followUpHandler.command, followUpHandler.args, event).catch((error) => {
    submitFollowUpResult(canonicalRoot, canonicalDir, { requestId: request.requestId, status: 'error', error: error instanceof Error ? error.message : String(error) });
  });
  return request;
}

/** Mark the current running request `canceled` (never deleted) and best-effort
 *  notify the handler. A no-op when nothing is running. */
export function cancelFollowUp(root: string, dir: string): void {
  const { owner, root: canonicalRoot, dir: canonicalDir, followUpHandler } = requireFollowUpHandler(root, dir);
  const canceled = withExclusiveDirectoryLock(lockPath(canonicalDir), () => {
    const current = readJson<FollowUpRequest>(followupRequestPath(canonicalDir));
    if (current === null || current.state !== 'running') return null;
    atomicWriteJson(followupRequestPath(canonicalDir), { ...current, state: 'canceled', settledAt: new Date().toISOString() });
    return current;
  });
  if (canceled === null) return;
  const event: FollowUpRequestEvent = {
    schema: 'humanloop.followup-request/v1', action: 'cancel', capability: CAPABILITY,
    owner, root: canonicalRoot, dir: canonicalDir, ticketId: basename(canonicalDir),
    requestId: canceled.requestId, question: '',
  };
  void runHandler(followUpHandler.command, followUpHandler.args, event).catch(() => { /* best-effort; state is already canceled */ });
}

/** The provider's writer. Canonicalizes a registered direct-child ticket, then
 *  publishes ONLY if `result.requestId` matches the current `running` request
 *  under `.followup-lock` \u2014 the authoritative guard that a superseded/canceled
 *  writer's late answer can never clobber a newer result. A stale writer is a
 *  silent no-op. A `ready` whose markdown fails `checkMarkdown` is downgraded
 *  to an `error` result, never thrown. */
export function submitFollowUpResult(
  root: string, dir: string,
  result: { requestId: string; status: 'ready' | 'error'; markdown?: string; error?: string },
): { published: boolean } {
  const { dir: canonicalDir } = requireCanonicalTicket(root, dir);
  const normalized = normalizeResult(result);
  return withExclusiveDirectoryLock(lockPath(canonicalDir), () => {
    const current = readJson<FollowUpRequest>(followupRequestPath(canonicalDir));
    if (current === null || current.requestId !== result.requestId || current.state !== 'running') return { published: false };
    atomicWriteJson(followupResultPath(canonicalDir), normalized);
    atomicWriteJson(followupRequestPath(canonicalDir), { ...current, state: 'terminal', settledAt: normalized.completedAt });
    return { published: true };
  });
}

export function readFollowUp(dir: string): { request: FollowUpRequest | null; result: FollowUpResult | null } {
  let canonicalDir: string;
  try { canonicalDir = realpathSync(dir); } catch { return { request: null, result: null }; }
  return { request: readJson<FollowUpRequest>(followupRequestPath(canonicalDir)), result: readJson<FollowUpResult>(followupResultPath(canonicalDir)) };
}
