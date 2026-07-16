import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { popupPaths, inboxToggleTmuxCommand, inboxPopupFlags } from '../tui/tmux.js';
import { registerInboxRoot } from '../inbox/registry.js';
import { submitDeck } from '../inbox/tickets.js';

const temp = mkdtempSync(join(tmpdir(), 'humanloop-popup-'));
// The control socket lives under XDG_RUNTIME_DIR; keep it short so the popup's
// unix-socket path stays under the macOS 104-char limit (a nested temp path overflows it).
const runtime = mkdtempSync('/tmp/hlr-');
process.env.XDG_RUNTIME_DIR = runtime;

const cli = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));
if (!existsSync(cli)) throw new Error(`built CLI missing at ${cli}; run \`npm run build\` before this test`);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function tmuxOut(socket: string, args: string[]): string { return execFileSync('tmux', ['-S', socket, ...args], { encoding: 'utf8' }).trim(); }
function tmuxTry(socket: string, args: string[]): string { try { return tmuxOut(socket, args); } catch { return ''; } }
async function poll<T>(fn: () => T | undefined, desc: string, timeoutMs = 12000, interval = 150): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const value = fn(); if (value) return value; } catch { /* not ready yet */ }
    await sleep(interval);
  }
  throw new Error(`timed out waiting for: ${desc}`);
}
function toggle(extra: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile('node', [cli, 'inbox', 'toggle', ...extra], { env: process.env }, (_error, stdout) => {
      resolve((JSON.parse(stdout.toString()) as { result: string }).result);
    });
  });
}

const bindingSocket = join(temp, 'tmux.sock');
const inner = join(temp, 'inner.sock');
const outer = join(temp, 'outer.sock');
let cleanedUp = false;
function cleanup(): void {
  if (cleanedUp) return;
  cleanedUp = true;
  for (const socket of [bindingSocket, inner, outer]) { try { execFileSync('tmux', ['-S', socket, 'kill-server'], { stdio: 'ignore' }); } catch { /* server already gone */ } }
  rmSync(temp, { recursive: true, force: true });
  rmSync(runtime, { recursive: true, force: true });
}
for (const [signal, exitCode] of [['SIGINT', 130], ['SIGTERM', 143]] as const) {
  process.once(signal, () => {
    cleanup();
    process.exit(exitCode);
  });
}

