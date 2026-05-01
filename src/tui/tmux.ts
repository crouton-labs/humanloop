import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmdirSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { InteractionResponse } from '../types.js';

export interface TuiOutput {
  responses: InteractionResponse[];
  completedAt: string;
}

export interface TmuxDispatchOpts {
  sessionId?: string;
  visuals: boolean;
}


function shellQuote(s: string): string {
  if (s.length > 0 && /^[a-zA-Z0-9_\-./:@%+=]+$/.test(s)) return s;
  return "'" + s.replace(/'/g, `'\\''`) + "'";
}

function buildChildCmd(file: string, resultPath: string, opts: TmuxDispatchOpts): string {
  const scriptPath = process.argv[1];
  if (!scriptPath) {
    throw new Error('Cannot determine hl script path from process.argv[1]');
  }
  const parts = [
    shellQuote(process.execPath),
    shellQuote(scriptPath),
    'create',
    shellQuote(file),
    '--write-to',
    shellQuote(resultPath),
  ];
  if (opts.sessionId) {
    parts.push('--session-id', shellQuote(opts.sessionId));
  }
  if (!opts.visuals) {
    parts.push('--no-visuals');
  }
  return parts.join(' ');
}

export async function dispatchToTmuxPane(
  file: string,
  opts: TmuxDispatchOpts,
): Promise<TuiOutput> {
  const dir = mkdtempSync(join(tmpdir(), 'hl-'));
  const resultPath = join(dir, 'result.json');

  const cmd = buildChildCmd(file, resultPath, opts);
  // Capture the spawned pane id so we can detect if the user closes it
  // without finishing — otherwise the parent would poll forever.
  const paneId = execFileSync(
    'tmux',
    ['split-window', '-P', '-F', '#{pane_id}', '-h', '-d', cmd],
    { encoding: 'utf8' },
  ).trim();

  await new Promise<void>((resolve, reject) => {
    const poll = setInterval(() => {
      if (existsSync(resultPath)) {
        clearInterval(poll);
        resolve();
        return;
      }
      // Check the pane is still alive. If it's gone and there's still no
      // result file, the child died (closed pane, crash, etc).
      try {
        const panes = execFileSync('tmux', ['list-panes', '-a', '-F', '#{pane_id}'], {
          encoding: 'utf8',
        });
        if (!panes.split('\n').map((s) => s.trim()).includes(paneId)) {
          clearInterval(poll);
          reject(new Error(`tmux pane ${paneId} closed before writing a result`));
        }
      } catch (err) {
        clearInterval(poll);
        reject(new Error(`tmux list-panes failed: ${err instanceof Error ? err.message : String(err)}`));
      }
    }, 150);
  });

  const json = readFileSync(resultPath, 'utf8');
  try { unlinkSync(resultPath); } catch { /* ignore */ }
  try { rmdirSync(dir); } catch { /* ignore */ }
  return JSON.parse(json) as TuiOutput;
}
