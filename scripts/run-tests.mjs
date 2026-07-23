import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { build } from 'esbuild';

const repoRoot = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const tsxCli = fileURLToPath(import.meta.resolve('tsx/cli'));

const SCRIPT_TIMEOUT_MS = 10_000;
const SUITE_TIMEOUT_MS = 45_000;
const WEB_TEST_CONCURRENCY = 3;

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
  { path: 'src/__tests__/terminal-review.test.ts' },
  { path: 'src/__tests__/browser-server.test.ts' },
  { path: 'web/src/__tests__/review-sourcemap.test.ts' },
  { path: 'web/src/__tests__/review-anchor-units.test.ts' },
  { path: 'web/src/__tests__/review-reducer.test.ts' },
  { path: 'web/src/__tests__/review-keymap.test.ts' },
  { path: 'web/src/__tests__/review-markdown-instrumentation.test.ts' },
  { path: 'web/src/__tests__/app-deck-regression.test.ts' },
  { path: 'web/src/__tests__/review-surface-conflict.test.ts' },
  { path: 'web/src/__tests__/app-ws-close.test.ts' },
  { path: 'web/src/__tests__/review-surface-takeback.test.ts' },
  { path: 'web/src/__tests__/review-surface-submit-race.test.ts' },
  { path: 'web/src/__tests__/review-surface-stale-submit-failure.test.ts' },
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

const activeAborts = new Set();
function abortAll(reason) {
  for (const abort of activeAborts) abort(reason);
}

const bundledTestPaths = new Map();
async function bundleWebTests(selection) {
  const webTests = selection.filter((test) => test.path.startsWith('web/'));
  if (webTests.length === 0) return undefined;
  const outdir = mkdtempSync(join(repoRoot, '.test-bundles-'));
  const entryPoints = Object.fromEntries(webTests.map((test, index) => [`test-${index}`, test.path]));
  await build({
    absWorkingDir: repoRoot,
    entryPoints,
    bundle: true,
    packages: 'external',
    platform: 'node',
    format: 'esm',
    outdir,
    outExtension: { '.js': '.mjs' },
    tsconfig: 'web/tsconfig.json',
    logLevel: 'silent',
  });
  for (const [index, test] of webTests.entries()) bundledTestPaths.set(test.path, join(outdir, `test-${index}.mjs`));
  return outdir;
}

function runTest(test) {
  return new Promise((resolveRun, rejectRun) => {
    const bundledPath = bundledTestPaths.get(test.path);
    const args = bundledPath === undefined ? [tsxCli, test.path] : [bundledPath];

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
    activeAborts.add(abort);
    const timeoutMs = test.timeoutMs ?? SCRIPT_TIMEOUT_MS;
    const timer = setTimeout(() => abort(`${test.path} exceeded its ${timeoutMs / 1_000}s process limit`), timeoutMs);

    child.once('error', (error) => {
      clearTimeout(timer);
      activeAborts.delete(abort);
      rejectRun(error);
    });
    child.once('exit', async (code, signal) => {
      clearTimeout(timer);
      activeAborts.delete(abort);
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
  abortAll(`test selection exceeded the ${SUITE_TIMEOUT_MS / 1_000}s suite limit`);
}, SUITE_TIMEOUT_MS);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    interruptedSignal = signal;
    abortAll(`test runner received ${signal}`);
  });
}

let bundleDirectory;
try {
  const selection = selectedTests(process.argv.slice(2));
  bundleDirectory = await bundleWebTests(selection);
  const serialTests = selection.filter((test) => !test.path.startsWith('web/'));
  for (const test of serialTests) {
    if (suiteTimedOut) throw new Error(`test selection exceeded the ${SUITE_TIMEOUT_MS / 1_000}s suite limit`);
    if (interruptedSignal) throw new Error(`test runner received ${interruptedSignal}`);
    await runTest(test);
  }

  const webTests = selection.filter((test) => test.path.startsWith('web/'));
  let cursor = 0;
  let firstError;
  const runWebLane = async () => {
    while (firstError === undefined && cursor < webTests.length) {
      const test = webTests[cursor++];
      try {
        await runTest(test);
      } catch (error) {
        firstError ??= error;
        abortAll('web test selection stopped after a peer failed');
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(WEB_TEST_CONCURRENCY, webTests.length) }, runWebLane));
  if (firstError !== undefined) throw firstError;
  if (suiteTimedOut) throw new Error(`test selection exceeded the ${SUITE_TIMEOUT_MS / 1_000}s suite limit`);
  if (interruptedSignal) throw new Error(`test runner received ${interruptedSignal}`);
} catch (error) {
  console.error(`\nFAIL ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  clearTimeout(suiteTimer);
  if (bundleDirectory !== undefined) rmSync(bundleDirectory, { recursive: true, force: true });
}
