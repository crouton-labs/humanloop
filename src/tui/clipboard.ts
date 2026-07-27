import { spawnSync } from 'node:child_process';

const SPAWN_TIMEOUT_MS = 3000;

function writers(): Array<[string, string[]]> {
  if (process.platform === 'darwin') return [['pbcopy', []]];
  const wayland = Boolean(process.env.WAYLAND_DISPLAY)
    || process.env.XDG_SESSION_TYPE === 'wayland';
  const xclip: [string, string[]] = ['xclip', ['-selection', 'clipboard']];
  const wlcopy: [string, string[]] = ['wl-copy', []];
  return wayland ? [wlcopy, xclip] : [xclip, wlcopy];
}

/** Write text to the system clipboard without throwing. */
export function writeClipboardText(text: string): boolean {
  for (const [command, args] of writers()) {
    const result = spawnSync(command, args, {
      input: text,
      timeout: SPAWN_TIMEOUT_MS,
      encoding: 'utf-8',
    });
    if (result.error) continue;
    if (result.status === 0) return true;
  }
  return false;
}
