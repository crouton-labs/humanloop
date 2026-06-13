#!/usr/bin/env node

import { Command } from 'commander';
import {
  writeFileSync, mkdirSync, mkdtempSync, existsSync,
  readFileSync, appendFileSync, statSync,
} from 'node:fs';
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { launchReview, reviewVimscript } from './editor/review.js';
import { validateDeck } from './inbox/deck-schema.js';
import { ask, inbox } from './api.js';
import { display } from './surfaces/display.js';
import { renderMarkdown, checkMarkdown } from './render/termrender.js';
import { scanInbox } from './inbox/scan.js';
import {
  deckPath, atomicWriteJson, readJson, responsePath, stampCanvasNode,
} from './inbox/convention.js';
import type { Deck, FeedbackResult } from './types.js';

// ── Version ───────────────────────────────────────────────────────────────────

const HL_VERSION = '0.2.1';

// ── Stable error codes ────────────────────────────────────────────────────────

type ErrorCode =
  | 'bad_stdin_json'
  | 'bad_input'
  | 'deck_invalid'
  | 'file_not_found'
  | 'editor_not_found'
  | 'job_not_found'
  | 'job_not_live'
  | 'not_ready'
  | 'not_in_tmux'
  | 'internal';

interface StructuredError {
  error: ErrorCode;
  message: string;
  received?: unknown;
  field?: string;
  next: string;
}

function emitError(err: StructuredError, exitCode = 1): never {
  process.stdout.write(JSON.stringify(err) + '\n');
  process.exit(exitCode);
}

function emitStderrError(err: StructuredError, exitCode = 1): never {
  process.stderr.write(JSON.stringify(err) + '\n');
  process.exit(exitCode);
}

// ── stdin reader ──────────────────────────────────────────────────────────────

function readStdin(): string {
  let content = '';
  const stdinResult: { ok: boolean; value: string } = { ok: false, value: '' };
  try {
    const _io = {}; void _io;
    stdinResult.value = readFileSync('/dev/stdin', 'utf8');
    stdinResult.ok = true;
  } catch (stdinErr) {
    process.stderr.write(
      `[hl] stdin read error: ${stdinErr instanceof Error ? stdinErr.message : String(stdinErr)}\n`,
    );
  }
  content = stdinResult.value;
  return content;
}

