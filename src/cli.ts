#!/usr/bin/env node

import { Command, Option } from 'commander';
import { writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { resolve, join } from 'path';
import { dispatchToTmuxPane } from './tui/tmux.js';
import { findRecentSessionId } from './conversation/reader.js';
import { launchReview, formatFeedbackSummary } from './editor/review.js';
import { parseDeck } from './inbox/deck-schema.js';
import { ask, inbox } from './api.js';
import { display } from './surfaces/display.js';

const program = new Command();

program
  .name('hl')
  .description(
    'Human-in-the-loop decision TUI.\n' +
    '\n' +
    'Use this when you (the agent) need the human to make a material decision\n' +
    'before continuing — design tradeoffs, approval gates, picks between real\n' +
    'alternatives. Blocks on an interactive TUI and returns answers as JSON.\n' +
    'Reach for it when you have 2+ structured questions, or one decision with\n' +
    'genuine tradeoffs; for a single freetext question, ask inline instead.\n' +
    '\n' +
    'AUDIENCE — the deck you write is read by a busy, technical human. Use\n' +
    'progressive disclosure so the reader can stop at any layer:\n' +
    '  • title    — noun-phrase topic (≤4 words). Scannable like an inbox.\n' +
    '  • subtitle — TL;DR. One plain sentence framing the choice or stakes.\n' +
    '  • body     — ELI12 markdown. Plain language up top, deeper material\n' +
    '               under a heading the reader can skip.\n' +
    'The reader can connect dots — do not write engineer-to-engineer jargon.\n' +
    'See `hl ask --help` for content guidance and a worked example.\n' +
    '\n' +
    'Workflow:\n' +
    '  1. Write a deck file matching `hl schema` (a JSON object with interactions[]).\n' +
    '  2. Run `hl ask <file>`; it blocks and prints a ResolutionEnvelope JSON to stdout.\n' +
    '  3. Parse the JSON; look up answers by `id` (humans can skip questions).',
  )
  .version('0.1.0')
  .addHelpText(
    'after',
    '\nExamples:\n' +
    '  hl schema                          # print the input JSON schema\n' +
    '  hl schema response                 # print the resolution-envelope schema\n' +
    '  hl ask deck.json                   # open TUI, block, print envelope JSON\n' +
    '  hl ask deck.json --dir /tmp/ix     # store progress/response.json in /tmp/ix\n' +
    '  hl ask deck.json --no-tmux         # run in current pane even inside tmux\n' +
    '  hl inbox /tmp/box                  # resolve pending interactions under a root\n' +
    '  hl display plan.md                 # live-render a file in a tmux pane\n',
  );

program
  .command('ask')
  .description(
    'Open the decisions TUI on <file> and block until the human finishes review.\n' +
    'Prints a ResolutionEnvelope JSON to stdout (or to --output / --write-to).',
  )
  .argument('<file>', 'Path to deck JSON file (see `hl schema` for format)')
  .option('--dir <interaction-dir>', 'Interaction directory holding progress.json/response.json. Default: a managed temp dir under os.tmpdir().')
  .option('--session-id <id>', 'Claude session ID; enables per-interaction visual context from conversation history. Defaults to the most recent session in cwd.')
  .option('--no-visuals', 'Skip visual context generation (faster, no haiku calls)')
  .option('--output <path>', 'Write result JSON to <path> instead of stdout')
  .option('--no-tmux', 'Do not auto-dispatch the TUI to a new tmux pane even when $TMUX is set')
  .addOption(new Option('--write-to <path>', 'internal: tmux child mode').hideHelp())
  .addHelpText(
    'after',
    '\n' +
    'CONTENT — what to write in each interaction\n' +
    '  The deck is read by a busy, technical human. Use progressive\n' +
    '  disclosure so the reader can stop at any layer:\n' +
    '\n' +
    '    title      Noun-phrase topic (≤4 words). The *thing* being\n' +
    '               decided, not the decision. \'Database\' not \'Use\n' +
    '               Postgres\'. The reader scans titles like an inbox.\n' +
    '    subtitle   TL;DR — one plain-English sentence framing the\n' +
    '               choice or stakes. Action-ready if the call is\n' +
    '               obvious. No jargon, no library names without\n' +
    '               context.\n' +
    '    body       ELI12 markdown. Audience: a smart engineer joining\n' +
    '               the codebase — capable, but does not want a wall of\n' +
    '               jargon. Lead with what is at stake in plain language.\n' +
    '               Tuck anything denser (technical specifics, alternatives\n' +
    '               considered, edge cases, related context) under a\n' +
    '               heading like `## Details` or `## Alternatives` so the\n' +
    '               reader can skip past it. Every layer below the TL;DR\n' +
    '               is optional reading.\n' +
    '\n' +
    '  AVOID: walls of jargon; raw schema dumps or stack traces in body;\n' +
    '  titles that bury the topic; subtitles that restate the title;\n' +
    '  options that are not real alternatives; asking the human anything\n' +
    '  you could decide yourself from the code.\n' +
    '\n' +
    'INPUT FORMAT\n' +
    '  JSON file with an `interactions` array. Each interaction has an `id`,\n' +
    '  `title`, `options[]`, and optional `subtitle`, `body`, `allowFreetext`.\n' +
    '  Run `hl schema` for the full schema. Example with pyramid content:\n' +
    '    {\n' +
    '      "interactions": [\n' +
    '        {\n' +
    '          "id": "db",\n' +
    '          "title": "Database",\n' +
    '          "subtitle": "Postgres or SQLite for the new capture store?",\n' +
    '          "body": "Two services will write at the same time, which is the crux.\\n\\nPostgres handles concurrent writes natively. SQLite serializes them — fine at low traffic, but we expect bursts.\\n\\n## Details\\nSQLite WAL still serializes writers; Postgres uses MVCC.",\n' +
    '          "options": [\n' +
    '            {"id":"pg","label":"Postgres"},\n' +
    '            {"id":"sqlite","label":"SQLite"}\n' +
    '          ],\n' +
    '          "allowFreetext": true\n' +
    '        },\n' +
    '        {\n' +
    '          "id": "retry",\n' +
    '          "title": "Retry policy",\n' +
    '          "subtitle": "How aggressively should we retry publish failures?",\n' +
    '          "body": "Affects the reliability budget. Too aggressive and we hammer downstream during outages; too lax and transient blips become user-visible.",\n' +
    '          "options": [],\n' +
    '          "allowFreetext": true\n' +
    '        }\n' +
    '      ]\n' +
    '    }\n' +
    '\n' +
    'OUTPUT FORMAT (stdout on success, JSON — a ResolutionEnvelope)\n' +
    '  {\n' +
    '    "summary": "<one line per answered interaction>",\n' +
    '    "responsePath": "/abs/path/to/<dir>/response.json",\n' +
    '    "schema": "humanloop.response/v2",\n' +
    '    "responses": [ ... ],\n' +
    '    "completedAt": "2026-04-20T15:23:00.000Z"\n' +
    '  }\n' +
    '\n' +
    '  On-disk <dir>/response.json holds only { responses, completedAt }.\n' +
    '  Run `hl schema response` for the envelope schema.\n' +
    '\n' +
    '  Response shape:\n' +
    '    { id: string, selectedOptionId?: string, freetext?: string }\n' +
    '\n' +
    '  The human can skip interactions. `responses` may have FEWER entries than\n' +
    '  input interactions — look up by `id`, do not assume index alignment.\n' +
    '\n' +
    'BEHAVIOR\n' +
    '  tmux       When $TMUX is set, the TUI auto-splits into a new pane to the\n' +
    '             right (-d keeps focus on the caller). Disable with --no-tmux.\n' +
    '  storage    progress.json/response.json live in --dir (default: a managed\n' +
    '             temp dir). Responses persist atomically after every change;\n' +
    '             a hard kill resumes from progress.json on the next run.\n' +
    '             response.json is written when the human finishes.\n' +
    '  visuals    With --session-id (or auto-detected) haiku generates a short\n' +
    '             ANSI context block per interaction from recent conversation turns.\n' +
    '\n' +
    'EXIT CODES\n' +
    '  0  success — result JSON emitted\n' +
    '  1  error — message on stderr (file missing, invalid JSON, empty\n' +
    '     interactions, no TTY, etc.)\n',
  )
  .action(async (file: string, opts: { dir?: string; sessionId?: string; visuals: boolean; output?: string; tmux: boolean; writeTo?: string }) => {
    const sessionId = opts.visuals
      ? (opts.sessionId || findRecentSessionId(process.cwd()) || findRecentSessionId() || undefined)
      : undefined;

    const dir = opts.dir ? resolve(opts.dir) : mkdtempSync(join(tmpdir(), 'hl-ix-'));

    const emit = (result: unknown) => {
      const json = JSON.stringify(result, null, 2) + '\n';
      if (opts.writeTo) {
        writeFileSync(opts.writeTo, json);
      } else if (opts.output) {
        writeFileSync(opts.output, json);
      } else {
        process.stdout.write(json);
      }
    };

    try {
      if (process.env.TMUX && opts.tmux && !opts.writeTo) {
        try {
          const result = await dispatchToTmuxPane(file, { sessionId, visuals: opts.visuals, dir });
          emit(result);
          process.exit(0);
        } catch (err) {
          process.stderr.write(`tmux dispatch failed, running locally: ${err instanceof Error ? err.message : String(err)}\n`);
        }
      }

      const deck = parseDeck(resolve(file));
      const result = await ask(deck, { dir, sessionId });
      emit(result);
      process.exit(0);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`ERROR: ${msg}\n`);
      if (msg.includes('ENOENT') || msg.includes('no such file')) {
        process.stderr.write('\nFix: pass a path to an existing deck JSON file.\nSee format: hl schema\n');
      } else if (msg.includes('not valid JSON') || msg.includes('JSON')) {
        process.stderr.write('\nFix: the deck file must be valid JSON matching `hl schema`.\n');
      } else if (msg.includes('TTY')) {
        process.stderr.write('\nFix: hl needs an interactive terminal. If the caller captures stdin,\nrun inside tmux so hl can auto-dispatch the TUI to a new pane, or pipe\nstdin from /dev/tty.\n');
      } else {
        process.stderr.write('\nFix: the deck file must match `hl schema`. Run `hl schema` to see the required shape.\n');
      }
      process.exit(1);
    }
  });

