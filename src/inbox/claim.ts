import { existsSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { ClaimSummary } from '../types.js';
import { claimPath, deckPath, readJson, responsePath, reviewPath, withExclusiveDirectoryLock } from './convention.js';

export interface TicketClaim { token: string; host: string; pid: number; claimedAt: string; heartbeatAt: string; tmuxClient?: string; }
export interface ClaimOptions { host?: string; pid?: number; tmuxClient?: string; now?: Date; }
const REMOTE_STALE_MS = 30_000;

function parseClaim(raw: unknown): TicketClaim | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const claim = raw as Record<string, unknown>;
  if (typeof claim.token !== 'string' || typeof claim.host !== 'string' || !Number.isInteger(claim.pid) || typeof claim.claimedAt !== 'string' || typeof claim.heartbeatAt !== 'string') return null;
  return { token: claim.token, host: claim.host, pid: claim.pid as number, claimedAt: claim.claimedAt, heartbeatAt: claim.heartbeatAt, ...(typeof claim.tmuxClient === 'string' ? { tmuxClient: claim.tmuxClient } : {}) };
}
export function readTicketClaim(dir: string): TicketClaim | null { return parseClaim(readJson<unknown>(claimPath(dir))); }
function isLiveLocalPid(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }
export function isStaleClaim(claim: TicketClaim, now = Date.now(), localHost = hostname()): boolean {
  if (claim.host === localHost) return !isLiveLocalPid(claim.pid);
  const heartbeat = Date.parse(claim.heartbeatAt);
  return !Number.isFinite(heartbeat) || now - heartbeat > REMOTE_STALE_MS;
}

/** Acquire a visible claim only for a still-pending ticket. Malformed crash artifacts are stale claims. */
export function claimTicket(dir: string, opts: ClaimOptions = {}): TicketClaim | null {
  return withExclusiveDirectoryLock(`${dir}/.ticket-lock`, () => {
    if (existsSync(responsePath(dir)) || (!existsSync(deckPath(dir)) && !existsSync(reviewPath(dir)))) return null;
    const path = claimPath(dir);
    const existing = readTicketClaim(dir);
    if (existing !== null && !isStaleClaim(existing, Date.now(), opts.host ?? hostname())) return null;
    if (existsSync(path)) unlinkSync(path);
    const host = opts.host ?? hostname(); const pid = opts.pid ?? process.pid; const now = (opts.now ?? new Date()).toISOString();
    const claim: TicketClaim = { token: randomUUID(), host, pid, claimedAt: now, heartbeatAt: now, ...(opts.tmuxClient ? { tmuxClient: opts.tmuxClient } : {}) };
    writeFileSync(path, `${JSON.stringify(claim)}\n`, { flag: 'wx', mode: 0o600 });
    return claim;
  });
}

export function heartbeatClaim(dir: string, token: string, now = new Date()): boolean {
  return withExclusiveDirectoryLock(`${dir}/.ticket-lock`, () => {
    const claim = readTicketClaim(dir);
    if (claim === null || claim.token !== token) return false;
    const temp = `${claimPath(dir)}.${token}.heartbeat`;
    writeFileSync(temp, `${JSON.stringify({ ...claim, heartbeatAt: now.toISOString() })}\n`, { flag: 'wx', mode: 0o600 });
    renameSync(temp, claimPath(dir));
    return true;
  });
}

export function releaseClaimLocked(dir: string, token: string): boolean {
  const claim = readTicketClaim(dir);
  if (claim === null || claim.token !== token) return false;
  unlinkSync(claimPath(dir));
  return true;
}
export function releaseClaim(dir: string, token: string): boolean { return withExclusiveDirectoryLock(`${dir}/.ticket-lock`, () => releaseClaimLocked(dir, token)); }
export function claimExists(dir: string): boolean { return existsSync(claimPath(dir)); }
export function withTicketLock<T>(dir: string, operation: () => T): T { return withExclusiveDirectoryLock(`${dir}/.ticket-lock`, operation); }
