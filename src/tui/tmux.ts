import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmdirSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { DecisionsOutput } from '../types.js';

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
): Promise<DecisionsOutput> {
  const dir = mkdtempSync(join(tmpdir(), 'hl-'));
  const resultPath = join(dir, 'result.json');

  const cmd = buildChildCmd(file, resultPath, opts);
  execFileSync('tmux', ['split-window', '-h', '-d', cmd], { stdio: 'ignore' });

  await new Promise<void>((resolve) => {
    const poll = setInterval(() => {
      if (existsSync(resultPath)) {
        clearInterval(poll);
        resolve();
      }
    }, 150);
  });

  const json = readFileSync(resultPath, 'utf8');
  try { unlinkSync(resultPath); } catch { /* ignore */ }
  try { rmdirSync(dir); } catch { /* ignore */ }
  return JSON.parse(json) as DecisionsOutput;
}