program
  .command('inbox')
  .description(
    'Resolve pending interactions across one or more root directories.\n' +
    'Each root\'s immediate subdirs are treated as interaction dirs (a dir\n' +
    'with deck.json and no response.json is pending). Lists them, lets the\n' +
    'human pick and resolve one at a time, writing each response.json.',
  )
  .argument('<roots...>', 'Root dir(s) whose immediate subdirs are interaction dirs')
  .addHelpText(
    'after',
    '\n' +
    'BEHAVIOR\n' +
    '  Runs in the current terminal (requires a TTY). Up/down (or j/k) to\n' +
    '  navigate, enter to resolve the selected interaction, q/esc to quit.\n' +
    '  After each resolution the list rescans — resolved items drop out.\n' +
    '\n' +
    'EXIT CODES\n' +
    '  0  finished (human quit, or nothing pending)\n' +
    '  1  error (no TTY, unreadable root, etc.)\n' +
    '\n' +
    'Examples:\n' +
    '  hl inbox /tmp/box\n' +
    '  hl inbox ~/.sisyphus/asks ~/.crtr/pending\n',
  )
  .action(async (roots: string[]) => {
    try {
      await inbox(roots.map((r) => resolve(r)));
      process.exit(0);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`ERROR: ${msg}\n`);
      if (msg.includes('TTY')) {
        process.stderr.write('\nFix: hl inbox needs an interactive terminal.\n');
      }
      process.exit(1);
    }
  });

