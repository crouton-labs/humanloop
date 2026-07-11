import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync, readFileSync, writeFileSync, statSync,
  openSync, closeSync, unlinkSync, renameSync, accessSync, realpathSync, constants,
} from 'node:fs';
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
// Readiness marker written by the single authoritative provisioning transition
// after a verified install. It fingerprints the ACTUAL verified environment —
// launcher + interpreter (mtime, size, mode) and the interpreter's realpath —
// so steady-state validation is a handful of cheap fs stats (no subprocess),
// yet a stripped exec bit, a swapped venv Python, or a rewritten launcher all
// invalidate it. Deeper corruption an fs stat can't see (e.g. mangled
// site-packages under an unchanged launcher) is caught by the other half of
// the contract: any `ready` invocation that fails to RUN invalidates this
// marker (see invalidateRenderer), so the next process repairs. Together these
// remove the ~149ms `termrender -h` + `importlib.metadata` spawn tax from the
// steady path without letting a stale marker trust a broken renderer forever.
const VENV_STAMP = resolve(PKG_ROOT, '.venv/.hl-termrender-stamp.json');
// Provisioning lock — lives OUTSIDE .venv (which `uv venv --clear` wipes) so it
// survives a reinstall. Serializes venv mutation + stamp publication across
// processes: a stamp can never certify a concurrently-changing venv.
const VENV_LOCK = resolve(PKG_ROOT, '.hl-termrender.lock');
// A lock older than this is from a crashed process and may be stolen. Set
// comfortably above the worst-case held path (uv probe 5s + venv 60s + install
// 120s + re-verify ~10s ≈ 195s) so a slow-but-alive holder is never judged
// stale while it still holds.
const LOCK_STALE_MS = 300_000;
// Absolute cap on how long a waiter spins before giving up to plaintext for
// this session (the next launch retries) — a safety valve so a wedged holder
// can never hang a process, WITHOUT ever stealing a lock we can't prove stale.
const LOCK_GIVE_UP_MS = LOCK_STALE_MS + 60_000;

type RendererState = 'unchecked' | 'ready' | 'unavailable';
let rendererState: RendererState = 'unchecked';

type FpEntry = { mtimeMs: number; size: number; mode: number };
type Stamp = { version: string; bin: FpEntry; python: FpEntry; pythonRealpath: string };

function isFp(x: unknown): x is FpEntry {
  const e = x as FpEntry;
  return !!e && typeof e.mtimeMs === 'number' && typeof e.size === 'number' && typeof e.mode === 'number';
}

function fingerprint(path: string): FpEntry | null {
  try {
    const s = statSync(path);
    return { mtimeMs: s.mtimeMs, size: s.size, mode: s.mode };
  } catch {
    return null;
  }
}

function fpMatch(a: FpEntry | null, b: FpEntry): boolean {
  return !!a && a.mtimeMs === b.mtimeMs && a.size === b.size && a.mode === b.mode;
}

function readStamp(): Stamp | null {
  try {
    const p = JSON.parse(readFileSync(VENV_STAMP, 'utf8')) as Stamp;
    if (p && typeof p.version === 'string' && isFp(p.bin) && isFp(p.python) && typeof p.pythonRealpath === 'string') {
      return p;
    }
    return null;
  } catch {
    return null;
  }
}

