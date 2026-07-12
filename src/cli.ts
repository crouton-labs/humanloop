#!/usr/bin/env node

import { Command } from 'commander';
import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { validateDeck } from './inbox/deck-schema.js';
import { managedInboxRoot, registerInboxRoot, registeredInboxRoot, unregisterInboxRoot, listInboxRoots, type InboxRootRegistration } from './inbox/registry.js';
import { submitDeck, submitReview } from './inbox/tickets.js';
import { scanInbox } from './inbox/scan.js';
import { openInboxPopup } from './surfaces/inbox-popup.js';
import { toggleInboxPopup } from './tui/tmux.js';
import { ask } from './api.js';
import { launchReview } from './editor/review.js';
import { writeFeedbackResult } from './editor/feedback.js';
import { display } from './surfaces/display.js';
import { renderMarkdown, checkMarkdown } from './render/termrender.js';

function input(): unknown {
  const raw = readFileSync('/dev/stdin', 'utf8').trim();
  if (!raw) throw new Error('expected one JSON object on stdin');
  return JSON.parse(raw) as unknown;
}

function objectInput(): Record<string, unknown> {
  const value = input();
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('expected a JSON object on stdin');
  return value as Record<string, unknown>;
}

function emit(value: unknown): void { process.stdout.write(`${JSON.stringify(value)}\n`); }

function fail(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  const family = process.argv[2] ?? '';
  const help = new Set(['inbox', 'deck', 'review', 'view', 'doc']).has(family) ? `hl ${family} --help` : 'hl inbox --help';
  emit({ error: 'bad_input', message, next: `Run ${help} for usage.` });
  process.exit(1);
}

/** Explicit --root values filter the scan; no --root (an empty array from commander) falls through to the registered-roots fallback in scanInbox/the controller, so it must be undefined, not []. */
function roots(values: string[] | undefined): string[] | undefined { return values && values.length > 0 ? values.map((root) => resolve(root)) : undefined; }

/** Resolve an explicit --root to its existing registration; an unregistered root is an error, never a silent humanloop-owned registration. */
function requireRegisteredRoot(root: string): InboxRootRegistration {
  const abs = resolve(root);
  const registration = registeredInboxRoot(abs);
  if (registration === null) throw new Error(`root ${abs} is not registered; run \`hl inbox roots register --root ${abs} --owner <owner>\` first`);
  return registration;
}

const program = new Command();
program.name('hl').description('Humanloop durable inbox and review surface.').helpOption('-h, --help');

const inbox = program.command('inbox').description('Open, inspect, and configure the centralized human inbox.');
inbox.command('open').description('Open the inbox controller in this human TTY.').option('--root <path>', 'filter to a registered root', (value, prior: string[]) => [...prior, value], [] as string[]).option('--control-socket <path>', 'popup control socket').action(async (options: { root: string[]; controlSocket?: string }) => {
  if (!process.stdin.isTTY || !process.stdout.isTTY) fail('hl inbox open requires an interactive TTY; use hl inbox list for read-only output');
  try { await openInboxPopup(options.controlSocket, roots(options.root)); } catch (error) { fail(error); }
  // This process IS the popup: `tmux display-popup -E` keeps the popup on screen
  // until it exits. Once the controller has closed, exit hard — a stray live
  // handle (e.g. an in-flight completion-handler child that hangs) must never
  // keep a dismissed inbox occupying the terminal. Delivery is receipt-based
  // and crash-safe, so cutting an unfinished handler here is always safe.
  process.exit(0);
});
inbox.command('toggle').description('Toggle the inbox popup for one tmux client.').option('--tmux-socket <path>').option('--tmux-client <name>').option('--target-pane <pane>').option('--quiet', 'suppress result JSON on success (the tmux binding uses this so run-shell -b output never overlays the pane)').action(async (options: { tmuxSocket?: string; tmuxClient?: string; targetPane?: string; quiet?: boolean }) => {
  const result = await toggleInboxPopup({ socket: options.tmuxSocket, client: options.tmuxClient, targetPane: options.targetPane });
  // Under the `run-shell -b` binding, any stdout becomes a tmux view-mode overlay on the active
  // pane. The opened/closed popup is its own feedback, so stay silent on every non-failure result;
  // a genuine `failed` still prints so a broken binding is not invisible.
  if (!options.quiet || result === 'failed') emit({ result, next: result === 'not_in_tmux' ? 'Run hl inbox open in a human terminal.' : undefined });
  process.exit(result === 'failed' || result === 'ambiguous_client' ? 1 : 0);
});
inbox.command('list').description('Print pending tickets newest first as JSON.').option('--root <path>', 'filter to a root', (value, prior: string[]) => [...prior, value], [] as string[]).action((options: { root: string[] }) => emit(scanInbox(roots(options.root))));

