import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { inboxRootsDirectory, listInboxRoots } from './registry.js';
import { reconcileCompletions } from './completion.js';
import { dispatchVisualCleanup, listVisualCleanupObligationsForRoot, reconcileStaleVisualRequestsForRoot, type VisualCleanupTask } from './visual.js';

const LEASE_STALE_MS = 300_000;

function leasePath(): string { return join(dirname(inboxRootsDirectory()), 'maintenance.lock'); }

function roots(): string[] { return listInboxRoots().filter((root) => root.available).map((root) => root.root); }

function leaseOwner(path: string): number | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(path, 'owner.json'), 'utf8')) as { pid?: unknown };
    return typeof parsed.pid === 'number' && Number.isInteger(parsed.pid) ? parsed.pid : undefined;
  } catch { return undefined; }
}

function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function staleLease(path: string): boolean {
  const owner = leaseOwner(path);
  if (owner !== undefined) return !processIsAlive(owner);
  try { return Date.now() - statSync(path).mtimeMs > LEASE_STALE_MS; } catch { return true; }
}

/** Start one detached repair pass. The lease makes repeated UI gestures free. */
export function kickInboxMaintenance(): void {
  const lease = leasePath();
  try { mkdirSync(dirname(lease), { recursive: true, mode: 0o700 }); } catch { return; }
  try { mkdirSync(lease, { mode: 0o700 }); }
  catch {
    if (!staleLease(lease)) return;
    try { rmSync(lease, { recursive: true, force: true }); mkdirSync(lease, { mode: 0o700 }); } catch { return; }
  }

  const entry = process.argv[1];
  if (entry === undefined || !existsSync(entry)) { rmSync(lease, { recursive: true, force: true }); return; }
  // A built CLI needs no parent flags. In particular, forwarding a test
  // runner's `--input-type` makes Node reject a file entrypoint. Source-mode
  // launches retain their tsx loader.
  const runtimeArgs = entry.endsWith('.ts') ? process.execArgv : [];
  const child = spawn(process.execPath, [...runtimeArgs, entry, 'inbox', '_maintain', '--lease', lease], {
    detached: true,
    stdio: 'ignore',
  });
  if (child.pid === undefined) { rmSync(lease, { recursive: true, force: true }); return; }
  try { writeFileSync(join(lease, 'owner.json'), JSON.stringify({ pid: child.pid })); }
  catch { child.kill(); rmSync(lease, { recursive: true, force: true }); return; }
  child.unref();
}

function dueTasks(allRoots: string[]): VisualCleanupTask[] {
  const tasks: VisualCleanupTask[] = [];
  for (const root of allRoots) {
    try { tasks.push(...listVisualCleanupObligationsForRoot(root)); } catch { /* malformed historical state is isolated to its root */ }
  }
  return tasks;
}

async function repairOnce(): Promise<VisualCleanupTask[]> {
  const allRoots = roots();
  for (const root of allRoots) {
    try { await reconcileCompletions(root); } catch { /* receipt remains durable for the next pass */ }
  }
  const retirements = allRoots.flatMap((root) => {
    try { return reconcileStaleVisualRequestsForRoot(root).map((entry) => entry.delivery); } catch { return []; }
  });
  await Promise.all(retirements);
  const tasks = dueTasks(allRoots);
  await Promise.all(tasks.filter((task) => Date.parse(task.nextAttemptAt) <= Date.now()).map((task) => dispatchVisualCleanup(task.root, task.dir, task.requestId)));
  return dueTasks(roots());
}

function releaseLease(lease: string): void {
  if (leaseOwner(lease) !== process.pid) return;
  rmSync(lease, { recursive: true, force: true });
}

/** Run repair and stay alive only until the durable cleanup retry queue is empty. */
export async function runInboxMaintenance(lease: string): Promise<void> {
  try {
    while (true) {
      const tasks = await repairOnce();
      const next = tasks.reduce<number | undefined>((earliest, task) => {
        const due = Date.parse(task.nextAttemptAt);
        return Number.isFinite(due) && (earliest === undefined || due < earliest) ? due : earliest;
      }, undefined);
      if (next === undefined) return;
      await new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, next - Date.now())));
    }
  } finally {
    releaseLease(lease);
  }
}