execFileSync('tmux', ['-S', bindingSocket, '-f', '/dev/null', 'new-session', '-d', '-s', 'popup-test', 'sleep 600']);
try {
  // ── Phase 1: the exported command contract + popup identity ────────────────
  // Humanloop owns only the command text the binding runs (crouter owns which key
  // runs it). This exact argv is what crouter's tmux-binding installer depends on;
  // --quiet keeps the background run-shell -b binding from overlaying its result JSON.
  assert.deepEqual(inboxToggleTmuxCommand(), ['run-shell', '-b', 'hl inbox toggle --quiet --tmux-socket "#{socket_path}" --tmux-client "#{client_name}" --target-pane "#{pane_id}"'], 'inboxToggleTmuxCommand() returns the stable run-shell argv crouter binds');
  // The popup's geometry/style flags are the exact strings tmux `display-popup` receives.
  assert.deepEqual(inboxPopupFlags(), ['-w', '90%', '-h', '90%', '-b', 'rounded', '-T', 'humanloop · inbox', '-s', 'bg=#20242d', '-S', 'fg=#5c6370'], 'popup launch flags: 90% geometry, rounded border, exact title and colors');
  assert.notEqual(popupPaths({ socket: bindingSocket, client: 'first' }).controlSocket, popupPaths({ socket: bindingSocket, client: 'second' }).controlSocket, 'each tmux client has a distinct control socket');

  const root = join(temp, 'tickets');
  registerInboxRoot({ root, owner: 'test' });
  const before = execFileSync('tmux', ['-S', bindingSocket, 'list-panes', '-a', '-F', '#{pane_id}'], { encoding: 'utf8' });
  submitDeck({ root, id: 'queued', deck: { interactions: [{ id: 'ok', title: 'Queued', options: [{ id: 'ok', label: 'OK' }] }] } });
  const after = execFileSync('tmux', ['-S', bindingSocket, 'list-panes', '-a', '-F', '#{pane_id}'], { encoding: 'utf8' });
  assert.equal(after, before, 'enqueue does not mutate tmux panes');

  // ── Phase 2: real attached-client popup toggle (nested tmux servers) ───────
  // Inner server holds the true session; the outer server's only pane attaches
  // to it, so `capture-pane -p` on the outer captures the inner client's full
  // rendered screen — including a popup overlay drawn by the inner server.
  execFileSync('tmux', ['-S', inner, '-f', '/dev/null', 'new-session', '-d', '-s', 'main', '-x', '220', '-y', '60', 'sleep 600']);
  execFileSync('tmux', ['-S', inner, 'set-environment', '-g', 'XDG_RUNTIME_DIR', process.env.XDG_RUNTIME_DIR!]);
  execFileSync('tmux', ['-S', outer, '-f', '/dev/null', 'new-session', '-d', '-s', 'host', '-x', '220', '-y', '60', `TMUX= exec tmux -S ${inner} -f /dev/null attach -t main`]);

  const clientName = await poll(() => tmuxTry(inner, ['list-clients', '-F', '#{client_name}']).split('\n').filter(Boolean)[0], 'inner tmux client attaches');
  const control = popupPaths({ socket: inner, client: clientName }).controlSocket;
  const innerPanes = () => tmuxOut(inner, ['list-panes', '-a', '-F', '#{pane_id}']);
  const panesBefore = innerPanes();

  // (a) first toggle from closed → opened
  assert.equal(await toggle(['--tmux-socket', inner, '--tmux-client', clientName]), 'opened', 'first toggle opens the popup');
  // (b) the popup's real title border renders through to the outer capture
  await poll(() => tmuxTry(outer, ['capture-pane', '-p', '-t', 'host']).includes('humanloop · inbox') || undefined, 'popup title renders in the outer capture');
  // (c) a popup is an overlay, not a pane — inner pane ids are unchanged
  assert.equal(innerPanes(), panesBefore, 'popup does not add a tmux pane');

  // (d) second toggle → closed, and the control socket is removed
  assert.equal(await toggle(['--tmux-socket', inner, '--tmux-client', clientName]), 'closed', 'second toggle closes the popup');
  await poll(() => (existsSync(control) ? undefined : true), 'control socket removed after close');

  // (e) two simultaneous toggles from closed → exactly one opens
  const raced = await Promise.all([
    toggle(['--tmux-socket', inner, '--tmux-client', clientName]),
    toggle(['--tmux-socket', inner, '--tmux-client', clientName]),
  ]);
  assert.equal(raced.filter((r) => r === 'opened').length, 1, `exactly one concurrent toggle opens (got ${JSON.stringify(raced)})`);
  assert.ok(raced.every((r) => r === 'opened' || r === 'failed' || r === 'closed'), `the loser is failed or closed (got ${JSON.stringify(raced)})`);
  if (existsSync(control)) assert.equal(await toggle(['--tmux-socket', inner, '--tmux-client', clientName]), 'closed', 'the surviving popup closes on the next toggle');
  await poll(() => (existsSync(control) ? undefined : true), 'control socket removed after the raced pair');

  // (f) with two clients on the same pane, client inference is ambiguous
  execFileSync('tmux', ['-S', outer, 'new-session', '-d', '-s', 'host2', '-x', '210', '-y', '55', `TMUX= exec tmux -S ${inner} -f /dev/null attach -t main`]);
  await poll(() => (tmuxTry(inner, ['list-clients', '-F', '#{client_name}']).split('\n').filter(Boolean).length >= 2 ? true : undefined), 'a second client attaches the inner session');
  const innerPane = tmuxOut(inner, ['list-panes', '-t', 'main', '-F', '#{pane_id}']).split('\n')[0]!;
  assert.equal(await toggle(['--tmux-socket', inner, '--target-pane', innerPane]), 'ambiguous_client', 'inference across two clients is rejected, not guessed');

  // ── Phase 3: a hung completion handler must not keep a closed popup alive ──
  // A resolved-but-undelivered ticket makes the popup dispatch its root's
  // completion handler on open. If that handler hangs, the child process used
  // to hold the popup's event loop open after quit — leaving the dismissed
  // inbox occupying the terminal. The popup process must hard-exit on close.
  const hangRoot = join(temp, 'hang-tickets');
  const handlerMarker = join(temp, 'handler-started');
  registerInboxRoot({ root: hangRoot, owner: 'hang-test', handler: { command: '/bin/sh', args: ['-c', `touch ${handlerMarker} && sleep 300`] } });
  const hung = submitDeck({ root: hangRoot, id: 'hung', deck: { interactions: [{ id: 'q1', title: 'Hung delivery', options: [{ id: 'a', label: 'A' }] }] } });
  writeFileSync(join(hung.dir, 'response.json'), JSON.stringify({ schema: 'humanloop.response/v2', kind: 'deck', responses: [{ id: 'q1', selectedOptionId: 'a' }], summary: 'picked A', completedAt: new Date().toISOString() }));
  assert.equal(await toggle(['--tmux-socket', inner, '--tmux-client', clientName]), 'opened', 'popup opens with a resolved-but-undelivered ticket present');
  await poll(() => tmuxTry(outer, ['capture-pane', '-p', '-t', 'host']).includes('humanloop · inbox') || undefined, 'popup renders before the quit gesture');
  await poll(() => (existsSync(handlerMarker) ? true : undefined), 'the hanging completion handler was dispatched');
  execFileSync('tmux', ['-S', outer, 'send-keys', '-t', 'host', 'q']);
  await poll(() => (tmuxTry(outer, ['capture-pane', '-p', '-t', 'host']).includes('humanloop · inbox') ? undefined : true), 'popup dismisses promptly despite the hung handler child');
  await poll(() => (existsSync(control) ? undefined : true), 'control socket removed after quit with a hung handler');
} finally {
  cleanup();
}
console.log('inbox popup tests passed');