const root = inbox.command('roots').description('Manage durable interaction roots.');
root.command('register').description('Register a root owned by a host.').requiredOption('--root <path>').requiredOption('--owner <owner>').option('--handler-command <path>').option('--handler-arg <arg>', 'repeatable direct-exec handler argument', (value, prior: string[]) => [...prior, value], [] as string[]).action((options: { root: string; owner: string; handlerCommand?: string; handlerArg: string[] }) => {
  if ((options.handlerCommand === undefined) !== (options.handlerArg.length === 0)) fail('a completion handler requires both --handler-command and at least one --handler-arg');
  emit(registerInboxRoot({ root: resolve(options.root), owner: options.owner, ...(options.handlerCommand === undefined ? {} : { handler: { command: options.handlerCommand, args: options.handlerArg } }) }));
});
root.command('unregister').description('Remove a matching root registration without deleting tickets.').requiredOption('--root <path>').requiredOption('--owner <owner>').action((options: { root: string; owner: string }) => emit({ removed: unregisterInboxRoot(resolve(options.root), options.owner) }));
root.command('list').description('List registered roots and availability.').action(() => emit(listInboxRoots()));

program.command('deck').command('ask').description('Submit a durable deck ticket; it never changes tmux. --inline blocks in this terminal instead.').option('--root <path>').option('--inline', 'present the deck in this terminal and block until it is answered').action(async (options: { root?: string; inline?: boolean }) => {
  try {
    const body = objectInput();
    const deck = validateDeck(body.deck);
    if (options.inline) {
      if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('hl deck ask --inline requires an interactive TTY; omit --inline to submit a durable ticket');
      emit(await ask(deck));
      return;
    }
    const registration = options.root === undefined ? managedInboxRoot() : requireRegisteredRoot(options.root);
    emit({ ...submitDeck({ root: registration.root, id: typeof body.id === 'string' ? body.id : randomUUID(), deck }), queued: true });
  } catch (error) { fail(error); }
});

program.command('review').command('open').description('Submit a durable anchored review; it never changes tmux. --inline blocks in this terminal instead.').option('--root <path>').option('--inline', 'run the review in this terminal and block until submitted').action(async (options: { root?: string; inline?: boolean }) => {
  try {
    const body = objectInput();
    if (typeof body.file !== 'string' || !existsSync(resolve(body.file))) throw new Error('file must be an existing markdown path');
    const absFile = resolve(body.file);
    const output = typeof body.output === 'string' ? resolve(body.output) : `${absFile}.feedback.json`;
    if (options.inline) {
      if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('hl review open --inline requires an interactive TTY; omit --inline to submit a durable ticket');
      emit(await launchReview(absFile, { output, onPropose: (result) => { writeFeedbackResult(output, result); } }));
      return;
    }
    if (typeof body.title !== 'string' || !body.title) throw new Error('title is required');
    const registration = options.root === undefined ? managedInboxRoot() : requireRegisteredRoot(options.root);
    emit({ ...submitReview({ root: registration.root, id: typeof body.id === 'string' ? body.id : randomUUID(), review: { file: absFile, output, title: body.title, source: typeof body.source === 'object' && body.source !== null ? body.source as never : {} } }), queued: true });
  } catch (error) { fail(error); }
});

const view = program.command('view').description('Passively display files; never a ticket surface.');
view.command('show').description('Live-render a file in a tmux pane. Passive, no result.').action(() => {
  try {
    const body = objectInput();
    if (typeof body.path !== 'string' || !body.path) throw new Error('path is required');
    const result = display(resolve(body.path), { window: body.window === 'new' ? 'new' : 'split' });
    emit({ pane_id: result.paneId ?? null, reason: result.paneId === undefined ? 'Not in tmux or termrender unavailable.' : null });
  } catch (error) { fail(error); }
});

function docSource(body: Record<string, unknown>): string {
  const hasSource = typeof body.source === 'string' && body.source.length > 0;
  const hasPath = typeof body.path === 'string' && body.path.length > 0;
  if (hasSource === hasPath) throw new Error('provide exactly one of {source, path}');
  if (hasSource) return body.source as string;
  const abs = resolve(body.path as string);
  if (!existsSync(abs)) throw new Error(`path not found: ${abs}`);
  return readFileSync(abs, 'utf8');
}

const doc = program.command('doc').description('Render or validate directive-flavored markdown to stdout via the managed termrender binary.');
doc.command('check').description('Validate directive-flavored markdown without rendering.').action(() => {
  try { emit(checkMarkdown(docSource(objectInput()))); } catch (error) { fail(error); }
});
doc.command('render').description('Render directive-flavored markdown to ANSI or plain text on stdout.').action(() => {
  try {
    const body = objectInput();
    const source = docSource(body);
    const width = typeof body.width === 'number' && body.width > 0 ? body.width : (process.stdout.columns || 100);
    let out = renderMarkdown(source, width).join('\n');
    if (body.color === false) out = out.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
    process.stdout.write(out.endsWith('\n') ? out : `${out}\n`);
  } catch (error) { fail(error); }
});

program.parseAsync().catch(fail);