program
  .command('display')
  .description(
    'Render <path> live in a tmux pane (via the managed termrender). The pane\n' +
    'live-updates as the file changes. Auto-splits, or opens a new window when\n' +
    'the current window is at its pane budget.',
  )
  .argument('<path>', 'Path to the markdown/text file to render')
  .option('--no-watch', 'Render once instead of live-watching the file')
  .option('--new-window', 'Open in a new tmux window instead of splitting the current one')
  .addHelpText(
    'after',
    '\n' +
    'EXIT CODES\n' +
    '  0  spawned (prints the pane id) — or no-op when not in tmux / renderer\n' +
    '     unavailable (message on stderr)\n' +
    '\n' +
    'Examples:\n' +
    '  hl display plan.md\n' +
    '  hl display plan.md --no-watch\n' +
    '  hl display plan.md --new-window\n',
  )
  .action((path: string, opts: { watch: boolean; newWindow?: boolean }) => {
    const res = display(resolve(path), {
      watch: opts.watch,
      window: opts.newWindow ? 'new' : 'auto',
    });
    if (res.paneId) {
      process.stdout.write(`opened in tmux pane ${res.paneId} (live — edits to the file refresh the view)\n`);
    } else {
      process.stderr.write('display: no pane opened (not in tmux, or termrender unavailable)\n');
    }
    process.exit(0);
  });

