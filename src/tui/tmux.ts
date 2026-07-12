import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
 *  and the single `installTmuxBindings()` manifest sweep). Humanloop no longer persists or
 *  reconciles any key itself. */
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
  if (socket === undefined) return 'not_in_tmux';
  const inferred = target?.client ?? inferTmuxClient(socket, target?.targetPane);
  if (inferred === 'ambiguous') return 'ambiguous_client';
  if (inferred === undefined) return 'ambiguous_client';
  const resolved: TmuxPopupTarget = { socket, client: inferred, targetPane: target?.targetPane };
  const paths = popupPaths(resolved);
  mkdirSync(join(paths.controlSocket, '..'), { recursive: true, mode: 0o700 });
  if (await requestPopupClose(paths.controlSocket)) return 'closed';
  // A concurrent toggle for this same client won the startup lock and is opening the popup.
  // This gesture must not launch a second one; report a benign no-op close rather than a
  // generic failure, so exactly one popup exists and the loser never exits with an error.
  if (!acquireStartupLock(paths.startupLock)) return 'closed';
  try {
    // Re-probe under the lock: between the first probe and acquiring the lock a concurrent
    // toggle may have brought a live popup up. Deleting its control socket now would orphan
    // that popup, so close it instead. The finally below releases the lock on every path.
    if (await requestPopupClose(paths.controlSocket)) return 'closed';
    if (existsSync(paths.controlSocket)) rmSync(paths.controlSocket, { force: true });
    const command = `${quote(process.execPath)} ${quote(fileURLToPath(new URL('../cli.js', import.meta.url)))} inbox open --control-socket ${quote(paths.controlSocket)}`;
    return await launchPopup(socket, resolved, paths.controlSocket, command);
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
  const child = spawn('tmux', args, { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
  const exited = new Promise<ToggleInboxPopupResult>((resolve) => {
    // `display-popup -E` blocks until our popup closes, so a successful open keeps the child
    // alive while the control socket comes up (detected below). An early exit before that means
    // the popup command never ran: tmux 3.x silently declines to stack a popup on a client that
    // already shows one (exit 0, command dropped), which is exactly the foreign-popup case the
    // design must report as `other_popup` without disturbing the existing popup or its process.
    child.once('exit', (code) => resolve(code === 0 || /popup/i.test(stderr) ? 'other_popup' : 'failed'));
    child.once('error', () => resolve('failed'));
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
    if (outcome === 'opened') { child.unref(); return 'opened'; }
    if (outcome !== 'pending') return outcome;
  }
  return 'failed';
}

/** The static tmux `display-popup` geometry and style flags; the client and target pane are added per-invocation. */
export function inboxPopupFlags(): string[] {
  return ['-w', '90%', '-h', '90%', '-b', 'rounded', '-T', POPUP_TITLE, '-s', POPUP_STYLE, '-S', POPUP_BORDER_STYLE];
}

export const inboxPopupStyle = { width: '90%', height: '90%', border: 'rounded', title: POPUP_TITLE, background: '#20242d', chrome: '#2b3245', borderColor: '#5c6370' } as const;
