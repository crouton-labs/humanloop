import { spawnSync } from 'node:child_process';
import type { DisplayOpts } from '../types.js';
import { displayInPane } from '../render/termrender.js';

export function countPanesInCurrentWindow(): number {
  // -t '' targets the current window of the current session.
  const result = spawnSync('tmux', ['list-panes', '-F', '#{pane_id}'], {
    encoding: 'utf8',
  });
  if (result.status !== 0) return 0;
  return result.stdout.split('\n').filter((line) => line.trim() !== '').length;
}

export function display(path: string, opts?: DisplayOpts): { paneId?: string } {
  const window: 'auto' | 'split' | 'new' = (opts?.window === 'split' || opts?.window === 'new') ? opts.window : 'auto';
  const maxPanes: number = (opts?.maxPanes !== undefined && opts.maxPanes > 0) ? opts.maxPanes : 3;

  const newWindow =
    window === 'new' ||
    (window === 'auto' && countPanesInCurrentWindow() >= maxPanes);

  // The pane always watches the file — displayed docs are live by definition.
  return displayInPane(path, { newWindow });
}
