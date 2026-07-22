import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const repoRoot = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const tsxCli = fileURLToPath(import.meta.resolve('tsx/cli'));

const SCRIPT_TIMEOUT_MS = 10_000;
const SUITE_TIMEOUT_MS = 45_000;

const tests = [
  { path: 'src/__tests__/visual.test.ts' },
  { path: 'src/__tests__/visual-controller.test.ts' },
  { path: 'src/__tests__/editor-roundtrip.test.ts' },
  { path: 'src/__tests__/inbox-core.test.ts' },
  { path: 'src/__tests__/followup.test.ts' },
  { path: 'src/__tests__/inbox-controller.test.ts' },
  { path: 'src/__tests__/review-adapter.test.ts' },
  { path: 'src/__tests__/mount-panel.test.ts' },
  { path: 'src/__tests__/feedback.test.ts' },
  { path: 'src/__tests__/browser-server.test.ts' },
  { path: 'web/src/__tests__/review-sourcemap.test.ts' },
  { path: 'web/src/__tests__/review-reducer.test.ts' },
  { path: 'web/src/__tests__/review-keymap.test.ts' },
  { path: 'web/src/__tests__/review-markdown-instrumentation.test.ts' },
  { path: 'web/src/__tests__/app-deck-regression.test.ts', tsconfig: 'web/tsconfig.json' },
  { path: 'web/src/__tests__/review-surface-conflict.test.ts', tsconfig: 'web/tsconfig.json' },
  { path: 'web/src/__tests__/app-ws-close.test.ts', tsconfig: 'web/tsconfig.json' },
  { path: 'web/src/__tests__/review-surface-takeback.test.ts', tsconfig: 'web/tsconfig.json' },
  { path: 'web/src/__tests__/review-surface-submit-race.test.ts', tsconfig: 'web/tsconfig.json' },
  { path: 'web/src/__tests__/review-surface-stale-submit-failure.test.ts', tsconfig: 'web/tsconfig.json' },
  // Approved slow-test exception: this drives real nested tmux servers and bounded readiness polls.
  { path: 'src/__tests__/inbox-popup.test.ts', timeoutMs: 20_000 },
];

const byPath = new Map(tests.map((test) => [test.path, test]));

function selectedTests(args) {
  if (args.length === 0) return tests;
  const selected = [];
  const seen = new Set();
  for (const arg of args) {
    const path = relative(repoRoot, resolve(repoRoot, arg)).replaceAll('\\', '/');
    const test = byPath.get(path);
    if (!test) {
      throw new Error(`not a test in the comprehensive suite: ${arg}`);
    }
    if (!seen.has(path)) {
      selected.push(test);
      seen.add(path);
    }
  }
  return selected;
}

function signalProcessGroup(child, signal) {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

function terminate(child) {
  signalProcessGroup(child, 'SIGTERM');
  return new Promise((resolveTermination) => {
    setTimeout(() => {
      signalProcessGroup(child, 'SIGKILL');
      resolveTermination();
    }, 1_000);
  });
}

let abortActive;
function runTest(test) {
  return new Promise((resolveRun, rejectRun) => {
    const args = [tsxCli];
    if (test.tsconfig) args.push('--tsconfig', test.tsconfig);
    args.push(test.path);

    const started = performance.now();
    const child = spawn(process.execPath, args, {
      cwd: repoRoot,
      detached: true,
      stdio: 'inherit',
    });
    let timeoutReason;
    let termination;
    const abort = (reason) => {
      if (timeoutReason) return;
      timeoutReason = reason;
      termination = terminate(child);
    };
    abortActive = abort;
    const timeoutMs = test.timeoutMs ?? SCRIPT_TIMEOUT_MS;
    const timer = setTimeout(() => abort(`${test.path} exceeded its ${timeoutMs / 1_000}s process limit`), timeoutMs);

    child.once('error', (error) => {
      clearTimeout(timer);
      abortActive = undefined;
      rejectRun(error);
    });
    child.once('exit', async (code, signal) => {
      clearTimeout(timer);
      abortActive = undefined;
      if (termination) await termination;
      // tsx can leave compiler-service descendants alive after the test script
      // exits. Reap the detached test's remaining process group so serial CI
      // does not progressively slow down as those services accumulate.
      signalProcessGroup(child, 'SIGTERM');
      const duration = ((performance.now() - started) / 1_000).toFixed(2);
      if (timeoutReason) {
        rejectRun(new Error(timeoutReason));
      } else if (code !== 0) {
        rejectRun(new Error(`${test.path} failed after ${duration}s (${signal ?? `exit ${code}`})`));
      } else {
        console.log(`PASS ${test.path} (${duration}s)`);
        resolveRun();
      }
    });
  });
}

let suiteTimedOut = false;
let interruptedSignal;
const suiteTimer = setTimeout(() => {
  suiteTimedOut = true;
  abortActive?.(`test selection exceeded the ${SUITE_TIMEOUT_MS / 1_000}s suite limit`);
}, SUITE_TIMEOUT_MS);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    interruptedSignal = signal;
    abortActive?.(`test runner received ${signal}`);
  });
}

try {
  for (const test of selectedTests(process.argv.slice(2))) {
    if (suiteTimedOut) throw new Error(`test selection exceeded the ${SUITE_TIMEOUT_MS / 1_000}s suite limit`);
    if (interruptedSignal) throw new Error(`test runner received ${interruptedSignal}`);
    await runTest(test);
  }
  if (interruptedSignal) throw new Error(`test runner received ${interruptedSignal}`);
} catch (error) {
  console.error(`\nFAIL ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  clearTimeout(suiteTimer);
}