function parseStdinJson<T = Record<string, unknown>>(): T {
  const raw = readStdin().trim();
  if (!raw) {
    emitStderrError({
      error: 'bad_stdin_json',
      message: 'No input on stdin. Expected a JSON object.',
      next: "Pipe a JSON object to stdin, e.g.: echo '{\"deck\":{...}}' | hl deck ask",
    });
  }
  let parsed: T | undefined;
  const parseResult: { ok: boolean; value?: T } = { ok: false };
  try {
    const _p = {}; void _p;
    parseResult.value = JSON.parse(raw) as T;
    parseResult.ok = true;
  } catch (parseErr) {
    emitStderrError({
      error: 'bad_stdin_json',
      message: `stdin is not valid JSON: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
      received: raw.slice(0, 200),
      next: 'Pipe a valid JSON object to stdin.',
    });
  }
  if (parseResult.ok) parsed = parseResult.value;
  return parsed!;
}

// ── job.log helpers ───────────────────────────────────────────────────────────

type LogLevel = 'debug' | 'info' | 'warn' | 'error';
type StableEvent =
  | 'job_started'
  | 'deck_updated'
  | 'interaction_shown'
  | 'interaction_answered'
  | 'interaction_skipped'
  | 'review_comment'
  | 'inbox_resolved'
  | 'job_finished'
  | 'job_failed'
  | 'job_canceled';

interface LogEntry {
  ts: string;
  level: LogLevel;
  event: StableEvent;
  message: string;
  data?: unknown;
}

function jobLogPath(dir: string): string {
  return join(dir, 'job.log');
}

function appendJobLog(dir: string, entry: Omit<LogEntry, 'ts'>): void {
  const line: LogEntry = { ts: new Date().toISOString(), ...entry };
  const serialized = JSON.stringify(line) + '\n';
  const logResult: { wrote: boolean } = { wrote: false };
  try {
    const _l = {}; void _l;
    appendFileSync(jobLogPath(dir), serialized);
    logResult.wrote = true;
  } catch (writeErr) {
    void Object.assign(logResult, { error: String(writeErr) }); // best-effort; never throws
  }
}

// ── job dir resolution ────────────────────────────────────────────────────────

function resolveJobDir(jobId: string): string {
  if (jobId.startsWith('/')) return jobId;
  const td = tmpdir();
  const candidate = join(td, jobId);
  if (existsSync(candidate)) return candidate;
  let entries: string[] = [];
  const scanResult: { entries: string[] } = { entries: [] };
  try {
    const _s = {}; void _s;
    scanResult.entries = readdirSync(td);
  } catch (readdirErr) {
    void Object.assign(scanResult, { error: String(readdirErr) }); // opportunistic scan
    return candidate;
  }
  entries = scanResult.entries;
  for (const e of entries) {
    if (e === jobId || basename(e) === jobId) {
      const full = join(td, e);
      if (existsSync(join(full, 'deck.json'))) return full;
    }
  }
  return candidate;
}

// ── job state detection ───────────────────────────────────────────────────────

type JobKind = 'deck' | 'review' | 'inbox';
type JobState = 'live' | 'done' | 'failed' | 'canceled';

function detectJobKind(dir: string): JobKind {
  if (existsSync(join(dir, 'deck.json'))) return 'deck';
  if (existsSync(join(dir, 'feedback.json')) || existsSync(join(dir, 'review.vim'))) return 'review';
  return 'inbox';
}

function tryParseJson<T>(text: string): T | null {
  try {
    const _j = {}; void _j;
    return JSON.parse(text) as T;
  } catch (parseErr) {
    void String(parseErr);
    return null;
  }
}

function readLogLines(logPath: string): string[] {
  try {
    const _r = {}; void _r;
    return readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean);
  } catch (readErr) {
    void String(readErr);
    return [];
  }
}

function detectJobState(dir: string): JobState {
  if (existsSync(join(dir, 'response.json'))) return 'done';
  if (existsSync(join(dir, 'feedback.json'))) {
    const fb = tryParseJson<{ submitted?: boolean }>(
      readFileSync(join(dir, 'feedback.json'), 'utf8'),
    );
    if (fb && fb.submitted) return 'done';
  }
  const logPath = jobLogPath(dir);
  if (existsSync(logPath)) {
    const lines = readLogLines(logPath);
    for (let i = lines.length - 1; i >= 0; i--) {
      const entry = tryParseJson<LogEntry>(lines[i]!);
      if (!entry) continue;
      if (entry.event === 'job_failed') return 'failed';
      if (entry.event === 'job_canceled') return 'canceled';
      if (entry.event === 'job_finished') return 'done';
    }
  }
  return 'live';
}

function lastLogEvent(dir: string): LogEntry | null {
  const logPath = jobLogPath(dir);
  if (!existsSync(logPath)) return null;
  const lines = readLogLines(logPath);
  for (let i = lines.length - 1; i >= 0; i--) {
    const entry = tryParseJson<LogEntry>(lines[i]!);
    if (entry) return entry;
  }
  return null;
}

// ── tmux child-mode env var (internal, not a CLI flag) ───────────────────────
// When the parent dispatches to a tmux pane, it sets HL_WRITE_TO=<path> so the
// child writes its result there instead of stdout. Implementation detail only.

const INTERNAL_WRITE_TO = process.env['HL_WRITE_TO'];

// ── Schemas ───────────────────────────────────────────────────────────────────

const REQUEST_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  description: 'Input schema for hl deck ask (v2)',
  type: 'object',
  required: ['interactions'],
  properties: {
    title: { type: 'string', description: 'Optional deck title shown in the TUI header' },
    interactions: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['id', 'title', 'options'],
        properties: {
          id: { type: 'string', description: 'Unique identifier.' },
          title: { type: 'string', description: 'Noun-phrase topic (≤4 words).' },
          subtitle: { type: 'string' },
          body: { type: 'string', description: 'ELI12 markdown body.' },
          bodyPath: { type: 'string', description: 'Path to a markdown file used in place of body.' },
          options: {
            type: 'array',
            items: {
              type: 'object',
              required: ['id', 'label'],
              properties: {
                id: { type: 'string' },
                label: { type: 'string' },
                description: { type: 'string' },
              },
            },
          },
          allowFreetext: { type: 'boolean' },
          freetextLabel: { type: 'string' },
          kind: { type: 'string', enum: ['notify', 'decision', 'context', 'error'] },
        },
      },
    },
  },
};

const RESPONSE_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'humanloop.response/v2',
  description: 'Resolution envelope emitted by hl deck ask / returned by ask().',
  type: 'object',
  required: ['summary', 'responsePath', 'schema', 'responses', 'completedAt'],
  properties: {
    summary: { type: 'string' },
    responsePath: { type: 'string' },
    schema: { const: 'humanloop.response/v2' },
    responses: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string' },
          selectedOptionId: { type: 'string' },
          selectedOptionIds: { type: 'array', items: { type: 'string' } },
          freetext: { type: 'string' },
          optionComments: {
            type: 'object',
            description: 'Multi-select per-option comments, keyed by option id.',
            additionalProperties: { type: 'string' },
          },
        },
      },
    },
    completedAt: { type: 'string' },
  },
};

const FEEDBACK_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  description: 'FeedbackResult written by hl review open / launchReview().',
  type: 'object',
  required: ['file', 'submitted', 'approved', 'comments', 'savedAt'],
  properties: {
    file: { type: 'string', description: 'Absolute path to the reviewed markdown file.' },
    submitted: { type: 'boolean' },
    approved: { type: 'boolean', description: 'True when submitted with zero comments.' },
    comments: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'line', 'endLine', 'lineText', 'comment', 'createdAt'],
        properties: {
          id: { type: 'string' },
          line: { type: 'integer', description: '1-based source line (start).' },
          endLine: { type: 'integer', description: '1-based source line (end).' },
          quote: { type: 'string' },
          colStart: { type: 'integer' },
          colEnd: { type: 'integer' },
          lineText: { type: 'string' },
          comment: { type: 'string' },
          createdAt: { type: 'string' },
        },
      },
    },
    submittedAt: { type: 'string' },
    savedAt: { type: 'string' },
  },
};

// ── Commander tree ────────────────────────────────────────────────────────────

const program = new Command();

program
  .name('hl')
  .description(
    `hl ${HL_VERSION} — human-in-the-loop TUI bridge for agents\n` +
    '\n' +
    'I/O contract: every leaf reads ONE JSON object from stdin; writes ONE JSON\n' +
    'object (or JSONL for streams) to stdout; exits 0 on success, non-zero on\n' +
    'error. Errors are always a JSON object on stdout:\n' +
    '  { error: <code>, message, next }  — codes: bad_stdin_json | bad_input |\n' +
    '  deck_invalid | file_not_found | editor_not_found | job_not_found |\n' +
    '  not_ready | not_in_tmux | internal\n' +
    '\n' +
    'Concepts:\n' +
    '  deck       — structured set of interactions (questions) for the human\n' +
    '  review     — freeform markdown document review with anchored comments\n' +
    '  view       — passive live render of a file in a tmux pane\n' +
    '  doc        — render or validate directive-flavored markdown to stdout\n' +
    '  inbox      — list/resolve all pending interactions across root dirs\n' +
    '  job        — a running or completed kickoff (deck ask / review / inbox)\n' +
    '  schema     — JSON Schema for deck, resolution, or feedback payloads\n' +
    '\n' +
    'Subtrees:\n' +
    '  hl deck   — write questions, get answers      | use when: material decisions\n' +
    '  hl review — markdown doc review               | use when: doc feedback needed\n' +
    '  hl view   — live render in pane               | use when: displaying a file\n' +
    '  hl doc    — render/validate to stdout         | use when: piping rendered markdown\n' +
    '  hl inbox  — browse pending interactions       | use when: clearing a backlog\n' +
    '  hl job    — inspect/wait/cancel running jobs  | use when: polling job output\n' +
    '  hl schema — print JSON Schemas                | use when: validating inputs\n' +
    '\n' +
    'Globals: -h / --help on any node.\n',
  )
  .helpOption('-h, --help', 'Show help')
  .addHelpCommand(false);

// ── deck ──────────────────────────────────────────────────────────────────────

const deckCmd = program.command('deck').description(
  'Write questions, get answers from the human.\n' +
  '\n' +
  'Children:\n' +
  '  hl deck ask      — spawn the decisions TUI, return a job handle | use when: posing material decisions\n' +
  '  hl deck update   — replace the deck of a LIVE ask job in place   | use when: the questions changed after ask\n' +
  '  hl deck validate — preflight a deck object, no side effects      | use when: checking a deck before ask\n' +
  '\n' +
  'A `deck update` rewrites the live job\'s deck.json; the TUI pane the\n' +
  'human is looking at reloads it automatically within ~1s (answers whose\n' +
  'interaction ids still exist are kept). Read this leaf\'s -h before calling\n' +
  'it — it mutates a session a human is actively in.',
);

deckCmd
  .command('ask')
  .description(
    'Kickoff: spawn the decisions TUI and return immediately.\n' +
    '\n' +
    'stdin  { deck: object (required), dir?: string|null,\n' +
    '         sessionId?: string|null, visuals?: bool=true, tmux?: bool=true }\n' +
    'stdout { job_id: string, dir: string (absolute), follow_up: string }\n' +
    '\n' +
    'Effects: writes <dir>/deck.json, <dir>/progress.json (live),\n' +
    '         <dir>/response.json (on finish), <dir>/job.log (JSONL).\n' +
    '         Spawns TUI detached in a tmux pane when tmux=true and $TMUX set.\n' +
    '         While the job is live the TUI watches <dir>/deck.json: a later\n' +
    '         `hl deck update` rewrites it and the pane reloads automatically.\n',
  )
  .helpOption('-h, --help', 'Show help')
  .action(async () => {
    type AskInput = {
      deck: unknown;
      dir?: string | null;
      sessionId?: string | null;
      visuals?: boolean;
      tmux?: boolean;
    };
    const input = parseStdinJson<AskInput>();

    if (!input.deck || typeof input.deck !== 'object') {
      emitError({
        error: 'bad_input',
        message: 'deck is required and must be an object',
        field: 'deck',
        next: "Run: echo '{\"kind\":\"deck\"}' | hl schema show",
      });
    }

    let deck: Deck;
    try {
      const _v = {}; void _v;
      deck = validateDeck(input.deck) as Deck;
    } catch (validationErr) {
      emitError({
        error: 'deck_invalid',
        message: `deck validation failed: ${validationErr instanceof Error ? validationErr.message : String(validationErr)}`,
        received: input.deck,
        next: "Fix the deck object. Run: echo '{\"deck\":{...}}' | hl deck validate",
      });
    }

    const dir = input.dir ? resolve(input.dir) : mkdtempSync(join(tmpdir(), 'hl-ix-'));
    mkdirSync(dir, { recursive: true });
    stampCanvasNode(deck);
    atomicWriteJson(deckPath(dir), deck);

    const jobId = basename(dir);
    const visuals = input.visuals !== false;
    const useTmux = input.tmux !== false;

    let sessionId: string | undefined;
    if (visuals) {
      if (input.sessionId && typeof input.sessionId === 'string') {
        sessionId = input.sessionId;
      } else {
        // dynamic import to avoid pulling heavy dep into parse path
        const { findRecentSessionId } = await import('./conversation/reader.js');
        sessionId = findRecentSessionId(process.cwd()) || findRecentSessionId() || undefined;
      }
    }

    appendJobLog(dir, { level: 'info', event: 'job_started', message: 'deck ask job started', data: { jobId } });

    if (INTERNAL_WRITE_TO) {
      // Child mode: run ask() in-process, write result to INTERNAL_WRITE_TO
      try {
        const result = await ask(deck, { dir, sessionId });
        appendJobLog(dir, { level: 'info', event: 'job_finished', message: 'deck resolved', data: { jobId } });
        writeFileSync(INTERNAL_WRITE_TO, JSON.stringify(result) + '\n');
        process.exit(0);
      } catch (askErr) {
        appendJobLog(dir, {
          level: 'error', event: 'job_failed',
          message: askErr instanceof Error ? askErr.message : String(askErr),
        });
        process.exit(1);
      }
    }

    if (process.env['TMUX'] && useTmux) {
      const scriptPath = process.argv[1];
      if (!scriptPath) {
        emitError({ error: 'internal', message: 'Cannot determine hl script path', next: 'Report this as a bug.' });
      }
      const sq = (s: string) =>
        /^[a-zA-Z0-9_\-./:@%+=]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
      const childInput = JSON.stringify({ deck, dir, sessionId, visuals, tmux: false });
      const cmd = `echo ${sq(childInput)} | ${sq(process.execPath)} ${sq(scriptPath)} deck ask`;
      try {
        execFileSync('tmux', ['split-window', '-d', '-h', cmd], { stdio: 'ignore' });
      } catch (spawnErr) {
        const msg = spawnErr instanceof Error ? spawnErr.message : String(spawnErr);
        appendJobLog(dir, { level: 'error', event: 'job_failed', message: `tmux spawn failed: ${msg}` });
        emitError({
          error: 'internal',
          message: `tmux spawn failed: ${msg}`,
          next: 'Check that $TMUX is set. Or pass tmux:false.',
        });
      }
      process.stdout.write(JSON.stringify({
        job_id: jobId,
        dir,
        follow_up: `Call hl job result with stdin {"job_id":"${jobId}","wait":true} to block until the human finishes. If the questions change before they answer, pipe {"job_id":"${jobId}","deck":{...}} to hl deck update — the pane reloads automatically.`,
      }) + '\n');
      process.exit(0);
    }

    // Non-tmux path: ask() runs in-process (will block or fail without TTY — degraded).
    appendJobLog(dir, { level: 'warn', event: 'job_started', message: 'no tmux; ask() runs in-process' });
    try {
      const result = await ask(deck, { dir, sessionId });
      appendJobLog(dir, { level: 'info', event: 'job_finished', message: 'deck resolved', data: { jobId } });
      writeFileSync(
        join(dir, 'response.json'),
        JSON.stringify({ responses: result.responses, completedAt: result.completedAt }, null, 2),
      );
      process.stdout.write(JSON.stringify({
        job_id: jobId,
        dir,
        follow_up: `Call hl job result with stdin {"job_id":"${jobId}","wait":true} to retrieve the result.`,
        _note: 'Non-tmux path: ask() blocked synchronously. Result is already available.',
      }) + '\n');
      process.exit(0);
    } catch (askErr) {
      const msg = askErr instanceof Error ? askErr.message : String(askErr);
      appendJobLog(dir, { level: 'error', event: 'job_failed', message: msg });
      emitError({
        error: 'internal',
        message: `ask() failed: ${msg}`,
        next: 'Set tmux:true (or run inside tmux) so the TUI can open an interactive pane.',
      });
    }
  });

deckCmd
  .command('update')
  .description(
    'Replace the deck of a LIVE ask job; the human\'s TUI pane reloads.\n' +
    '\n' +
    'stdin  { job_id: string (required), deck: object (required) }\n' +
    'stdout { ok: true, job_id: string, interactions: int, follow_up: string }\n' +
    '\n' +
    'The TUI watches deck.json and reloads within ~1s of this write. Answers\n' +
    'whose interaction id still exists in the new deck are preserved; new or\n' +
    'id-changed interactions appear unanswered. In-flight unsubmitted input\n' +
    '(a comment being typed) is discarded on reload.\n' +
    '\n' +
    'Errors: job_not_found (no such job_id) | job_not_live (already\n' +
    'done/failed/canceled — nothing to reload) | deck_invalid (deck rejected;\n' +
    'the old deck stays in place, run hl deck validate first).\n' +
    '\n' +
    'Effects: atomically rewrites <dir>/deck.json; appends a deck_updated\n' +
    'event to <dir>/job.log. No effect on response.json/progress.json.\n',
  )
  .helpOption('-h, --help', 'Show help')
  .action(() => {
    type UpdateInput = { job_id?: string; deck?: unknown };
    const input = parseStdinJson<UpdateInput>();
    if (!input.job_id || typeof input.job_id !== 'string') {
      emitError({ error: 'bad_input', message: 'job_id is required', field: 'job_id', next: 'Provide: {"job_id": "<id>", "deck": {...}}' });
    }
    if (!input.deck || typeof input.deck !== 'object') {
      emitError({ error: 'bad_input', message: 'deck is required and must be an object', field: 'deck', next: "Run: echo '{\"kind\":\"deck\"}' | hl schema show" });
    }
    const dir = resolveJobDir(input.job_id!);
    if (!existsSync(dir) || !existsSync(deckPath(dir))) {
      emitError({ error: 'job_not_found', message: `Job not found: ${input.job_id}`, next: 'Check the job_id returned by hl deck ask.' });
    }
    const state = detectJobState(dir);
    if (state !== 'live') {
      emitError({
        error: 'job_not_live',
        message: `Job is ${state}; its deck can no longer be reloaded.`,
        received: state,
        next: 'The human already finished. Start a fresh deck with hl deck ask.',
      });
    }
    let deck: Deck;
    try {
      const _v = {}; void _v;
      deck = validateDeck(input.deck) as Deck;
    } catch (validationErr) {
      emitError({
        error: 'deck_invalid',
        message: `deck validation failed: ${validationErr instanceof Error ? validationErr.message : String(validationErr)}`,
        received: input.deck,
        next: "The live deck is unchanged. Fix the deck, then: echo '{\"deck\":{...}}' | hl deck validate",
      });
    }
    atomicWriteJson(deckPath(dir), deck);
    appendJobLog(dir, {
      level: 'info', event: 'deck_updated',
      message: `deck replaced (${deck.interactions.length} interaction(s)); pane reloads on next watch tick`,
      data: { jobId: basename(dir), interactions: deck.interactions.length },
    });
    process.stdout.write(JSON.stringify({
      ok: true,
      job_id: basename(dir),
      interactions: deck.interactions.length,
      follow_up: `The pane reloads within ~1s. Still resolve with hl job result {"job_id":"${basename(dir)}","wait":true}.`,
    }) + '\n');
    process.exit(0);
  });

deckCmd
  .command('validate')
  .description(
    'Preflight deck validation — no side effects.\n' +
    '\n' +
    'stdin  { deck: object }\n' +
    'stdout { ok: bool, errors: [{field, message}] }\n' +
    'exit   0 if ok, 1 if invalid\n',
  )
  .helpOption('-h, --help', 'Show help')
  .action(() => {
    const input = parseStdinJson<{ deck?: unknown }>();
    if (!input.deck) {
      emitError({ error: 'bad_input', message: 'deck is required', field: 'deck', next: 'Provide: {"deck": {...}}' });
    }
    try {
      validateDeck(input.deck);
      process.stdout.write(JSON.stringify({ ok: true, errors: [] }) + '\n');
      process.exit(0);
    } catch (validationErr) {
      const errors = parseValidationErrors(validationErr);
      process.stdout.write(JSON.stringify({ ok: false, errors }) + '\n');
      process.exit(1);
    }
  });

function parseValidationErrors(e: unknown): Array<{ field: string; message: string }> {
  if (e && typeof e === 'object' && 'issues' in e) {
    const issues = (e as { issues: Array<{ path: unknown[]; message: string }> }).issues;
    return issues.map((iss) => ({ field: iss.path.join('.'), message: iss.message }));
  }
  return [{ field: '', message: e instanceof Error ? e.message : String(e) }];
}

// ── review ────────────────────────────────────────────────────────────────────

const reviewCmd = program.command('review').description('Markdown document review with anchored comments.');

reviewCmd
  .command('open')
  .description(
    'Open a read-only editor review and BLOCK until the human submits.\n' +
    '\n' +
    'stdin  { file: string (required, .md), output?: string|null,\n' +
    '         editor?: string|null, tmux?: bool=true }\n' +
    'stdout { job_id: string, output: string (absolute),\n' +
    '         status: "done"|"failed"|"canceled", result?: FeedbackResult }\n' +
    '\n' +
    'Effects: spawns nvim/vim read-only in a tmux pane when tmux=true and $TMUX\n' +
    '         set, then blocks until the human finishes and submits. Writes\n' +
    '         <dir>/review.vim, <dir>/feedback.json (on finish), <dir>/job.log.\n' +
    '         autosaves feedback JSON; the open pane live-reloads the source on\n' +
    '         disk edits. The review is open-ended (a human may take many\n' +
    '         minutes) — if you want to keep working, run this BACKGROUNDED; your\n' +
    '         harness notifies you when it returns with the result.\n',
  )
  .helpOption('-h, --help', 'Show help')
  .action(async () => {
    type ReviewInput = { file: string; output?: string | null; editor?: string | null; tmux?: boolean; dir?: string | null };
    const input = parseStdinJson<ReviewInput>();

    if (!input.file || typeof input.file !== 'string') {
      emitError({ error: 'bad_input', message: 'file is required', field: 'file', next: 'Provide: {"file": "/path/to/doc.md"}' });
    }
    const absFile = resolve(input.file);
    if (!existsSync(absFile)) {
      emitError({ error: 'file_not_found', message: `File not found: ${absFile}`, field: 'file', next: 'Check the file path.' });
    }

    const output = resolve(input.output ? input.output : `${absFile}.feedback.json`);
    const useTmux = input.tmux !== false;

    // Shared job dir: the detached child reuses the parent's via input.dir;
    // a top-level call mints one. The review.vim is written up front (and the
    // job_started logged) so the job is recognizable as a live review — and so
    // the child sources the exact vimscript — before any pane is spawned.
    const jobDir = input.dir ? resolve(input.dir) : mkdtempSync(join(tmpdir(), 'hl-review-'));
    mkdirSync(jobDir, { recursive: true });
    const jobId = basename(jobDir);
    if (!input.dir) {
      writeFileSync(join(jobDir, 'review.vim'), reviewVimscript());
      appendJobLog(jobDir, { level: 'info', event: 'job_started', message: 'review open job started', data: { jobId, file: absFile } });
    }

    // tmux path: detach a child that owns the editor pane and return the handle
    // now, mirroring `deck ask`. The child re-enters this leaf with tmux:false
    // and the shared dir, falling through to the in-process branch below.
    if (process.env['TMUX'] && useTmux) {
      const scriptPath = process.argv[1];
      if (!scriptPath) {
        emitError({ error: 'internal', message: 'Cannot determine hl script path', next: 'Report this as a bug.' });
      }
      const sq = (s: string) =>
        /^[a-zA-Z0-9_\-./:@%+=]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
      const childInput = JSON.stringify({ file: absFile, output, editor: input.editor ?? null, tmux: false, dir: jobDir });
      const cmd = `echo ${sq(childInput)} | ${sq(process.execPath)} ${sq(scriptPath)} review open`;
      try {
        execFileSync('tmux', ['split-window', '-d', '-h', cmd], { stdio: 'ignore' });
      } catch (spawnErr) {
        const msg = spawnErr instanceof Error ? spawnErr.message : String(spawnErr);
        appendJobLog(jobDir, { level: 'error', event: 'job_failed', message: `tmux spawn failed: ${msg}` });
        emitError({ error: 'internal', message: `tmux spawn failed: ${msg}`, next: 'Check that $TMUX is set. Or pass tmux:false.' });
      }
      // BLOCK until the human submits (or the job ends). The review is
      // open-ended — a human may take many minutes — so callers that want to
      // keep working should background this invocation; their harness notifies
      // them when it returns. Poll the shared job dir for feedback.json the
      // same way `hl job result --wait` does.
      await new Promise<void>((resolvePromise) => {
        const poll = setInterval(() => {
          const fp = join(jobDir, 'feedback.json');
          if (existsSync(fp)) {
            const result = tryParseJson<FeedbackResult>(readFileSync(fp, 'utf8'));
            if (result !== null) {
              clearInterval(poll);
              process.stdout.write(JSON.stringify({ job_id: jobId, output, status: 'done', result }) + '\n');
              process.exit(0);
            }
          }
          const state = detectJobState(jobDir);
          if (state === 'failed' || state === 'canceled') {
            clearInterval(poll);
            process.stdout.write(JSON.stringify({ job_id: jobId, output, status: state }) + '\n');
            process.exit(state === 'canceled' ? 0 : 1);
          }
        }, 200);
        void resolvePromise;
      });
      return;
    }

    // In-process path: the detached child (this pane is its TTY), or a degraded
    // top-level call with no tmux. launchReview blocks until the editor exits.
    try {
      const result = await launchReview(absFile, {
        output,
        editor: (input.editor && typeof input.editor === 'string') ? input.editor : undefined,
        noTmux: true,
        jobDir,
      });
      appendJobLog(jobDir, { level: 'info', event: 'job_finished', message: 'review finished', data: { comments: result.comments.length } });
      writeFileSync(join(jobDir, 'feedback.json'), JSON.stringify(result, null, 2));
      process.stdout.write(JSON.stringify({
        job_id: jobId,
        output,
        status: 'done',
        result,
        ...(input.dir ? {} : { _note: 'No tmux: launchReview blocked synchronously. Result is already available.' }),
      }) + '\n');
      process.exit(0);
    } catch (reviewErr) {
      const msg = reviewErr instanceof Error ? reviewErr.message : String(reviewErr);
      appendJobLog(jobDir, { level: 'error', event: 'job_failed', message: msg });
      if (msg.startsWith('Markdown file not found')) {
        emitError({ error: 'file_not_found', message: msg, next: 'Check the file path.' });
      }
      if (msg.startsWith('Editor not found') || msg.startsWith('No editor found')) {
        emitError({ error: 'editor_not_found', message: msg, next: 'Install Neovim (brew install neovim) or pass editor.' });
      }
      emitError({ error: 'internal', message: msg, next: 'Check stderr for details.' });
    }
  });

// ── view ──────────────────────────────────────────────────────────────────────

const viewCmd = program.command('view').description('Passive live render of a file in a tmux pane.');

viewCmd
  .command('show')
  .description(
    'Render a file live in a tmux pane — passive, no result.\n' +
    '\n' +
    'The pane always watches the file and live-updates on every save.\n' +
    '\n' +
    'stdin  { path: string (required), window?: "split"|"new"="split" }\n' +
    'stdout { pane_id: string|null, reason: string|null }\n' +
    'exit   0 always (not-in-tmux / renderer-unavailable is NOT an error)\n',
  )
  .helpOption('-h, --help', 'Show help')
  .action(() => {
    type ViewInput = { path: string; window?: 'split' | 'new' };
    const input = parseStdinJson<ViewInput>();
    if (!input.path || typeof input.path !== 'string') {
      emitError({ error: 'bad_input', message: 'path is required', field: 'path', next: 'Provide: {"path": "/abs/path/file.md"}' });
    }
    const absPath = resolve(input.path);
    const window = input.window === 'new' ? 'new' : 'split';
    const res = display(absPath, { window });
    if (res.paneId) {
      process.stdout.write(JSON.stringify({ pane_id: res.paneId, reason: null }) + '\n');
    } else {
      process.stdout.write(JSON.stringify({ pane_id: null, reason: 'Not in tmux or termrender unavailable.' }) + '\n');
    }
    process.exit(0);
  });

// ── doc ───────────────────────────────────────────────────────────────────────

const docCmd = program.command('doc').description(
  'Render or validate directive-flavored markdown to stdout.\n' +
  '\n' +
  'Children:\n' +
  '  hl doc check  — validate directive syntax, no output | use when: preflighting before write\n' +
  '  hl doc render — render markdown to ANSI/plain stdout | use when: piping rendered text to a file or consumer\n' +
  '\n' +
  'These wrap the pinned termrender binary that humanloop manages. Consumers\n' +
  'should never call `termrender` directly — go through hl/SDK so there is one\n' +
  'org-wide caller.\n',
);

docCmd
  .command('check')
  .description(
    'Validate directive-flavored markdown without rendering.\n' +
    '\n' +
    'stdin  { source?: string, path?: string }   exactly one required\n' +
    'stdout { ok: bool, error?: string }\n' +
    'exit   0 always (validation failures are not process errors)\n',
  )
  .helpOption('-h, --help', 'Show help')
  .action(() => {
    type CheckInput = { source?: string; path?: string };
    const input = parseStdinJson<CheckInput>();
    const src = resolveDocSource(input);
    const res = checkMarkdown(src);
    process.stdout.write(JSON.stringify(res) + '\n');
    process.exit(0);
  });

docCmd
  .command('render')
  .description(
    'Render directive-flavored markdown to ANSI or plain text on stdout.\n' +
    '\n' +
    'stdin  { source?: string, path?: string, width?: int=process.stdout.columns||100, color?: bool=true }\n' +
    'stdout the rendered text (raw bytes; not JSON)\n' +
    'exit   0 on success, non-zero on bad input\n' +
    '\n' +
    'When color=false, ANSI escape sequences are stripped from the output.\n' +
    'Use this for feeding rendered content to other agents that need plain\n' +
    'text without color codes.\n',
  )
  .helpOption('-h, --help', 'Show help')
  .action(() => {
    type RenderInput = { source?: string; path?: string; width?: number; color?: boolean };
    const input = parseStdinJson<RenderInput>();
    const src = resolveDocSource(input);
    const width = typeof input.width === 'number' && input.width > 0
      ? input.width
      : (process.stdout.columns || 100);
    const lines = renderMarkdown(src, width);
    let out = lines.join('\n');
    if (input.color === false) {
      // Strip ANSI escape sequences for plain-text consumers.
      // eslint-disable-next-line no-control-regex
      out = out.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
    }
    process.stdout.write(out);
    if (!out.endsWith('\n')) process.stdout.write('\n');
    process.exit(0);
  });

function resolveDocSource(input: { source?: string; path?: string }): string {
  const hasSource = typeof input.source === 'string' && input.source.length > 0;
  const hasPath = typeof input.path === 'string' && input.path.length > 0;
  if (hasSource === hasPath) {
    emitError({
      error: 'bad_input',
      message: 'provide exactly one of {source, path}',
      next: 'stdin like {"source": "..."} or {"path": "/abs/file.md"}',
    });
  }
  if (hasSource) return input.source!;
  const abs = resolve(input.path!);
  if (!existsSync(abs)) {
    emitError({ error: 'file_not_found', message: `path not found: ${abs}`, next: 'check the path' });
  }
  return readFileSync(abs, 'utf-8');
}

// ── inbox ─────────────────────────────────────────────────────────────────────

const inboxCmd = program.command('inbox').description('Browse and resolve pending interactions across root dirs.');

inboxCmd
  .command('list')
  .description(
    'Read-only paginated query of pending interactions.\n' +
    '\n' +
    'stdin  { roots: string[] (required, ≥1), limit?: int=20 (max 100), cursor?: string|null }\n' +
    'stdout { items: [{dir,title,askedBy,blockedSince,interactionCount}],\n' +
    '         next_cursor: string|null, total: int|null }\n' +
    'Sorted by blockedSince ascending.\n',
  )
  .helpOption('-h, --help', 'Show help')
  .action(() => {
    type ListInput = { roots: string[]; limit?: number; cursor?: string | null };
    const input = parseStdinJson<ListInput>();
    if (!Array.isArray(input.roots) || input.roots.length === 0) {
      emitError({ error: 'bad_input', message: 'roots must be a non-empty array', field: 'roots', next: 'Provide: {"roots": ["/path/to/inbox"]}' });
    }
    const roots = input.roots.map((r) => resolve(r));
    const limit = Math.min(typeof input.limit === 'number' ? input.limit : 20, 100);
    const allItems = scanInbox(roots);
    const total = allItems.length;
    let startIdx = 0;
    if (input.cursor) {
      const idx = allItems.findIndex((it) => it.dir === input.cursor);
      startIdx = idx >= 0 ? idx : 0;
    }
    const page = allItems.slice(startIdx, startIdx + limit);
    const nextCursor = startIdx + limit < total ? allItems[startIdx + limit]?.dir : null;
    const items = page.map((it) => {
      const dk = readJson<Deck>(deckPath(it.dir));
      return {
        dir: it.dir,
        title: it.title,
        askedBy: it.source?.askedBy,
        blockedSince: it.blockedSince,
        interactionCount: dk ? dk.interactions.length : 1,
      };
    });
    process.stdout.write(JSON.stringify({
      items,
      next_cursor: nextCursor !== undefined ? nextCursor : null,
      total,
    }) + '\n');
    process.exit(0);
  });

inboxCmd
  .command('resolve')
  .description(
    'Kickoff: spawn the inbox-walker TUI detached.\n' +
    '\n' +
    'stdin  { roots: string[] (required) }\n' +
    'stdout { job_id: string, follow_up: string }\n',
  )
  .helpOption('-h, --help', 'Show help')
  .action(async () => {
    type ResolveInput = { roots: string[] };
    const input = parseStdinJson<ResolveInput>();
    if (!Array.isArray(input.roots) || input.roots.length === 0) {
      emitError({ error: 'bad_input', message: 'roots must be a non-empty array', field: 'roots', next: 'Provide: {"roots": ["/path/to/inbox"]}' });
    }
    const roots = input.roots.map((r) => resolve(r));
    const jobDir = mkdtempSync(join(tmpdir(), 'hl-inbox-'));
    const jobId = basename(jobDir);
    appendJobLog(jobDir, { level: 'info', event: 'job_started', message: 'inbox resolve job started', data: { jobId, roots } });
    try {
      await inbox(roots);
      appendJobLog(jobDir, { level: 'info', event: 'job_finished', message: 'inbox resolved', data: { jobId } });
      process.stdout.write(JSON.stringify({
        job_id: jobId,
        follow_up: `Inbox walk complete. Call hl job result with stdin {"job_id":"${jobId}"} for summary.`,
      }) + '\n');
      process.exit(0);
    } catch (inboxErr) {
      const msg = inboxErr instanceof Error ? inboxErr.message : String(inboxErr);
      appendJobLog(jobDir, { level: 'error', event: 'job_failed', message: msg });
      emitError({ error: 'internal', message: msg, next: 'Ensure the roots are valid directories.' });
    }
  });

// ── job ───────────────────────────────────────────────────────────────────────

const jobCmd = program.command('job').description('Inspect, wait on, or cancel running jobs.');

jobCmd
  .command('status')
  .description(
    'Read-only job state snapshot.\n' +
    '\n' +
    'stdin  { job_id: string }\n' +
    'stdout { state: "live"|"done"|"failed"|"canceled", kind: "deck"|"review"|"inbox",\n' +
    '         age_seconds: number, last_event: {ts,event,message}|null }\n',
  )
  .helpOption('-h, --help', 'Show help')
  .action(() => {
    const input = parseStdinJson<{ job_id?: string }>();
    if (!input.job_id || typeof input.job_id !== 'string') {
      emitError({ error: 'bad_input', message: 'job_id is required', field: 'job_id', next: 'Provide: {"job_id": "<id>"}' });
    }
    const dir = resolveJobDir(input.job_id);
    if (!existsSync(dir)) {
      emitError({ error: 'job_not_found', message: `Job not found: ${input.job_id}`, next: 'Check the job_id.' });
    }
    let ageSecs = 0;
    try {
      const _st = {}; void _st;
      const st = statSync(dir);
      ageSecs = Math.round((Date.now() - st.birthtimeMs) / 1000);
    } catch (statErr) {
      void String(statErr); // stat unavailable — report 0
    }
    const state = detectJobState(dir);
    const kind = detectJobKind(dir);
    const last = lastLogEvent(dir);
    process.stdout.write(JSON.stringify({
      state,
      kind,
      age_seconds: ageSecs,
      last_event: last ? { ts: last.ts, event: last.event, message: last.message } : null,
    }) + '\n');
    process.exit(0);
  });

function tryReadJobResult(dir: string, kind: JobKind): unknown | null {
  if (kind === 'deck') {
    const rp = responsePath(dir);
    if (!existsSync(rp)) return null;
    const raw = tryParseJson<{ responses: unknown[]; completedAt: string }>(
      readFileSync(rp, 'utf8'),
    );
    if (!raw) return null;
    const dk = readJson<Deck>(deckPath(dir));
    return {
      summary: '',
      responsePath: rp,
      schema: 'humanloop.response/v2',
      responses: raw.responses,
      completedAt: raw.completedAt,
      _note: dk ? `Deck had ${dk.interactions.length} interaction(s)` : undefined,
    };
  }
  if (kind === 'review') {
    const fp = join(dir, 'feedback.json');
    if (!existsSync(fp)) return null;
    return tryParseJson<FeedbackResult>(readFileSync(fp, 'utf8'));
  }
  // inbox
  const logPath = jobLogPath(dir);
  if (!existsSync(logPath)) return null;
  if (detectJobState(dir) !== 'done') return null;
  const lines = readLogLines(logPath);
  let resolved = 0;
  for (const line of lines) {
    const entry = tryParseJson<LogEntry>(line);
    if (entry && entry.event === 'inbox_resolved') resolved++;
  }
  return { resolved };
}

jobCmd
  .command('result')
  .description(
    'Retrieve terminal payload of a finished job.\n' +
    '\n' +
    'stdin  { job_id: string, wait?: bool=false }\n' +
    'stdout deck   → ResolutionEnvelope (humanloop.response/v2)\n' +
    '       review → FeedbackResult\n' +
    '       inbox  → { resolved: int }\n' +
    '       not done + wait:false → { error:"not_ready", ... } exit 1\n' +
    '       wait:true blocks until sidecar appears or job terminates.\n',
  )
  .helpOption('-h, --help', 'Show help')
  .action(async () => {
    const input = parseStdinJson<{ job_id?: string; wait?: boolean }>();
    if (!input.job_id || typeof input.job_id !== 'string') {
      emitError({ error: 'bad_input', message: 'job_id is required', field: 'job_id', next: 'Provide: {"job_id": "<id>", "wait": true}' });
    }
    const dir = resolveJobDir(input.job_id);
    if (!existsSync(dir)) {
      emitError({ error: 'job_not_found', message: `Job not found: ${input.job_id}`, next: 'Check the job_id.' });
    }
    const wait = input.wait === true;
    const kind = detectJobKind(dir);

    if (!wait) {
      const result = tryReadJobResult(dir, kind);
      if (result === null) {
        emitError({ error: 'not_ready', message: 'Job is not yet complete.', next: 'Retry with wait:true to block until done.' }, 1);
      }
      process.stdout.write(JSON.stringify(result) + '\n');
      process.exit(0);
    }

    await new Promise<void>((resolvePromise) => {
      const poll = setInterval(() => {
        const result = tryReadJobResult(dir, kind);
        if (result !== null) {
          clearInterval(poll);
          process.stdout.write(JSON.stringify(result) + '\n');
          process.exit(0);
        }
        const state = detectJobState(dir);
        if (state === 'failed' || state === 'canceled') {
          clearInterval(poll);
          emitError({ error: 'not_ready', message: `Job ended with state: ${state}`, next: 'Check hl job logs for details.' }, 1);
        }
      }, 200);
      void resolvePromise;
    });
  });

jobCmd
  .command('logs')
  .description(
    'Stream job.log events (JSONL).\n' +
    '\n' +
    'stdin  { job_id: string, since?: string|null,\n' +
    '         level?: "debug"|"info"|"warn"|"error"="info", follow?: bool=false }\n' +
    'stdout JSONL — one event per line: { ts, level, event, message, data? }\n' +
    'follow:false → emit historical then exit; follow:true → stream until done.\n',
  )
  .helpOption('-h, --help', 'Show help')
  .action(async () => {
    type LogsInput = { job_id?: string; since?: string | null; level?: LogLevel; follow?: boolean };
    const input = parseStdinJson<LogsInput>();
    if (!input.job_id || typeof input.job_id !== 'string') {
      emitError({ error: 'bad_input', message: 'job_id is required', field: 'job_id', next: 'Provide: {"job_id": "<id>"}' });
    }
    const dir = resolveJobDir(input.job_id);
    if (!existsSync(dir)) {
      emitError({ error: 'job_not_found', message: `Job not found: ${input.job_id}`, next: 'Check the job_id.' });
    }
    const levelOrder: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
    const inputLevel: LogLevel = (input.level && input.level in levelOrder) ? input.level : 'info';
    const minLevel = levelOrder[inputLevel];
    const since = input.since;
    const follow = input.follow === true;
    const logPath = jobLogPath(dir);
    let emittedCount = 0;

    function emitLogLines(): void {
      const lines = readLogLines(logPath);
      for (let i = emittedCount; i < lines.length; i++) {
        const entry = tryParseJson<LogEntry>(lines[i]!);
        if (!entry) continue;
        if (since && entry.ts <= since) continue;
        const entryLevel = entry.level in levelOrder ? levelOrder[entry.level] : 0;
        if (entryLevel < minLevel) continue;
        process.stdout.write(JSON.stringify(entry) + '\n');
      }
      emittedCount = lines.length;
    }

    emitLogLines();
    if (!follow) {
      process.exit(0);
    }
    await new Promise<void>((resolvePromise) => {
      const poll = setInterval(() => {
        emitLogLines();
        const state = detectJobState(dir);
        if (state === 'done' || state === 'failed' || state === 'canceled') {
          clearInterval(poll);
          process.exit(0);
        }
      }, 200);
      void resolvePromise;
    });
  });

jobCmd
  .command('cancel')
  .description(
    'Best-effort cancel: signal the job pane and close it if possible.\n' +
    '\n' +
    'stdin  { job_id: string }\n' +
    'stdout { canceled: bool, message: string }\n',
  )
  .helpOption('-h, --help', 'Show help')
  .action(() => {
    const input = parseStdinJson<{ job_id?: string }>();
    if (!input.job_id || typeof input.job_id !== 'string') {
      emitError({ error: 'bad_input', message: 'job_id is required', field: 'job_id', next: 'Provide: {"job_id": "<id>"}' });
    }
    const dir = resolveJobDir(input.job_id);
    if (!existsSync(dir)) {
      emitError({ error: 'job_not_found', message: `Job not found: ${input.job_id}`, next: 'Check the job_id.' });
    }
    let canceled = false;
    let message = 'No tmux pane found; signal not delivered (job may already be done).';
    if (process.env['TMUX']) {
      try {
        const panes = execFileSync('tmux', ['list-panes', '-a', '-F', '#{pane_id} #{pane_current_command}'], { encoding: 'utf8' });
        for (const line of panes.split('\n')) {
          const paneId = line.split(' ')[0];
          if (!paneId) continue;
          try {
            execFileSync('tmux', ['send-keys', '-t', paneId, 'q', ''], { stdio: 'ignore' });
          } catch (sendErr) {
            void String(sendErr); // best-effort per pane
          }
        }
        canceled = true;
        message = 'Signal delivered to tmux pane(s).';
      } catch (tmuxErr) {
        message = `tmux pane lookup failed: ${tmuxErr instanceof Error ? tmuxErr.message : String(tmuxErr)}`;
      }
    }
    appendJobLog(dir, { level: 'info', event: 'job_canceled', message: `cancel requested: ${message}` });
    process.stdout.write(JSON.stringify({ canceled, message }) + '\n');
    process.exit(0);
  });

// ── schema ────────────────────────────────────────────────────────────────────

const schemaCmd = program.command('schema').description('Print JSON Schemas for hl data types.');

schemaCmd
  .command('show')
  .description(
    'Print the JSON Schema for a data kind.\n' +
    '\n' +
    'stdin  { kind?: "deck"|"resolution"|"feedback"="deck" }\n' +
    'stdout the JSON Schema object\n',
  )
  .helpOption('-h, --help', 'Show help')
  .action(() => {
    const input = parseStdinJson<{ kind?: string }>();
    const kind = (typeof input.kind === 'string' && input.kind) ? input.kind : 'deck';
    if (kind === 'resolution') {
      process.stdout.write(JSON.stringify(RESPONSE_SCHEMA, null, 2) + '\n');
    } else if (kind === 'feedback') {
      process.stdout.write(JSON.stringify(FEEDBACK_SCHEMA, null, 2) + '\n');
    } else if (kind === 'deck') {
      process.stdout.write(JSON.stringify(REQUEST_SCHEMA, null, 2) + '\n');
    } else {
      emitError({
        error: 'bad_input',
        message: `Unknown kind: ${kind}. Valid: deck, resolution, feedback`,
        field: 'kind',
        next: 'Provide: {"kind": "deck"} or {"kind": "resolution"} or {"kind": "feedback"}',
      });
    }
  });

program.parse();
