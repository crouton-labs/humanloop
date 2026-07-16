import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const MAX_BYTES = 5 * 1024 * 1024;
const ROTATIONS = 2;

function stateHome(): string {
  return process.env['XDG_STATE_HOME'] || join(homedir(), '.local', 'state');
}

export function popupLogPath(): string {
  return join(stateHome(), 'humanloop', 'inbox-popup.log');
}

function rotateIfNeeded(path: string, nextLineBytes: number): void {
  if (!existsSync(path)) return;
  let size: number;
  try { size = statSync(path).size; } catch { return; }
  if (size + nextLineBytes < MAX_BYTES) return;

  try { rmSync(`${path}.${ROTATIONS}`, { force: true }); } catch { /* best-effort */ }
  for (let index = ROTATIONS - 1; index >= 1; index -= 1) {
    const source = `${path}.${index}`;
    const target = `${path}.${index + 1}`;
    try { if (existsSync(source)) renameSync(source, target); } catch { /* best-effort */ }
  }
  try { renameSync(path, `${path}.1`); } catch { /* best-effort */ }
}

export function logPopupEvent(event: string, fields: Record<string, unknown> = {}): void {
  const path = popupLogPath();
  const line = JSON.stringify({ ts: new Date().toISOString(), component: 'inbox-popup', event, ...fields });
  try {
    mkdirSync(dirname(path), { recursive: true });
    rotateIfNeeded(path, Buffer.byteLength(`${line}\n`, 'utf8'));
    appendFileSync(path, `${line}\n`, 'utf8');
  } catch {
    /* Logging is best-effort so the inbox shortcut remains available. */
  }
}