program
  .command('propose')
  .description(
    'Open a markdown document in a read-only editor review session and block\n' +
    'until the human finishes and quits. Use this when you have produced a\n' +
    'document (plan, design doc, spec, draft) and need targeted human review\n' +
    'before continuing — not a structured decision (use `hl ask` for that).',
  )
  .argument('<file>', 'Path to the markdown (.md) file to get feedback on')
  .option('--output <path>', 'Path for the answers JSON (live autosave + finalized on exit). Default: <file>.feedback.json')
  .option('--editor <bin>', 'Editor binary to use. Default: first of nvim, vim on PATH')
  .option('--no-tmux', 'Run the editor in the current terminal instead of a tmux split pane')
  .addHelpText(
    'after',
    '\n' +
    'WHAT THIS IS FOR\n' +
    '  Freeform review of a markdown doc you wrote. The human leaves comments\n' +
    '  anchored to real source lines or visual selections using native vim\n' +
    '  keybindings — you do not predefine questions; the human tells you what\n' +
    '  is wrong and where.\n' +
    '\n' +
    'BEHAVIOR\n' +
    '  • Opens the file READ-ONLY in a CLEAN editor (nvim -u NONE: no\n' +
    '    init.lua / LazyVim / plugins / keymaps). Look/feel is ONLY the\n' +
    '    user\'s gloam colorscheme + built-in treesitter markdown\n' +
    '    highlighting. Review keys are buffer-scoped on <Space>,\n' +
    '    plus :HL* commands.\n' +
    '  • When $TMUX is set, opens in a split pane (disable with --no-tmux);\n' +
    '    otherwise takes over the current terminal.\n' +
    '  • Comments autosave to the answers JSON continuously. A killed/closed\n' +
    '    session RESUMES from the autosave on next run.\n' +
    '  • ANY quit submits. On editor exit the JSON is finalized (submitted:true)\n' +
    '    and echoed to stdout, then the command exits 0.\n' +
    '  • Quitting with zero comments sets approved:true ("looks good").\n' +
    '\n' +
    '  In-editor (<Space> maps; or use the :HL* commands):\n' +
    '    <Space>c / :HLComment   Comment on the visual selection or current line\n' +
    '    <Space>l / :HLList      Toggle comments list\n' +
    '    <Space>u / :HLUndo      Undo last comment\n' +
    '    <Space>s / :HLSubmit    Submit & quit\n' +
    '\n' +
    'OUTPUT\n' +
    '  stdout is a COMPACT listing (kept small so it does not clog context):\n' +
    '  a header with the source path, then per comment:\n' +
    '\n' +
    '     1. L46:5-35\n' +
    '        text:    <the original text in that span>\n' +
    '        comment: <the human\'s note>\n' +
    '\n' +
    '  Range is L<line> (whole line), L<line>:<colStart>-<colEnd> (partial\n' +
    '  selection), or L<l1>-<l2> / L<l1>:<c1>-<l2>:<c2> across lines. text\n' +
    '  is the exact selected quote, or the whole line(s) when there was no\n' +
    '  partial selection. Zero comments => "approved" (looks good, proceed).\n' +
    '\n' +
    '  The FULL record is written to --output (default <file>.feedback.json);\n' +
    '  stdout ends with its path + this schema (read the file only if you\n' +
    '  actually need the verbose fields — usually you do not):\n' +
    '    {file, submitted, approved,\n' +
    '     comments:[{id, line, endLine, quote?, colStart?, colEnd?,\n' +
    '                lineText, comment, createdAt}],\n' +
    '     submittedAt, savedAt}\n' +
    '  cols are 0-based byte offsets, colEnd exclusive. Act on each comment\n' +
    '  via the source path + range (quote/cols when present).\n' +
    '\n' +
    'EXIT CODES\n' +
    '  0  finished — feedback summary emitted\n' +
    '  1  error (file missing, no nvim/vim found)\n' +
    '\n' +
    'Examples:\n' +
    '  hl propose plan.md\n' +
    '  hl propose plan.md --output /tmp/fb.json\n' +
    '  hl propose plan.md --no-tmux\n' +
    '  hl propose plan.md --editor vim\n',
  )
  .action(async (file: string, opts: { output?: string; editor?: string; tmux: boolean }) => {
    try {
      const output = opts.output ?? `${file}.feedback.json`;
      const result = await launchReview(file, { output, editor: opts.editor, noTmux: !opts.tmux });
      process.stdout.write(formatFeedbackSummary(result, resolve(output)) + '\n');
      process.exit(0);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`ERROR: ${msg}\n`);
      if (msg.startsWith('Markdown file not found')) {
        process.stderr.write('\nFix: pass a path to an existing markdown file.\n');
      } else if (msg.startsWith('Editor not found') || msg.startsWith('No editor found')) {
        process.stderr.write('\nFix: install Neovim (`brew install neovim`) or pass --editor <path>.\n');
      }
      process.exit(1);
    }
  });

