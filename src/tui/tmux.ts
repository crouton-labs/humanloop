import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logPopupEvent } from './log.js';

const POPUP_TITLE = 'humanloop · inbox';
const POPUP_STYLE = 'bg=#20242d';
const POPUP_BORDER_STYLE = 'fg=#5c6370';

export interface TmuxPopupTarget { socket: string; client: string; targetPane?: string; }
export type ToggleInboxPopupResult = 'opened' | 'closed' | 'other_popup' | 'ambiguous_client' | 'not_in_tmux' | 'failed';

function runtimeDirectory(): string {
  const base = process.env['XDG_RUNTIME_DIR'] || process.env['TMPDIR'] || tmpdir();
  return join(base, `humanloop-${process.getuid?.() ?? process.env['UID'] ?? 'user'}`);
}

export function popupPaths(target: TmuxPopupTarget): { controlSocket: string; startupLock: string } {
  const identity = createHash('sha256').update(`${target.socket}\0${target.client}`).digest('hex').slice(0, 16);
  const base = join(runtimeDirectory(), 'inbox');
  return { controlSocket: join(base, `${identity}.sock`), startupLock: join(base, `${identity}.lock`) };
}

function tmux(socket: string, args: string[]): string {
  return execFileSync('tmux', ['-S', socket, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function quote(value: string): string { return `'${value.replace(/'/g, `'\\''`)}'`; }

function bindingCommand(): string {
  // --quiet keeps the background `run-shell -b` binding from printing its result JSON, which
  // tmux would otherwise surface as a view-mode overlay on the active pane. The popup opening
  // is the feedback; a genuine failure still prints (see the CLI toggle action).
  return 'hl inbox toggle --quiet --tmux-socket "#{socket_path}" --tmux-client "#{client_name}" --target-pane "#{pane_id}"';
}

/** The argv crouter's tmux-binding installer binds on the root table to toggle the inbox popup.
 *  Humanloop owns the command text; crouter owns which key(s) run it (via its keybindings catalog
 *  and the single `installTmuxBindings()` manifest sweep). */
export function inboxToggleTmuxCommand(): string[] {
  return ['run-shell', '-b', bindingCommand()];
}

export function tmuxSocketFromEnvironment(): string | undefined {
  const value = process.env['TMUX'];
  return value?.split(',')[0] || undefined;
}

export function inferTmuxClient(socket: string, pane = process.env['TMUX_PANE']): string | undefined | 'ambiguous' {
  if (pane === undefined) return undefined;
  const matches = tmux(socket, ['list-clients', '-F', '#{client_name}\t#{pane_id}']).split('\n')
    .map((line) => line.split('\t')).filter((parts) => parts[1] === pane).map((parts) => parts[0]!);
  return matches.length === 1 ? matches[0] : matches.length > 1 ? 'ambiguous' : undefined;
}

function acquireStartupLock(path: string): boolean {
  try { mkdirSync(path, { mode: 0o700 }); return true; } catch { return false; }
}

export async function toggleInboxPopup(target?: Partial<TmuxPopupTarget>): Promise<ToggleInboxPopupResult> {
  const socket = target?.socket ?? tmuxSocketFromEnvironment();
  if (socket === undefined) {
    logPopupEvent('toggle.rejected', { reason: 'not_in_tmux' });
    return 'not_in_tmux';
  }
  const inferred = target?.client ?? inferTmuxClient(socket, target?.targetPane);
  if (inferred === 'ambiguous' || inferred === undefined) {
    logPopupEvent('toggle.rejected', { reason: 'ambiguous_client', socket, targetPane: target?.targetPane });
    return 'ambiguous_client';
  }
  const resolved: TmuxPopupTarget = { socket, client: inferred, targetPane: target?.targetPane };
  const paths = popupPaths(resolved);
  logPopupEvent('toggle.requested', { ...resolved, controlSocket: paths.controlSocket });
  mkdirSync(join(paths.controlSocket, '..'), { recursive: true, mode: 0o700 });
  if (await requestPopupClose(paths.controlSocket)) {
    logPopupEvent('toggle.closed', { ...resolved, controlSocket: paths.controlSocket });
    return 'closed';
  }
  // A concurrent toggle for this same client owns popup startup. This gesture
  // leaves that startup as the sole owner and reports a benign close result.
  if (!acquireStartupLock(paths.startupLock)) {
    logPopupEvent('toggle.coalesced', { ...resolved, controlSocket: paths.controlSocket });
    return 'closed';
  }
  try {
    // Re-probe under the lock so a popup that became live during lock acquisition
    // is closed through its controller rather than orphaned.
    if (await requestPopupClose(paths.controlSocket)) {
      logPopupEvent('toggle.closed', { ...resolved, controlSocket: paths.controlSocket, phase: 'locked-reprobe' });
      return 'closed';
    }
    if (existsSync(paths.controlSocket)) rmSync(paths.controlSocket, { force: true });
    const targetPaneArg = resolved.targetPane === undefined ? '' : ` --target-pane ${quote(resolved.targetPane)}`;
    const command = `${quote(process.execPath)} ${quote(fileURLToPath(new URL('../cli.js', import.meta.url)))} inbox open --control-socket ${quote(paths.controlSocket)}${targetPaneArg}`;
    const result = await launchPopup(socket, resolved, paths.controlSocket, command);
    logPopupEvent('toggle.completed', { ...resolved, controlSocket: paths.controlSocket, result });
    return result;
  } finally { rmSync(paths.startupLock, { recursive: true, force: true }); }
}

/** Connect to the control socket and, if a live popup owns it, ask it to close. Resolves true when a popup answered. */
async function requestPopupClose(controlSocket: string): Promise<boolean> {
  const { Socket } = await import('node:net');
  return new Promise<boolean>((resolve) => {
    const client = new Socket();
    const done = (value: boolean) => { client.destroy(); resolve(value); };
    client.setTimeout(300, () => done(false));
    client.once('error', () => done(false));
    client.connect(controlSocket, () => { client.end('close\n'); done(true); });
  });
}

/** Launch one popup and report `opened` only once its controller owns the control socket. */
async function launchPopup(socket: string, target: TmuxPopupTarget, controlSocket: string, command: string): Promise<ToggleInboxPopupResult> {
  const args = ['-S', socket, 'display-popup', '-E', '-c', target.client, ...inboxPopupFlags(), ...(target.targetPane === undefined ? [] : ['-t', target.targetPane]), command];
  const startedAt = Date.now();
  const child = spawn('tmux', args, { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
  logPopupEvent('popup.spawned', { ...target, controlSocket, pid: child.pid, args });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
    if (stderr.length > 8192) stderr = stderr.slice(-8192);
  });
  const exited = new Promise<ToggleInboxPopupResult>((resolve) => {
    // `display-popup -E` blocks until the popup closes. An exit before the
    // controller socket is live means tmux declined or failed the launch.
    child.once('exit', (code, signal) => {
      const result = code === 0 || /popup/i.test(stderr) ? 'other_popup' : 'failed';
      logPopupEvent('popup.exited', { ...target, controlSocket, pid: child.pid, code, signal, result, stderr: stderr.trim(), elapsedMs: Date.now() - startedAt });
      resolve(result);
    });
    child.once('error', (error) => {
      logPopupEvent('popup.error', { ...target, controlSocket, pid: child.pid, error: error.message, stderr: stderr.trim(), elapsedMs: Date.now() - startedAt });
      resolve('failed');
    });
  });
  const { Socket } = await import('node:net');
  for (let attempt = 0; attempt < 50; attempt++) {
    const outcome = await Promise.race([
      exited,
      new Promise<'opened' | 'pending'>((resolve) => {
        const probe = new Socket();
        const done = (value: 'opened' | 'pending') => { probe.destroy(); setTimeout(() => resolve(value), value === 'pending' ? 100 : 0); };
        probe.setTimeout(200, () => done('pending'));
        probe.once('error', () => done('pending'));
        probe.connect(controlSocket, () => done('opened'));
      }),
    ]);
    if (outcome === 'opened') {
      logPopupEvent('popup.opened', { ...target, controlSocket, pid: child.pid, elapsedMs: Date.now() - startedAt });
      child.unref();
      return 'opened';
    }
    if (outcome !== 'pending') return outcome;
  }
  logPopupEvent('popup.startup_timeout', { ...target, controlSocket, pid: child.pid, stderr: stderr.trim(), elapsedMs: Date.now() - startedAt });
  return 'failed';
}

/** The static tmux `display-popup` geometry and style flags; the client and target pane are added per-invocation. */
export function inboxPopupFlags(): string[] {
  return ['-w', '90%', '-h', '90%', '-b', 'rounded', '-T', POPUP_TITLE, '-s', POPUP_STYLE, '-S', POPUP_BORDER_STYLE];
}

export const inboxPopupStyle = { width: '90%', height: '90%', border: 'rounded', title: POPUP_TITLE, background: '#20242d', chrome: '#2b3245', borderColor: '#5c6370' } as const;
