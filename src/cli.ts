#!/usr/bin/env node

import { Command, Option } from 'commander';
import { writeFileSync } from 'fs';
import { launchTui } from './tui/app.js';
import { dispatchToTmuxPane } from './tui/tmux.js';
import { findRecentSessionId } from './conversation/reader.js';

const program = new Command();

program
  .name('hl')
  .description(
    'Human-in-the-loop decision TUI.\n' +
    '\n' +
    'Use this when you (the agent) need the human to validate decisions, choose\n' +
    'between options, or provide freetext input before you continue. The tool\n' +
    'blocks until the human finishes review and returns their responses as JSON.\n' +
    '\n' +
    'Workflow:\n' +
    '  1. Write a deck file matching `hl schema` (a JSON object with interactions[]).\n' +
    '  2. Run `hl create <file>`; it blocks and prints output JSON to stdout.\n' +
    '  3. Parse the JSON; each response has id, optional selectedOptionId, optional freetext.\n' +
    '\n' +
    'Interaction options: supply options[] for choices; set allowFreetext for comment/freetext.',
  )
  .version('0.1.0')
  .addHelpText(
    'after',
    '\nExamples:\n' +
    '  hl schema                          # print the input JSON schema\n' +
    '  hl create deck.json                # open TUI, block, print responses JSON\n' +
    '  hl create deck.json --output out.json   # write result to file\n' +
    '  hl create deck.json --no-tmux     # run in current pane even inside tmux\n',
  );

program
  .command('create')
  .description(
    'Open the decisions TUI on <file> and block until the human finishes review.\n' +
    'Prints output JSON to stdout (or to --output / --write-to).',
  )
  .argument('<file>', 'Path to deck JSON file (see `hl schema` for format)')
  .option('--session-id <id>', 'Claude session ID; enables per-interaction visual context from conversation history. Defaults to the most recent session in cwd.')
  .option('--no-visuals', 'Skip visual context generation (faster, no haiku calls)')
  .option('--output <path>', 'Write result JSON to <path> instead of stdout')
  .option('--no-tmux', 'Do not auto-dispatch the TUI to a new tmux pane even when $TMUX is set')
  .addOption(new Option('--write-to <path>', 'internal: tmux child mode').hideHelp())
  .addHelpText(
    'after',
    '\n' +
    'INPUT FORMAT\n' +
    '  JSON file with an `interactions` array. Each interaction has an `id`,\n' +
    '  `title`, `options[]`, and optional `allowFreetext`. Run `hl schema`\n' +
    '  for the full schema. Example:\n' +
    '    {\n' +
    '      "interactions": [\n' +
    '        {"id":"i1","title":"Use Postgres","options":[\n' +
    '          {"id":"approve","label":"Approve"},\n' +
    '          {"id":"reject","label":"Reject"}\n' +
    '        ],"allowFreetext":true},\n' +
    '        {"id":"i2","title":"Migration tool","options":[\n' +
    '          {"id":"prisma","label":"Prisma"},\n' +
    '          {"id":"drizzle","label":"Drizzle"}\n' +
    '        ]},\n' +
    '        {"id":"i3","title":"Rate limit policy","options":[],"allowFreetext":true}\n' +
    '      ]\n' +
    '    }\n' +
    '\n' +
    'OUTPUT FORMAT (stdout on success, JSON)\n' +
    '  {\n' +
    '    "responses": [ ... ],\n' +
    '    "completedAt": "2026-04-20T15:23:00.000Z"\n' +
    '  }\n' +
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
    '  progress   Responses are persisted atomically to <file>.progress.json after\n' +
    '             every change. If the process is killed, the next run resumes\n' +
    '             from where the human left off. The file is removed on full\n' +
    '             completion; partial-response files are preserved.\n' +
    '  visuals    With --session-id (or auto-detected) haiku generates a short\n' +
    '             ANSI context block per interaction from recent conversation turns.\n' +
    '\n' +
    'EXIT CODES\n' +
    '  0  success — result JSON emitted\n' +
    '  1  error — message on stderr (file missing, invalid JSON, empty\n' +
    '     interactions, no TTY, etc.)\n',
  )
  .action(async (file: string, opts: { sessionId?: string; visuals: boolean; output?: string; tmux: boolean; writeTo?: string }) => {
    const sessionId = opts.visuals
      ? (opts.sessionId || findRecentSessionId(process.cwd()) || findRecentSessionId() || undefined)
      : undefined;

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
          const result = await dispatchToTmuxPane(file, { sessionId, visuals: opts.visuals });
          emit(result);
          process.exit(0);
        } catch (err) {
          process.stderr.write(`tmux dispatch failed, running locally: ${err instanceof Error ? err.message : String(err)}\n`);
        }
      }

      const result = await launchTui(file, sessionId);
      emit(result);
      process.exit(0);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`ERROR: ${msg}\n`);
      if (msg.includes('not found')) {
        process.stderr.write('\nFix: pass a path to an existing deck JSON file.\nSee format: hl schema\n');
      } else if (msg.includes('No interactions')) {
        process.stderr.write('\nFix: the file must contain a non-empty `interactions` array.\nSee format: hl schema\n');
      } else if (msg.includes('TTY')) {
        process.stderr.write('\nFix: hl needs an interactive terminal. If the caller captures stdin,\nrun inside tmux so hl can auto-dispatch the TUI to a new pane, or pipe\nstdin from /dev/tty.\n');
      } else if (msg.includes('JSON')) {
        process.stderr.write('\nFix: the deck file must be valid JSON matching `hl schema`.\n');
      } else if (msg.startsWith('interactions[') || msg.includes('Duplicate interaction id') || msg.includes('must be')) {
        process.stderr.write('\nFix: the deck file must match `hl schema`. Run `hl schema` to see the required shape.\n');
      }
      process.exit(1);
    }
  });

program
  .command('schema')
  .description('Print the v2 Interaction[] deck schema to stdout')
  .addHelpText(
    'after',
    '\n' +
    'Use this to learn the exact input format for `hl create`.\n' +
    '\n' +
    'Example:\n' +
    '  hl schema > deck.schema.json   # save for reference\n' +
    '  hl schema | jq                 # pretty-print\n',
  )
  .action(() => {
    const schema = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      description: 'Input schema for hl create (v2)',
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
              id: { type: 'string', description: 'Unique identifier' },
              title: { type: 'string', description: 'Short display label (≤4 words). Required.' },
              subtitle: { type: 'string', description: 'One-line "why this matters"' },
              body: { type: 'string', description: 'Markdown body shown in item-review' },
              bodyPath: { type: 'string', description: 'Path to body file; sisyphus inlines before mount' },
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
                description: 'Display hint — opaque to humanloop, used by sisyphus for inbox icons',
              },
            },
          },
        },
      },
    };

    process.stdout.write(JSON.stringify(schema, null, 2) + '\n');
  });

program.parse();