const REQUEST_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  description: 'Input schema for hl ask (v2)',
  type: 'object',
  required: ['interactions'],
  properties: {
    title: {
      type: 'string',
      description: 'Optional deck title shown in the TUI header',
    },
    interactions: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['id', 'title', 'options'],
        properties: {
          id: { type: 'string', description: 'Unique identifier. Used to look up answers in the output — never assume index alignment.' },
          title: { type: 'string', description: 'Noun-phrase topic (≤4 words) — the *thing* being decided, not the decision. \'Database\' not \'Use Postgres\'. The reader scans titles like an inbox.' },
          subtitle: { type: 'string', description: 'TL;DR — one plain-English sentence framing the choice or stakes. Action-ready if the call is obvious. No jargon, no library names without context.' },
          body: { type: 'string', description: 'ELI12 markdown. Audience: a smart engineer joining the codebase — capable, but does not want a wall of jargon. Lead with what is at stake in plain language. Tuck anything denser (technical specifics, alternatives considered, edge cases) under a heading like `## Details` or `## Alternatives` so the reader can skip past. Every layer below the TL;DR is optional reading.' },
          bodyPath: { type: 'string', description: 'Path to a markdown file used in place of `body`; inlined before mount, resolved relative to the deck JSON\'s directory and confined to it. Same content guidance as `body`.' },
          options: {
            type: 'array',
            description: 'Selectable choices. Empty for freetext-only interactions.',
            items: {
              type: 'object',
              required: ['id', 'label'],
              properties: {
                id: { type: 'string' },
                label: { type: 'string' },
                description: { type: 'string' },
                shortcut: {
                  type: 'string',
                  description: 'Single char shortcut. Auto-assigned if absent. Avoid: c r n p q j k space',
                },
              },
            },
          },
          allowFreetext: {
            type: 'boolean',
            description: 'If true, user can add a freetext comment (or respond freely if options is empty)',
          },
          freetextLabel: {
            type: 'string',
            description: 'Prompt shown above the freetext input. Default: "Comment" or "Response"',
          },
          kind: {
            type: 'string',
            enum: ['notify', 'validation', 'decision', 'context', 'error'],
            description: 'Display hint — opaque to humanloop, used by consumers for inbox icons',
          },
        },
      },
    },
  },
};

const RESPONSE_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'humanloop.response/v2',
  description: 'Resolution envelope emitted by `hl ask` / returned by ask(). The on-disk <dir>/response.json holds only { responses, completedAt }; responsePath points at it.',
  type: 'object',
  required: ['summary', 'responsePath', 'schema', 'responses', 'completedAt'],
  properties: {
    summary: {
      type: 'string',
      description: 'Deterministic, no-LLM. One line per answered interaction: "<title>: <option label>[ — <freetext>]".',
    },
    responsePath: {
      type: 'string',
      description: 'Absolute path to the on-disk response.json ({ responses, completedAt }).',
    },
    schema: {
      const: 'humanloop.response/v2',
      description: 'Identifies this response contract.',
    },
    responses: {
      type: 'array',
      description: 'Inline answers. May have FEWER entries than input interactions — humans can skip. Look up by id.',
      items: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string' },
          selectedOptionId: { type: 'string' },
          freetext: { type: 'string' },
        },
      },
    },
    completedAt: {
      type: 'string',
      description: 'ISO 8601 timestamp when the human finished.',
    },
  },
};

program
  .command('schema')
  .description('Print a JSON Schema. `request` (default) = the `hl ask` deck input; `response` = the resolution envelope.')
  .argument('[kind]', 'request | response', 'request')
  .addHelpText(
    'after',
    '\n' +
    'Use `request` to learn the input format for `hl ask`; `response` to learn\n' +
    'the envelope `hl ask` prints (schema id "humanloop.response/v2").\n' +
    '\n' +
    'Examples:\n' +
    '  hl schema > deck.schema.json       # save the request schema\n' +
    '  hl schema response | jq            # pretty-print the response schema\n',
  )
  .action((kind: string) => {
    const schema = kind === 'response' ? RESPONSE_SCHEMA : REQUEST_SCHEMA;
    process.stdout.write(JSON.stringify(schema, null, 2) + '\n');
  });

program.parse();