// Publish the readiness marker for the state we just verified. Failure to
// persist is surfaced explicitly (not swallowed): the renderer works for THIS
// process, but every future launch re-verifies the slow way until the marker
// can be written — the operator should know why launches stay slow.
function publishStamp(): void {
  const bin = fingerprint(VENV_BIN);
  const python = fingerprint(VENV_PYTHON);
  if (!bin || !python) {
    process.stderr.write('[hl] termrender stamp skipped: venv files vanished immediately after verify\n');
    return;
  }
  let pythonRealpath: string;
  try {
    pythonRealpath = realpathSync(VENV_PYTHON);
  } catch {
    pythonRealpath = VENV_PYTHON;
  }
  const stamp: Stamp = { version: TERMRENDER_VERSION, bin, python, pythonRealpath };
  // Atomic publish: write a temp then rename, so a crash mid-write can't leave
  // a half-written stamp and a concurrent reader never observes a torn file.
  const tmp = `${VENV_STAMP}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(stamp));
    renameSync(tmp, VENV_STAMP);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* nothing to clean up */ }
    process.stderr.write(
      `[hl] termrender ready but stamp not persisted (${err instanceof Error ? err.message : String(err)}); ` +
      'future launches will re-verify the slow way\n',
    );
  }
}

// Invalidate the readiness marker when a supposedly-ready renderer misbehaves
// in a way that implicates the environment (spawn fault, or a `doc render`
// failure — render is best-effort by contract, so ANY failure means the tool,
// not the input, is broken; this catches site-packages corruption an fs stat
// can't see). Removes the on-disk marker so the next process repairs, and
// downgrades THIS process to plaintext to avoid retry thrash within the session.
function invalidateRenderer(reason: string): void {
  let removed = true;
  try {
    unlinkSync(VENV_STAMP);
  } catch (err) {
    // ENOENT means it's already gone (still invalidated); any other error means
    // the marker SURVIVES and will keep certifying — say so honestly rather
    // than promising a repair that can't happen until the file is removable.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') removed = false;
  }
  rendererState = 'unavailable';
  if (removed) {
    process.stderr.write(`[hl] termrender invocation failed (${reason}); invalidated readiness, future launches will repair\n`);
  } else {
    process.stderr.write(
      `[hl] termrender invocation failed (${reason}) but its readiness marker could not be removed; ` +
      `future launches may keep trusting a broken renderer until ${VENV_STAMP} is deleted\n`,
    );
  }
}

// True when a spawn was killed by its own timeout rather than failing to run —
// usually a slow/large document, not a broken environment. Excluded from
// invalidation so a reliably-slow render can't oscillate a healthy renderer
// (invalidate → slow re-verify → re-stamp) every session.
function isTimeout(err: unknown): boolean {
  const e = err as { code?: string; killed?: boolean; signal?: string | null };
  return e?.code === 'ETIMEDOUT' || (!!e?.killed && !!e?.signal);
}

// Cheap steady-state trust — all fs stats, no subprocess. The pinned launcher
// is present, executable, and byte-for-byte the one the stamp verified; the
// interpreter it targets is the same file at the same realpath. Any of these
// drifting (version bump, stripped exec bit, rewritten launcher, swapped venv
// Python) forces the authoritative re-provision transition.
function stampValid(): boolean {
  const stamp = readStamp();
  if (!stamp || stamp.version !== TERMRENDER_VERSION) return false;
  try {
    accessSync(VENV_BIN, constants.X_OK);
  } catch {
    return false;
  }
  if (!fpMatch(fingerprint(VENV_BIN), stamp.bin)) return false;
  if (!fpMatch(fingerprint(VENV_PYTHON), stamp.python)) return false;
  try {
    if (realpathSync(VENV_PYTHON) !== stamp.pythonRealpath) return false;
  } catch {
    return false;
  }
  return true;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function lockIsStale(): boolean {
  try {
    const at = (JSON.parse(readFileSync(VENV_LOCK, 'utf8')) as { at?: number }).at;
    if (typeof at === 'number') return Date.now() - at > LOCK_STALE_MS;
  } catch {
    // Unreadable/malformed lock — fall through to mtime.
  }
  try {
    return Date.now() - statSync(VENV_LOCK).mtimeMs > LOCK_STALE_MS;
  } catch {
    return true; // vanished — the retry loop re-acquires
  }
}

// Run `provision` while holding the exclusive provisioning lock. If another
// live process holds it, wait for that process to publish (re-checking the
// stamp) rather than mutating the venv concurrently. Stale locks are stolen.
// Steal a lock judged stale by renaming it to a unique name first: rename is
// atomic, so if two waiters race only the one whose rename succeeds owns (and
// deletes) it — the loser gets ENOENT and re-loops. This can never delete a
// lock a peer has freshly re-acquired (that peer holds a DIFFERENT inode at the
// same path; our rename of the old name either already happened or fails).
function stealStaleLock(): void {
  const tmp = `${VENV_LOCK}.steal.${process.pid}.${Date.now()}`;
  try {
    renameSync(VENV_LOCK, tmp);
  } catch {
    return; // lost the steal race or already gone — caller re-loops
  }
  try { unlinkSync(tmp); } catch { /* best effort */ }
}

function withProvisionLock(provision: () => void): void {
  const giveUpAt = Date.now() + LOCK_GIVE_UP_MS;
  for (;;) {
    let fd: number;
    try {
      fd = openSync(VENV_LOCK, 'wx'); // O_CREAT | O_EXCL — atomic acquire
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      if (lockIsStale()) { stealStaleLock(); continue; }
      // A live process is provisioning — give it a chance, then adopt its result.
      // Never steal a lock we can't prove stale; if we wait too long, give up to
      // plaintext this session rather than break mutual exclusion.
      if (Date.now() > giveUpAt) { rendererState = 'unavailable'; return; }
      sleepSync(200);
      if (stampValid()) { rendererState = 'ready'; return; }
      continue;
    }
    try {
      writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
    } catch { /* lock held regardless of whether the marker body wrote */ }
    try {
      provision();
    } finally {
      try { closeSync(fd); } catch { /* already closed */ }
      try { unlinkSync(VENV_LOCK); } catch { /* stolen as stale by another process */ }
    }
    return;
  }
}

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
 * Memoized, self-healing. Guarantees at most one authoritative renderer
 * lifecycle per process: trust a valid stamp outright (zero subprocess spawns),
 * else run ONE provision/verify/publish transition under the exclusive lock.
 * There is no permanent legacy-verifier fallback — the spawn-based verify
 * (`binaryOk` + `installedVersion`) is a step INSIDE that single transition,
 * always followed by publishing the stamp, never a lasting alternate path.
 *
 * Single degradation path: `uv` absent → one stderr remediation line + plaintext.
 * win32 → plaintext (no renderer).
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

  // Steady state: trust the stamp — zero subprocess spawns.
  if (stampValid()) {
    rendererState = 'ready';
    return;
  }

  // No/invalid stamp → the single authoritative transition, serialized so no
  // two processes mutate the venv (or certify it) concurrently.
  provisionAndPublish();
}

// The one invalid-stamp transition. Under the exclusive lock: adopt a stamp a
// racing process just published; else verify the current venv (a healthy venv
// with no/stale stamp — pre-stamp humanloop, interrupted publish, or a peer
// that finished the venv but not the stamp — needs only re-verification, not a
// reinstall); reinstall via `uv` only when genuinely missing/drifted; then
// verify and publish. Every success path ends by publishing the stamp.
function provisionAndPublish(): void {
  withProvisionLock(() => {
    // A peer may have published between our unlocked stampValid() in
    // ensureRenderer and our acquiring the lock here — adopt it, don't reinstall.
    if (stampValid()) { rendererState = 'ready'; return; }

    let verified = binaryOk() && installedVersion() === TERMRENDER_VERSION;

    if (!verified) {
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
        // (seen when pnpm rebuilds/dedupes node_modules or uv rotates its
        // managed Python store). `--clear` wipes any partial state rather than
        // refusing on the existing dir. Intact interpreter → reuse the venv.
        if (!existsSync(VENV_PYTHON)) {
          execFileSync('uv', ['venv', '--clear', VENV_DIR], { stdio: 'pipe', timeout: 60000 });
        }
        // `--reinstall` forces uv to rebuild the package and rewrite its entry
        // point even when the pinned version already appears satisfied — so this
        // path actually REPAIRS a corrupt-but-present install (the case that
        // drove us here via invalidation), not just a clean version drift.
        execFileSync(
          'uv',
          ['pip', 'install', '--reinstall', '--python', VENV_PYTHON, `termrender==${TERMRENDER_VERSION}`],
          { stdio: 'pipe', timeout: 120000 },
        );
      } catch (err) {
        process.stderr.write(
          `[hl] termrender install failed (${err instanceof Error ? err.message : String(err)}); using plaintext fallback\n`,
        );
        rendererState = 'unavailable';
        return;
      }
      verified = binaryOk() && installedVersion() === TERMRENDER_VERSION;
    }

    if (!verified) {
      rendererState = 'unavailable';
      process.stderr.write('[hl] termrender install completed but health check failed; using plaintext fallback\n');
      return;
    }

    publishStamp();
    rendererState = 'ready';
  });
}

/** Cheap predicate — true when the pinned managed binary is verified ready. Does not install or spawn. */
export function isRendererReady(): boolean {
  if (rendererState === 'ready') return true;
  if (rendererState === 'unavailable') return false;
  return process.platform !== 'win32' && stampValid();
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
    } catch (err) {
      // `doc render` is best-effort, so a non-timeout failure implicates the
      // tool, not the markdown: invalidate so the next process repairs. A
      // timeout is a slow/large doc, not corruption — just fall to plaintext.
      if (!isTimeout(err)) invalidateRenderer('doc render');
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
    // A timeout (slow doc) is not an environment fault; anything else is a
    // spawn fault → invalidate so the next process repairs.
    const timedOut = (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT' || result.signal === 'SIGTERM';
    if (!timedOut) invalidateRenderer('doc check');
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

  // A spawn fault (binary broke) invalidates readiness; a non-zero exit (e.g.
  // tmux refused, bad path) is not an environment fault and must not.
  if (result.error) { invalidateRenderer('pane open'); return {}; }
  if (result.status !== 0) return {};

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
