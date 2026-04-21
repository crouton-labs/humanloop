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
    'blocks until the human finishes review and returns their answers as JSON.\n' +
    '\n' +
    'Workflow:\n' +
    '  1. Write a decisions file matching `hl schema` (a JSON list of questions).\n' +
    '  2. Run `hl create <file>`; it blocks and prints DecisionsOutput JSON to stdout.\n' +
    '  3. Parse the JSON; each answer\'s `type` mirrors the question\'s `type`.\n' +
    '\n' +
    'Question types: validation (approve/reject a statement), choice (pick an\n' +
    'option or enter custom), freetext (open-ended response).',
  )
  .version('0.1.0')
  .addHelpText(
    'after',
    '\nExamples:\n' +
    '  hl schema                          # print the input JSON schema\n' +
    '  hl create decisions.json           # open TUI, block, print answers JSON\n' +
    '  hl create decisions.json --output answers.json   # write result to file\n' +
    '  hl create decisions.json --no-tmux # run in current pane even inside tmux\n',
  );

program
  .command('create')
  .description(
    'Open the decisions TUI on <file> and block until the human finishes review.\n' +
    'Prints DecisionsOutput JSON to stdout (or to --output / --write-to).',
  )
  .argument('<file>', 'Path to decisions JSON file (see `hl schema` for format)')
  .option('--session-id <id>', 'Claude session ID; enables per-question visual context from conversation history. Defaults to the most recent session in cwd.')
  .option('--no-visuals', 'Skip visual context generation (faster, no haiku calls)')
  .option('--output <path>', 'Write result JSON to <path> instead of stdout')
  .option('--no-tmux', 'Do not auto-dispatch the TUI to a new tmux pane even when $TMUX is set')
  .addOption(new Option('--write-to <path>', 'internal: tmux child mode').hideHelp())
  .addHelpText(
    'after',
    '\n' +
    'INPUT FORMAT\n' +
    '  JSON file with a `questions` array. Each question has an `id`, a `type`\n' +
    '  ("validation" | "choice" | "freetext"), and `rationale`. Run `hl schema`\n' +
    '  for the full schema. Example:\n' +
    '    {\n' +
    '      "questions": [\n' +
    '        {"id": "q1", "type": "validation",\n' +
    '         "statement": "We should use Postgres over SQLite",\n' +
    '         "rationale": "Need concurrent writes from multiple services"},\n' +
    '        {"id": "q2", "type": "choice",\n' +
    '         "question": "Which migration tool?",\n' +
    '         "rationale": "Need repeatable schema changes",\n' +
    '         "options": ["Prisma", "Drizzle", "raw SQL"]},\n' +
    '        {"id": "q3", "type": "freetext",\n' +
    '         "question": "What should the retry policy be?",\n' +
    '         "rationale": "Affects reliability budget"}\n' +
    '      ]\n' +
    '    }\n' +
    '\n' +
    'OUTPUT FORMAT (stdout on success, JSON)\n' +
    '  {\n' +
    '    "answers": [ ... ],                      # same order as input questions\n' +
    '    "completedAt": "2026-04-20T15:23:00.000Z"\n' +
    '  }\n' +
    '\n' +
    '  Answer shape by `type`:\n' +
    '    validation: { id, type: "validation", approved: boolean, comment?: string }\n' +
    '    choice:     { id, type: "choice", selected: string, isCustom: boolean, comment?: string }\n' +
    '    freetext:   { id, type: "freetext", response: string }\n' +
    '\n' +
    '  The human can skip questions. `answers` may have FEWER entries than input\n' +
    '  questions — look up by `id`, do not assume index alignment.\n' +
    '\n' +
    'BEHAVIOR\n' +
    '  tmux       When $TMUX is set, the TUI auto-splits into a new pane to the\n' +
    '             right (-d keeps focus on the caller). Disable with --no-tmux.\n' +
    '  progress   Answers are persisted atomically to <file>.progress.json after\n' +
    '             every change. If the process is killed, the next run resumes\n' +
    '             from where the human left off. The file is removed on full\n' +
    '             completion; partial-answer files are preserved.\n' +
    '  visuals    With --session-id (or auto-detected) haiku generates a short\n' +
    '             ANSI context block per question from recent conversation turns.\n' +
    '\n' +
    'EXIT CODES\n' +
    '  0  success — result JSON emitted\n' +
    '  1  error — message on stderr (file missing, invalid JSON, empty\n' +
    '     questions, no TTY, etc.)\n' +
    '\n' +
    'EXAMPLES\n' +
    '  # Typical agent flow:\n' +
    '  cat > /tmp/d.json <<EOF\n' +
    '  {"questions":[{"id":"x","type":"validation",\n' +
    '   "statement":"...","rationale":"..."}]}\n' +
    '  EOF\n' +
    '  hl create /tmp/d.json > /tmp/answers.json\n' +
    '  jq \'.answers[] | select(.id=="x")\' /tmp/answers.json\n',
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
        process.stderr.write('\nFix: pass a path to an existing decisions JSON file.\nSee format: hl schema\n');
      } else if (msg.includes('No questions')) {
        process.stderr.write('\nFix: the file must contain a non-empty `questions` array.\nSee format: hl schema\n');
      } else if (msg.includes('TTY')) {
        process.stderr.write('\nFix: hl needs an interactive terminal. If the caller captures stdin,\nrun inside tmux so hl can auto-dispatch the TUI to a new pane, or pipe\nstdin from /dev/tty.\n');
      } else if (msg.includes('JSON')) {
        process.stderr.write('\nFix: the decisions file must be valid JSON matching `hl schema`.\n');
      }
      process.exit(1);
    }
  });

program
  .command('schema')
  .description('Print the decisions-input JSON schema to stdout')
  .addHelpText(
    'after',
    '\n' +
    'Use this to learn the exact input format for `hl create`.\n' +
    'The schema documents the three question types and their required fields.\n' +
    '\n' +
    'Example:\n' +
    '  hl schema > decisions.schema.json  # save for reference\n' +
    '  hl schema | jq                     # pretty-print\n',
  )
  .action(() => {
    const schema = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      description: 'Input schema for hl create',
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Optional title shown in the TUI header',
        },
        questions: {
          type: 'array',
          items: {
            oneOf: [
              {
                type: 'object',
                description: 'Validation — a statement for the user to approve or reject (with optional comment)',
                required: ['id', 'type', 'statement', 'rationale'],
                properties: {
                  id: { type: 'string' },
                  type: { const: 'validation' },
                  statement: { type: 'string', description: 'A statement to validate, not a question' },
                  rationale: { type: 'string', description: 'Why this decision was made' },
                },
              },
              {
                type: 'object',
                description: 'Choice — pick from options or provide a custom answer',
                required: ['id', 'type', 'question', 'rationale', 'options'],
                properties: {
                  id: { type: 'string' },
                  type: { const: 'choice' },
                  question: { type: 'string' },
                  rationale: { type: 'string' },
                  options: { type: 'array', items: { type: 'string' }, minItems: 2 },
                },
              },
              {
                type: 'object',
                description: 'Freetext — open-ended response',
                required: ['id', 'type', 'question', 'rationale'],
                properties: {
                  id: { type: 'string' },
                  type: { const: 'freetext' },
                  question: { type: 'string' },
                  rationale: { type: 'string' },
                },
              },
            ],
          },
        },
      },
      required: ['questions'],
    };

    process.stdout.write(JSON.stringify(schema, null, 2) + '\n');
  });

program.parse();
