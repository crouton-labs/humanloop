import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import stringWidth from 'string-width';
import { TERMRENDER_VERSION } from './version.js';

// ── The sole org-wide termrender binding ─────────────────────────────────────
//
// termrender is a humanloop-managed dependency: a pure-Python tool pinned to
// TERMRENDER_VERSION, installed into a venv humanloop owns. The binary is
// resolved by ABSOLUTE PATH inside that venv — never `$PATH` — so a user's
// own `pip install termrender` can never shadow or break the pin.

function findPkgRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // dist/render/termrender.js or src/render/termrender.ts → two up is pkgRoot.
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

const PKG_ROOT = findPkgRoot();
const VENV_DIR = resolve(PKG_ROOT, '.venv');
const VENV_BIN = resolve(PKG_ROOT, '.venv/bin/termrender');
const VENV_PYTHON = resolve(PKG_ROOT, '.venv/bin/python');

type RendererState = 'unchecked' | 'ready' | 'unavailable';
let rendererState: RendererState = 'unchecked';

function binaryOk(): boolean {
  if (!existsSync(VENV_BIN)) return false;
  try {
    // v2 contract: no --version flag; use -h (exit 0) as a liveness check.
    execFileSync(VENV_BIN, ['-h'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

// Returns the termrender version installed in the managed venv (via
// importlib.metadata), or null if the venv is missing/broken or termrender is
// not installed. Used by ensureRenderer() to detect drift from the pin and
// trigger a reinstall — otherwise a venv provisioned at an older pin sticks
// forever (binaryOk passes for any working binary, regardless of version).
function installedVersion(): string | null {
  if (!existsSync(VENV_PYTHON)) return null;
  try {
    const out = execFileSync(
      VENV_PYTHON,
      ['-c', 'import importlib.metadata as m; print(m.version("termrender"))'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 },
    );
    return out.trim() || null;
  } catch {
    return null;
  }
}

function uvAvailable(): boolean {
  try {
    execFileSync('uv', ['--version'], { stdio: 'pipe', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Memoized, self-healing. Ensures the pinned termrender binary exists inside
 * the humanloop-managed venv; (re)provisions it via `uv` when missing or the
 * version drifts from the pin. Runs at most once per process. Single
 * degradation path: `uv` absent → one stderr remediation line + plaintext
 * fallback. win32 → plaintext (no renderer).
 *
 * Invoked at postinstall AND lazily on the first render/check/display call,
 * so `npm ci --ignore-scripts` consumers still self-heal on first use.
 */
export function ensureRenderer(): void {
  if (rendererState !== 'unchecked') return;

  if (process.platform === 'win32') {
    rendererState = 'unavailable';
    return;
  }

  if (binaryOk() && installedVersion() === TERMRENDER_VERSION) {
    rendererState = 'ready';
    return;
  }

  if (!uvAvailable()) {
    process.stderr.write(
      '[hl] termrender unavailable — install uv to enable rich rendering:\n' +
      '  curl -LsSf https://astral.sh/uv/install.sh | sh\n',
    );
    rendererState = 'unavailable';
    return;
  }

  try {
    // (Re)create the venv whenever the interpreter is missing — covers both
    // "directory absent" and "directory present but bin/python stripped"
    // (seen in the wild when pnpm rebuilds/dedupes node_modules or uv rotates
    // its managed Python store). `--clear` makes uv wipe any partial state
    // rather than refusing on the existing dir. If the interpreter is intact,
    // skip straight to `uv pip install` so version drift reuses the venv.
    if (!existsSync(VENV_PYTHON)) {
      execFileSync('uv', ['venv', '--clear', VENV_DIR], { stdio: 'pipe', timeout: 60000 });
    }
    execFileSync(
      'uv',
      ['pip', 'install', '--python', VENV_PYTHON, `termrender==${TERMRENDER_VERSION}`],
      { stdio: 'pipe', timeout: 120000 },
    );
  } catch (err) {
    process.stderr.write(
      `[hl] termrender install failed (${err instanceof Error ? err.message : String(err)}); using plaintext fallback\n`,
    );
    rendererState = 'unavailable';
    return;
  }

  rendererState = (binaryOk() && installedVersion() === TERMRENDER_VERSION) ? 'ready' : 'unavailable';
  if (rendererState === 'unavailable') {
    process.stderr.write('[hl] termrender install completed but health check failed; using plaintext fallback\n');
  }
}

/** Cheap predicate — true when the pinned managed binary is present and correct. Does not install. */
export function isRendererReady(): boolean {
  if (rendererState === 'ready') return true;
  if (rendererState === 'unavailable') return false;
  return process.platform !== 'win32' && binaryOk();
}

// ── Plaintext fallback helpers (kept here so this is the only termrender site) ─

const CONTROL_CHARS_RE = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b[@-_]|[\x00-\x08\x0B\x0E-\x1F\x7F-\x9F]/g;
function sanitize(text: string): string {
  if (typeof text !== 'string') return '';
  return text.replace(CONTROL_CHARS_RE, '');
}

function sliceByWidth(s: string, maxWidth: number): string {
  let w = 0;
  let out = '';
  for (const ch of s) {
    const cw = stringWidth(ch);
    if (w + cw > maxWidth) break;
    out += ch;
    w += cw;
  }
  if (out === '' && s.length > 0) out = [...s][0]!;
  return out;
}

function wrap(text: string, maxWidth: number): string[] {
  if (maxWidth < 1) return [text];
  const out: string[] = [];
  const paragraphs = text.split('\n');
  for (let p = 0; p < paragraphs.length; p++) {
    const para = paragraphs[p]!;
    if (para === '') {
      out.push('');
      continue;
    }
    const words = para.split(/[ \t]+/).filter(Boolean);
    let current = '';
    for (let word of words) {
      while (stringWidth(word) > maxWidth) {
        if (current) {
          out.push(current);
          current = '';
        }
        const piece = sliceByWidth(word, maxWidth);
        out.push(piece);
        word = word.slice(piece.length);
      }
      const candidate = current ? `${current} ${word}` : word;
      if (stringWidth(candidate) <= maxWidth) {
        current = candidate;
      } else {
        if (current) out.push(current);
        current = word;
      }
    }
    if (current) out.push(current);
  }
  return out.length > 0 ? out : [''];
}

// ── Render surface ───────────────────────────────────────────────────────────

const _bodyCache = new Map<string, string[]>();

/** Render markdown to terminal lines via the pinned binary; plaintext fallback. */
export function renderMarkdown(md: string, width: number): string[] {
  const key = `${md}\0${width}`;
  const cached = _bodyCache.get(key);
  if (cached) return cached;

  ensureRenderer();
  if (rendererState === 'ready') {
    try {
      const out = execFileSync(VENV_BIN, ['doc', 'render', '--width', String(width), '--color', 'on'], {
        input: md,
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const lines = out.split('\n');
      if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
      _bodyCache.set(key, lines);
      return lines;
    } catch {
      /* fall through to plaintext */
    }
  }

  const fallback = wrap(sanitize(md), width);
  _bodyCache.set(key, fallback);
  return fallback;
}

/** Validate markdown via `termrender doc check`. */
export function checkMarkdown(md: string): { ok: true } | { ok: false; error: string } {
  ensureRenderer();
  // Renderer unavailable → don't block validation; the body just renders as
  // plaintext later. Bricking deck validation here would be the wrong default.
  if (rendererState !== 'ready') return { ok: true };

  const result = spawnSync(VENV_BIN, ['doc', 'check'], {
    input: md,
    encoding: 'utf-8',
    timeout: 5000,
  });

  if (result.error) {
    return { ok: false, error: `termrender: invocation failed: ${result.error.message}` };
  }

  type CheckResult = { ok: boolean; errors?: Array<{ kind?: string; message?: string }> };
  let parsed: CheckResult | null = null;
  const rawStdout: string = typeof result.stdout === 'string' ? result.stdout : '';
  if (rawStdout) {
    try {
      parsed = JSON.parse(rawStdout.trim()) as CheckResult;
    } catch {
      // stdout not parseable — fall through to exit-code handling
    }
  }

  if (parsed !== null) {
    if (parsed.ok) return { ok: true };
    const first = Array.isArray(parsed.errors) ? parsed.errors[0] : undefined;
    const msg = (first && typeof first.message === 'string' && first.message) ? first.message : 'invalid markdown';
    return { ok: false, error: `termrender: ${msg}` };
  }

  // exit code 2 = invalid per contract; any non-zero is an error
  if (result.status !== 0) {
    return { ok: false, error: `termrender: doc check exited ${result.status}` };
  }

  return { ok: true };
}

export interface DisplayInPaneOpts {
  /** Open in a new tmux window instead of splitting the current one. */
  newWindow?: boolean;
}

/**
 * Spawn termrender into a live tmux pane. The pane-budget policy (whether to
 * split vs open a new window) is decided by the caller (`src/surfaces/
 * display.ts`); this is the thin managed-binary spawn it delegates to.
 */
export function displayInPane(path: string, opts: DisplayInPaneOpts = {}): { paneId?: string } {
  ensureRenderer();
  if (rendererState !== 'ready') return {};

  // Always watch: a displayed pane is a live view of the file by definition.
  const args = ['pane', 'open', path, '--watch'];
  args.push('--window', opts.newWindow ? 'new' : 'split');

  const result = spawnSync(VENV_BIN, args, {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  if (result.error || result.status !== 0) return {};

  // `encoding: 'utf-8'` makes spawnSync return stdout as a string.
  const rawStdout = result.stdout;
  if (!rawStdout) return {};

  let parsed: { pane_id?: string } | null = null;
  try {
    parsed = JSON.parse(rawStdout.trim()) as { pane_id?: string };
  } catch {
    return {};
  }

  if (parsed && typeof parsed.pane_id === 'string' && parsed.pane_id) {
    return { paneId: parsed.pane_id };
  }
  return {};
}
