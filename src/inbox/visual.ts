import { existsSync, mkdirSync, readdirSync, realpathSync, statSync, unlinkSync } from 'node:fs';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import type { CanonicalInteraction, Interaction, VisualRequest as PanelVisualRequest } from '../types.js';
import { INTERACTION_KINDS } from '../types.js';
import { checkMarkdown } from '../render/termrender.js';
import {
  atomicWriteJson,
  deckPath,
  publishJsonExclusive,
  readJson,
  runHandler,
  visualsDir,
  withExclusiveDirectoryLock,
  withExclusiveDirectoryLockAsync,
} from './convention.js';
import { parseDeck } from './deck-schema.js';
import { readTicketClaim, withTicketLock } from './claim.js';
import { registeredInboxRoot, type CompletionHandler } from './registry.js';
import { requireCanonicalTicket } from './tickets.js';

export const VISUAL_CAPABILITY = 'humanloop.visual/v1' as const;

export interface VisualClaimIdentity {
  token: string;
  host: string;
  pid: number;
  claimedAt: string;
}

export interface VisualCleanupObligation {
  reason: 'canceled' | 'unreceipted_start_error';
  attempts: number;
  nextAttemptAt: string;
  lastAttemptAt?: string;
  lastError?: string;
}

interface VisualBinding {
  capability: typeof VISUAL_CAPABILITY;
  owner: string;
  root: string;
  dir: string;
  ticketId: string;
  requestId: string;
  generationId: string;
  interactionId: string;
  interaction: CanonicalInteraction;
  claim: VisualClaimIdentity;
  handler: CompletionHandler;
}

export interface VisualProtocolRequest extends VisualBinding {
  schema: 'humanloop.visual-request/v1';
  state: 'running' | 'canceled' | 'terminal';
  requestedAt: string;
  settledAt?: string;
  cleanup?: VisualCleanupObligation;
}

export interface VisualRequestEvent extends VisualBinding {
  schema: 'humanloop.visual-request-event/v1';
  action: 'start' | 'cancel';
}

interface VisualResultBinding extends VisualBinding {
  schema: 'humanloop.visual-result/v1';
  completedAt: string;
}

export type VisualProtocolResult =
  | (VisualResultBinding & { status: 'ready'; markdown: string })
  | (VisualResultBinding & { status: 'error'; error: string });

export type VisualResultSubmission =
  | { requestId: string; generationId: string; interactionId: string; interaction: CanonicalInteraction; claimToken: string; status: 'ready'; markdown: string }
  | { requestId: string; generationId: string; interactionId: string; interaction: CanonicalInteraction; claimToken: string; status: 'error'; error: string };

export interface StartVisualRequestOptions {
  root: string;
  dir: string;
  claimToken: string;
  request: PanelVisualRequest;
}

export type VisualStartDeliveryResult = 'delivered' | 'already_attempted' | 'ineligible' | 'failed';
export type VisualCleanupDeliveryResult = 'delivered' | 'pending' | 'none';

export interface StartedVisualRequest {
  request: VisualProtocolRequest;
  /** Resolves after the one permitted start attempt reaches a determinate outcome. */
  delivery: Promise<VisualStartDeliveryResult>;
}

export interface VisualCleanupTask {
  root: string;
  dir: string;
  requestId: string;
  reason: VisualCleanupObligation['reason'];
  nextAttemptAt: string;
}

const id = z.string().regex(/^[A-Za-z0-9_-]+$/).min(1).max(128);
const uuid = z.string().uuid();
const iso = z.string().datetime({ offset: true });
const canonicalPath = z.string().min(1).refine(isAbsolute, 'path must be absolute').refine((path) => resolve(path) === path, 'path must be canonical');
const handlerSchema = z.object({ command: z.string().refine((value) => value.trim().length > 0, 'handler command must be non-empty'), args: z.array(z.string()) }).strict();
const claimSchema = z.object({ token: uuid, host: z.string().min(1), pid: z.number().int().positive(), claimedAt: iso }).strict();
const optionInputSchema = z.object({ id: z.string().min(1), label: z.string().min(1), description: z.string().optional(), shortcut: z.string().optional() }).strict();
const optionSchema = z.object({ id: z.string().min(1), label: z.string().min(1), description: z.string().optional() }).strict();
const preAnsweredSchema = z.object({ selectedOptionId: z.string().optional(), selectedOptionIds: z.array(z.string()).optional(), freetext: z.string().optional(), label: z.string().optional() }).strict();
const interactionInputSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]+$/).min(1).max(64),
  title: z.string().min(1),
  subtitle: z.string().min(1).optional(),
  body: z.string().optional(),
  bodyPath: z.string().optional(),
  options: z.array(optionInputSchema),
  multiSelect: z.boolean().optional(),
  allowFreetext: z.boolean().optional(),
  freetextLabel: z.string().optional(),
  kind: z.enum(INTERACTION_KINDS).optional(),
  preAnswered: preAnsweredSchema.optional(),
}).strict();
const canonicalInteractionSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]+$/).min(1).max(64),
  title: z.string().min(1),
  subtitle: z.string().min(1).optional(),
  body: z.string().optional(),
  options: z.array(optionSchema),
  multiSelect: z.boolean().optional(),
  allowFreetext: z.boolean().optional(),
  freetextLabel: z.string().optional(),
  kind: z.enum(INTERACTION_KINDS).optional(),
  preAnswered: preAnsweredSchema.optional(),
}).strict();
const cleanupSchema = z.object({
  reason: z.enum(['canceled', 'unreceipted_start_error']),
  attempts: z.number().int().nonnegative(),
  nextAttemptAt: iso,
  lastAttemptAt: iso.optional(),
  lastError: z.string().min(1).max(8_192).optional(),
}).strict();
const bindingShape = {
  capability: z.literal(VISUAL_CAPABILITY),
  owner: z.string().min(1),
  root: canonicalPath,
  dir: canonicalPath,
  ticketId: id,
  requestId: uuid,
  generationId: uuid,
  interactionId: z.string().regex(/^[A-Za-z0-9_-]+$/).min(1).max(64),
  interaction: canonicalInteractionSchema,
  claim: claimSchema,
  handler: handlerSchema,
};
const requestSchema = z.object({
  schema: z.literal('humanloop.visual-request/v1'),
  ...bindingShape,
  state: z.enum(['running', 'canceled', 'terminal']),
  requestedAt: iso,
  settledAt: iso.optional(),
  cleanup: cleanupSchema.optional(),
}).strict().superRefine((request, ctx) => {
  if (request.interactionId !== request.interaction.id) ctx.addIssue({ code: 'custom', message: 'interactionId must match interaction.id' });
  if (request.state === 'running' && (request.settledAt !== undefined || request.cleanup !== undefined)) ctx.addIssue({ code: 'custom', message: 'running requests cannot be settled or cleanup-owed' });
  if (request.state !== 'running' && request.settledAt === undefined) ctx.addIssue({ code: 'custom', message: 'settled requests require settledAt' });
  if (request.state === 'canceled' && request.cleanup?.reason !== 'canceled') ctx.addIssue({ code: 'custom', message: 'canceled requests require canceled cleanup' });
  if (request.state === 'terminal' && request.cleanup !== undefined && request.cleanup.reason !== 'unreceipted_start_error') ctx.addIssue({ code: 'custom', message: 'terminal cleanup must be for an unreceipted start error' });
});
const eventSchema = z.object({ schema: z.literal('humanloop.visual-request-event/v1'), action: z.enum(['start', 'cancel']), ...bindingShape }).strict().superRefine((event, ctx) => {
  if (event.interactionId !== event.interaction.id) ctx.addIssue({ code: 'custom', message: 'interactionId must match interaction.id' });
});
const readyResultSchema = z.object({ schema: z.literal('humanloop.visual-result/v1'), ...bindingShape, status: z.literal('ready'), markdown: z.string().refine((value) => value.trim().length > 0, 'ready result requires non-empty markdown'), completedAt: iso }).strict().superRefine((result, ctx) => {
  if (result.interactionId !== result.interaction.id) ctx.addIssue({ code: 'custom', message: 'interactionId must match interaction.id' });
});
const errorResultSchema = z.object({ schema: z.literal('humanloop.visual-result/v1'), ...bindingShape, status: z.literal('error'), error: z.string().min(1).max(8_192), completedAt: iso }).strict().superRefine((result, ctx) => {
  if (result.interactionId !== result.interaction.id) ctx.addIssue({ code: 'custom', message: 'interactionId must match interaction.id' });
});
const resultSchema = z.union([readyResultSchema, errorResultSchema]);
const readySubmissionSchema = z.object({ requestId: uuid, generationId: uuid, interactionId: z.string().min(1).max(64), interaction: canonicalInteractionSchema, claimToken: uuid, status: z.literal('ready'), markdown: z.string() }).strict();
const errorSubmissionSchema = z.object({ requestId: uuid, generationId: uuid, interactionId: z.string().min(1).max(64), interaction: canonicalInteractionSchema, claimToken: uuid, status: z.literal('error'), error: z.string().min(1).max(8_192) }).strict();
const submissionSchema = z.union([readySubmissionSchema, errorSubmissionSchema]);
const deliveryAttemptSchema = z.object({ schema: z.literal('humanloop.visual-delivery-attempt/v1'), action: z.literal('start'), event: eventSchema, attemptedAt: iso }).strict().superRefine((attempt, ctx) => {
  if (attempt.event.action !== attempt.action) ctx.addIssue({ code: 'custom', message: 'attempt action must match event action' });
});
const deliveryReceiptSchema = z.object({ schema: z.literal('humanloop.visual-delivery-receipt/v1'), action: z.enum(['start', 'cancel']), event: eventSchema, deliveredAt: iso }).strict().superRefine((receipt, ctx) => {
  if (receipt.event.action !== receipt.action) ctx.addIssue({ code: 'custom', message: 'receipt action must match event action' });
});
const startDeliveryErrorSchema = z.object({
  schema: z.literal('humanloop.visual-delivery-error/v1'),
  action: z.literal('start'),
  event: eventSchema,
  failedAt: iso,
  error: z.string().min(1).max(8_192),
  terminalAt: iso.optional(),
}).strict().superRefine((failure, ctx) => {
  if (failure.event.action !== failure.action) ctx.addIssue({ code: 'custom', message: 'delivery-error action must match event action' });
});
type StartDeliveryErrorRecord = z.infer<typeof startDeliveryErrorSchema>;

/** Normalize one Interaction into the sole persisted/event correlation shape. */
export function canonicalizeInteraction(raw: Interaction | CanonicalInteraction): CanonicalInteraction {
  const parsed = interactionInputSchema.parse(raw);
  if (parsed.bodyPath !== undefined) throw new Error('Visual interaction must contain resolved body, not bodyPath');
  const canonical: CanonicalInteraction = {
    id: parsed.id,
    title: parsed.title,
    ...(parsed.subtitle === undefined ? {} : { subtitle: parsed.subtitle }),
    ...(parsed.body === undefined ? {} : { body: parsed.body }),
    options: parsed.options.map((option) => ({ id: option.id, label: option.label, ...(option.description === undefined ? {} : { description: option.description }) })),
    ...(parsed.multiSelect === undefined ? {} : { multiSelect: parsed.multiSelect }),
    ...(parsed.allowFreetext === undefined ? {} : { allowFreetext: parsed.allowFreetext }),
    ...(parsed.freetextLabel === undefined ? {} : { freetextLabel: parsed.freetextLabel }),
    ...(parsed.kind === undefined ? {} : { kind: parsed.kind }),
    ...(parsed.preAnswered === undefined ? {} : { preAnswered: {
      ...(parsed.preAnswered.selectedOptionId === undefined ? {} : { selectedOptionId: parsed.preAnswered.selectedOptionId }),
      ...(parsed.preAnswered.selectedOptionIds === undefined ? {} : { selectedOptionIds: [...parsed.preAnswered.selectedOptionIds] }),
      ...(parsed.preAnswered.freetext === undefined ? {} : { freetext: parsed.preAnswered.freetext }),
      ...(parsed.preAnswered.label === undefined ? {} : { label: parsed.preAnswered.label }),
    } }),
  };
  return canonicalInteractionSchema.parse(canonical) as CanonicalInteraction;
}

/** Stable bytes used for every interaction equality check across the protocol. */
export function canonicalInteractionJson(raw: Interaction | CanonicalInteraction): string {
  return JSON.stringify(canonicalizeInteraction(raw));
}

export function parseVisualRequestEvent(raw: unknown): VisualRequestEvent {
  return eventSchema.parse(raw) as VisualRequestEvent;
}

function requestPath(requestDir: string): string { return `${requestDir}/request.json`; }
function resultPath(requestDir: string): string { return `${requestDir}/result.json`; }
function requestLockPath(requestDir: string): string { return `${requestDir}/.request-lock`; }
function startLockPath(requestDir: string): string { return `${requestDir}/.start-lock`; }
function cancelLockPath(requestDir: string): string { return `${requestDir}/.cancel-lock`; }
function startAttemptPath(requestDir: string): string { return `${requestDir}/start-attempt.json`; }
function startReceiptPath(requestDir: string): string { return `${requestDir}/start-receipt.json`; }
function startErrorPath(requestDir: string): string { return `${requestDir}/start-delivery-error.json`; }
function cancelReceiptPath(requestDir: string): string { return `${requestDir}/cancel-receipt.json`; }
function cancelErrorPath(requestDir: string): string { return `${requestDir}/cancel-delivery-error.json`; }

function canonicalVisualsDirectory(ticketDir: string, create: boolean): string | null {
  const path = visualsDir(ticketDir);
  if (create) mkdirSync(path, { recursive: true, mode: 0o700 });
  if (!existsSync(path)) return null;
  const canonical = realpathSync(path);
  if (canonical !== path || dirname(canonical) !== ticketDir || basename(canonical) !== 'visuals' || !statSync(canonical).isDirectory()) throw new Error('visuals must be a canonical directory directly under the ticket');
  return canonical;
}

function canonicalRequestDirectory(ticketDir: string, requestId: string, create: boolean): string | null {
  uuid.parse(requestId);
  const parent = canonicalVisualsDirectory(ticketDir, create);
  if (parent === null) return null;
  const path = resolve(parent, requestId);
  if (dirname(path) !== parent) throw new Error('Visual request must be a direct child of the ticket visuals directory');
  if (create) mkdirSync(path, { recursive: true, mode: 0o700 });
  if (!existsSync(path)) return null;
  const canonical = realpathSync(path);
  if (canonical !== path || dirname(canonical) !== parent || basename(canonical) !== requestId || !statSync(canonical).isDirectory()) throw new Error('Visual request must be a canonical direct child of the ticket visuals directory');
  return canonical;
}

function parseRequest(path: string): VisualProtocolRequest | null {
  const parsed = requestSchema.safeParse(readJson<unknown>(path));
  return parsed.success ? parsed.data as VisualProtocolRequest : null;
}

function parseResult(path: string): VisualProtocolResult | null {
  const parsed = resultSchema.safeParse(readJson<unknown>(path));
  if (!parsed.success) return null;
  if (parsed.data.status === 'ready' && !checkMarkdown(parsed.data.markdown).ok) return null;
  return parsed.data as VisualProtocolResult;
}

function bindingFingerprint(binding: VisualBinding): string {
  return JSON.stringify({
    capability: binding.capability,
    owner: binding.owner,
    root: binding.root,
    dir: binding.dir,
    ticketId: binding.ticketId,
    requestId: binding.requestId,
    generationId: binding.generationId,
    interactionId: binding.interactionId,
    interaction: canonicalizeInteraction(binding.interaction),
    claim: binding.claim,
    handler: binding.handler,
  });
}

function bindingMatches(left: VisualBinding, right: VisualBinding): boolean {
  return bindingFingerprint(left) === bindingFingerprint(right);
}

function requestBelongsTo(request: VisualProtocolRequest, root: string, dir: string, requestId: string): boolean {
  return request.root === root && request.dir === dir && request.ticketId === basename(dir) && request.requestId === requestId;
}

function resultFor(request: VisualProtocolRequest, outcome: { status: 'ready'; markdown: string } | { status: 'error'; error: string }, completedAt: string): VisualProtocolResult {
  const binding: VisualBinding = {
    capability: request.capability,
    owner: request.owner,
    root: request.root,
    dir: request.dir,
    ticketId: request.ticketId,
    requestId: request.requestId,
    generationId: request.generationId,
    interactionId: request.interactionId,
    interaction: request.interaction,
    claim: request.claim,
    handler: request.handler,
  };
  return outcome.status === 'ready'
    ? { schema: 'humanloop.visual-result/v1', ...binding, status: 'ready', markdown: outcome.markdown, completedAt }
    : { schema: 'humanloop.visual-result/v1', ...binding, status: 'error', error: outcome.error, completedAt };
}

function eventFor(request: VisualProtocolRequest, action: VisualRequestEvent['action']): VisualRequestEvent {
  return {
    schema: 'humanloop.visual-request-event/v1',
    action,
    capability: request.capability,
    owner: request.owner,
    root: request.root,
    dir: request.dir,
    ticketId: request.ticketId,
    requestId: request.requestId,
    generationId: request.generationId,
    interactionId: request.interactionId,
    interaction: request.interaction,
    claim: request.claim,
    handler: request.handler,
  };
}

function readReceipt(path: string, request: VisualProtocolRequest, action: 'start' | 'cancel'): boolean {
  const parsed = deliveryReceiptSchema.safeParse(readJson<unknown>(path));
  return parsed.success && parsed.data.action === action && bindingMatches(parsed.data.event as VisualRequestEvent, request);
}

function publishReceipt(path: string, receipt: z.infer<typeof deliveryReceiptSchema>, request: VisualProtocolRequest): void {
  if (publishJsonExclusive(path, receipt) || readReceipt(path, request, receipt.action)) return;
  throw new Error(`Visual ${receipt.action} receipt path contains a conflicting record`);
}

function cleanupOwed(requestDir: string, request: VisualProtocolRequest): boolean {
  return request.cleanup !== undefined && !readReceipt(cancelReceiptPath(requestDir), request, 'cancel');
}

function parseStartDeliveryError(requestDir: string, request: VisualProtocolRequest): StartDeliveryErrorRecord | null {
  const parsed = startDeliveryErrorSchema.safeParse(readJson<unknown>(startErrorPath(requestDir)));
  if (!parsed.success || !bindingMatches(parsed.data.event as VisualRequestEvent, request)) return null;
  return parsed.data;
}

function startFailureMessage(error: string): string {
  return `Visual start delivery failed: ${error}`.slice(0, 8_192);
}

function isCommittedStartFailure(result: VisualProtocolResult, failure: StartDeliveryErrorRecord | null): boolean {
  return failure?.terminalAt !== undefined
    && result.status === 'error'
    && result.completedAt === failure.terminalAt
    && result.error === startFailureMessage(failure.error);
}

/** Repair a committed result whose mutable request mirror was interrupted. Caller holds the request lock. */
function readLocked(requestDir: string, root: string, dir: string, requestId: string): { request: VisualProtocolRequest; result: VisualProtocolResult | null } | null {
  let request = parseRequest(requestPath(requestDir));
  if (request === null || !requestBelongsTo(request, root, dir, requestId)) return null;
  let result = parseResult(resultPath(requestDir));
  if (result !== null && !bindingMatches(result, request)) result = null;

  // A determinate handler failure is committed before its result publication.
  // Complete either interrupted mirror write without reopening result currency.
  const startFailure = parseStartDeliveryError(requestDir, request);
  if (startFailure?.terminalAt !== undefined && request.state === 'running' && result === null) {
    const repair = resultFor(request, { status: 'error', error: startFailureMessage(startFailure.error) }, startFailure.terminalAt);
    if (publishJsonExclusive(resultPath(requestDir), repair)) result = repair;
    else {
      const raced = parseResult(resultPath(requestDir));
      if (raced !== null && bindingMatches(raced, request)) result = raced;
    }
  }
  if (result !== null
    && isCommittedStartFailure(result, startFailure)
    && request.state !== 'canceled'
    && (request.state === 'running' || request.cleanup?.reason !== 'unreceipted_start_error')) {
    request = { ...request, state: 'terminal', settledAt: result.completedAt, cleanup: cleanup('unreceipted_start_error', result.completedAt) };
    atomicWriteJson(requestPath(requestDir), request);
  } else if (result !== null && request.state === 'running') {
    request = { ...request, state: 'terminal', settledAt: result.completedAt };
    atomicWriteJson(requestPath(requestDir), request);
  } else if (result !== null && request.state === 'canceled') {
    result = null;
  }
  return { request, result };
}

function locate(root: string, dir: string, requestId: string): { root: string; dir: string; requestDir: string | null } {
  const ticket = requireCanonicalTicket(root, dir);
  return { ...ticket, requestDir: canonicalRequestDirectory(ticket.dir, requestId, false) };
}

/** Strict, repairing reader; malformed or unbound request bytes return null. */
export function readVisualRequest(root: string, dir: string, requestId: string): VisualProtocolRequest | null {
  const located = locate(root, dir, requestId);
  if (located.requestDir === null) return null;
  return withExclusiveDirectoryLock(requestLockPath(located.requestDir), () => readLocked(located.requestDir!, located.root, located.dir, requestId)?.request ?? null);
}

/** Strict, repairing reader; canceled and mismatched results are never returned. */
export function readVisualResult(root: string, dir: string, requestId: string): VisualProtocolResult | null {
  const located = locate(root, dir, requestId);
  if (located.requestDir === null) return null;
  return withExclusiveDirectoryLock(requestLockPath(located.requestDir), () => readLocked(located.requestDir!, located.root, located.dir, requestId)?.result ?? null);
}

/** Decode an event and atomically bind it to Humanloop's immutable request state. */
export function readVisualRequestForEvent(raw: unknown): VisualProtocolRequest | null {
  const event = parseVisualRequestEvent(raw);
  const located = locate(event.root, event.dir, event.requestId);
  if (located.requestDir === null) return null;
  return withExclusiveDirectoryLock(requestLockPath(located.requestDir), () => {
    const current = readLocked(located.requestDir!, located.root, located.dir, event.requestId);
    if (current === null || !bindingMatches(event, current.request)) return null;
    if (event.action === 'start') {
      return current.request.state === 'running'
        && current.result === null
        && !readReceipt(startReceiptPath(located.requestDir!), current.request, 'start')
        ? current.request
        : null;
    }
    return cleanupOwed(located.requestDir!, current.request)
      && (current.request.state === 'canceled' || (current.request.state === 'terminal' && current.request.cleanup?.reason === 'unreceipted_start_error'))
      ? current.request
      : null;
  });
}

function claimIdentity(claim: NonNullable<ReturnType<typeof readTicketClaim>>): VisualClaimIdentity {
  return { token: claim.token, host: claim.host, pid: claim.pid, claimedAt: claim.claimedAt };
}

function sameBirthRequest(existing: VisualProtocolRequest, opts: StartVisualRequestOptions, interaction: CanonicalInteraction): boolean {
  return existing.requestId === opts.request.requestId
    && existing.generationId === opts.request.generationId
    && existing.interactionId === interaction.id
    && existing.claim.token === opts.claimToken
    && canonicalInteractionJson(existing.interaction) === canonicalInteractionJson(interaction);
}

function createOrReadRequest(opts: StartVisualRequestOptions): { request: VisualProtocolRequest; created: boolean } {
  const ticket = requireCanonicalTicket(opts.root, opts.dir);
  const requestedInteraction = canonicalizeInteraction(opts.request.interaction);
  return withTicketLock(ticket.dir, () => {
    const existingDir = canonicalRequestDirectory(ticket.dir, opts.request.requestId, false);
    if (existingDir !== null) {
      const existing = withExclusiveDirectoryLock(requestLockPath(existingDir), () => readLocked(existingDir, ticket.root, ticket.dir, opts.request.requestId)?.request ?? null);
      if (existing !== null) {
        if (!sameBirthRequest(existing, opts, requestedInteraction)) throw new Error('Visual request identity is already bound to different immutable coordinates');
        return { request: existing, created: false };
      }
      if (existsSync(requestPath(existingDir))) throw new Error('Visual request record is malformed');
    }

    const registration = registeredInboxRoot(ticket.root);
    if (registration?.visualHandler === undefined) throw new Error('root has no registered Visual handler');
    const handler = registration.visualHandler;
    const claim = readTicketClaim(ticket.dir);
    if (claim === null || claim.token !== opts.claimToken) throw new Error('only the current ticket claim may create a Visual request');
    const deck = parseDeck(deckPath(ticket.dir));
    if (deck.source?.visual !== VISUAL_CAPABILITY) throw new Error('ticket does not carry the Visual capability marker');
    const deckInteraction = deck.interactions.find((candidate) => candidate.id === requestedInteraction.id);
    if (deckInteraction === undefined || canonicalInteractionJson(deckInteraction) !== canonicalInteractionJson(requestedInteraction)) throw new Error('Visual interaction does not match the canonical ticket interaction');

    const requestDir = existingDir ?? canonicalRequestDirectory(ticket.dir, opts.request.requestId, true)!;
    return withExclusiveDirectoryLock(requestLockPath(requestDir), () => {
      const raced = readLocked(requestDir, ticket.root, ticket.dir, opts.request.requestId)?.request ?? null;
      if (raced !== null) {
        if (!sameBirthRequest(raced, opts, requestedInteraction)) throw new Error('Visual request identity is already bound to different immutable coordinates');
        return { request: raced, created: false };
      }
      const request: VisualProtocolRequest = {
        schema: 'humanloop.visual-request/v1',
        capability: VISUAL_CAPABILITY,
        owner: registration.owner,
        root: ticket.root,
        dir: ticket.dir,
        ticketId: basename(ticket.dir),
        requestId: opts.request.requestId,
        generationId: opts.request.generationId,
        interactionId: requestedInteraction.id,
        interaction: requestedInteraction,
        claim: claimIdentity(claim),
        handler: { command: handler.command, args: [...handler.args] },
        state: 'running',
        requestedAt: new Date().toISOString(),
      };
      requestSchema.parse(request);
      if (!publishJsonExclusive(requestPath(requestDir), request)) throw new Error('Visual request publication lost an unexpected race');
      return { request, created: true };
    });
  });
}

/** Persist one claim-bound request and dispatch its frozen handler at most once. */
export function startVisualRequest(opts: StartVisualRequestOptions): StartedVisualRequest {
  uuid.parse(opts.request.requestId);
  uuid.parse(opts.request.generationId);
  uuid.parse(opts.claimToken);
  const birth = createOrReadRequest(opts);
  return {
    request: birth.request,
    delivery: birth.created
      ? deliverVisualStart(birth.request.root, birth.request.dir, birth.request.requestId)
      : Promise.resolve('already_attempted'),
  };
}

function boundedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim().slice(0, 8_192) || 'unknown handler error';
}

function removeIfPresent(path: string): void {
  try { unlinkSync(path); } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}

function cleanup(reason: VisualCleanupObligation['reason'], now: string): VisualCleanupObligation {
  return { reason, attempts: 0, nextAttemptAt: now };
}

function publishStartFailure(root: string, dir: string, requestDir: string, requestId: string, event: VisualRequestEvent, failedAt: string, error: string): boolean {
  return withExclusiveDirectoryLock(requestLockPath(requestDir), () => {
    const current = readLocked(requestDir, root, dir, requestId);
    const eligible = current !== null
      && current.request.state === 'running'
      && current.result === null
      && bindingMatches(event, current.request);
    const terminalAt = eligible ? new Date().toISOString() : undefined;
    const failure: StartDeliveryErrorRecord = {
      schema: 'humanloop.visual-delivery-error/v1',
      action: 'start',
      event,
      failedAt,
      error,
      ...(terminalAt === undefined ? {} : { terminalAt }),
    };
    startDeliveryErrorSchema.parse(failure);
    atomicWriteJson(startErrorPath(requestDir), failure);
    if (!eligible || current === null || terminalAt === undefined) return false;

    const result = resultFor(current.request, { status: 'error', error: startFailureMessage(error) }, terminalAt);
    resultSchema.parse(result);
    if (!publishJsonExclusive(resultPath(requestDir), result)) return false;
    atomicWriteJson(requestPath(requestDir), { ...current.request, state: 'terminal', settledAt: terminalAt, cleanup: cleanup('unreceipted_start_error', terminalAt) } satisfies VisualProtocolRequest);
    return true;
  });
}

/** Execute the sole birth-owned start attempt. The immutable attempt marker records its dispatch edge. */
async function deliverVisualStart(root: string, dir: string, requestId: string): Promise<VisualStartDeliveryResult> {
  const located = locate(root, dir, requestId);
  if (located.requestDir === null) return 'ineligible';
  return withExclusiveDirectoryLockAsync(startLockPath(located.requestDir), async () => {
    const request = withExclusiveDirectoryLock(requestLockPath(located.requestDir!), () => {
      const current = readLocked(located.requestDir!, located.root, located.dir, requestId);
      if (current === null || current.request.state !== 'running' || current.result !== null) return null;
      if (existsSync(startAttemptPath(located.requestDir!)) || readReceipt(startReceiptPath(located.requestDir!), current.request, 'start')) return 'attempted' as const;
      const event = eventFor(current.request, 'start');
      const attemptedAt = new Date().toISOString();
      const attempt = { schema: 'humanloop.visual-delivery-attempt/v1', action: 'start', event, attemptedAt } as const;
      deliveryAttemptSchema.parse(attempt);
      if (!publishJsonExclusive(startAttemptPath(located.requestDir!), attempt)) return 'attempted' as const;
      return current.request;
    });
    if (request === null) return 'ineligible';
    if (request === 'attempted') return 'already_attempted';

    const event = eventFor(request, 'start');
    try {
      await runHandler(request.handler.command, request.handler.args, event);
      const receipt = { schema: 'humanloop.visual-delivery-receipt/v1', action: 'start', event, deliveredAt: new Date().toISOString() } as const;
      deliveryReceiptSchema.parse(receipt);
      publishReceipt(startReceiptPath(located.requestDir!), receipt, request);
      removeIfPresent(startErrorPath(located.requestDir!));
      return 'delivered';
    } catch (error) {
      const message = boundedError(error);
      const failedAt = new Date().toISOString();
      if (publishStartFailure(located.root, located.dir, located.requestDir!, requestId, event, failedAt, message)) await dispatchVisualCleanup(located.root, located.dir, requestId);
      return 'failed';
    }
  });
}

function submissionMatches(request: VisualProtocolRequest, submission: VisualResultSubmission): boolean {
  return request.requestId === submission.requestId
    && request.generationId === submission.generationId
    && request.interactionId === submission.interactionId
    && request.claim.token === submission.claimToken
    && canonicalInteractionJson(request.interaction) === canonicalInteractionJson(submission.interaction);
}

/** Compare-publish the first fully correlated ready/error result. Stale writers are no-ops. */
export function submitVisualResult(root: string, dir: string, raw: VisualResultSubmission): { published: boolean } {
  const submission = submissionSchema.parse(raw) as VisualResultSubmission;
  const located = locate(root, dir, submission.requestId);
  if (located.requestDir === null) return { published: false };
  return withExclusiveDirectoryLock(requestLockPath(located.requestDir), () => {
    const current = readLocked(located.requestDir!, located.root, located.dir, submission.requestId);
    if (current === null || current.request.state !== 'running' || current.result !== null || !submissionMatches(current.request, submission)) return { published: false };
    const completedAt = new Date().toISOString();
    let outcome: { status: 'ready'; markdown: string } | { status: 'error'; error: string };
    if (submission.status === 'ready') {
      const check = submission.markdown.trim().length === 0 ? { ok: false as const, error: 'ready result requires non-empty markdown' } : checkMarkdown(submission.markdown);
      outcome = check.ok ? { status: 'ready', markdown: submission.markdown } : { status: 'error', error: boundedError(check.error) };
    } else {
      outcome = { status: 'error', error: submission.error };
    }
    const result = resultFor(current.request, outcome, completedAt);
    resultSchema.parse(result);
    if (!publishJsonExclusive(resultPath(located.requestDir!), result)) return { published: false };
    atomicWriteJson(requestPath(located.requestDir!), { ...current.request, state: 'terminal', settledAt: completedAt } satisfies VisualProtocolRequest);
    return { published: true };
  });
}

function stateFirstCancel(root: string, dir: string, requestId: string): { requestDir: string; owed: boolean; changed: boolean } | null {
  const located = locate(root, dir, requestId);
  if (located.requestDir === null) return null;
  return withExclusiveDirectoryLock(requestLockPath(located.requestDir), () => {
    const current = readLocked(located.requestDir!, located.root, located.dir, requestId);
    if (current === null) return null;
    let request = current.request;
    let changed = false;
    if (request.state === 'running' && current.result === null) {
      const settledAt = new Date().toISOString();
      request = { ...request, state: 'canceled', settledAt, cleanup: cleanup('canceled', settledAt) };
      atomicWriteJson(requestPath(located.requestDir!), request);
      changed = true;
    }
    return { requestDir: located.requestDir!, owed: cleanupOwed(located.requestDir!, request), changed };
  });
}

function retryDelayMs(attempts: number): number {
  return Math.min(60_000, 1_000 * (2 ** Math.min(Math.max(0, attempts - 1), 6)));
}

/** Attempt one due cleanup delivery through the request's frozen handler. */
export async function dispatchVisualCleanup(root: string, dir: string, requestId: string): Promise<VisualCleanupDeliveryResult> {
  const located = locate(root, dir, requestId);
  if (located.requestDir === null) return 'none';
  return withExclusiveDirectoryLockAsync(cancelLockPath(located.requestDir), async () => {
    const due = withExclusiveDirectoryLock(requestLockPath(located.requestDir!), () => {
      const current = readLocked(located.requestDir!, located.root, located.dir, requestId);
      if (current === null || !cleanupOwed(located.requestDir!, current.request)) return null;
      const obligation = current.request.cleanup!;
      if (Date.parse(obligation.nextAttemptAt) > Date.now()) return 'not_due' as const;
      const attemptedAt = new Date().toISOString();
      const attempts = obligation.attempts + 1;
      const updated: VisualProtocolRequest = {
        ...current.request,
        cleanup: { ...obligation, attempts, lastAttemptAt: attemptedAt, nextAttemptAt: new Date(Date.now() + retryDelayMs(attempts)).toISOString() },
      };
      atomicWriteJson(requestPath(located.requestDir!), updated);
      return updated;
    });
    if (due === null) return 'none';
    if (due === 'not_due') return 'pending';

    const event = eventFor(due, 'cancel');
    try {
      await runHandler(due.handler.command, due.handler.args, event);
      const receipt = { schema: 'humanloop.visual-delivery-receipt/v1', action: 'cancel', event, deliveredAt: new Date().toISOString() } as const;
      deliveryReceiptSchema.parse(receipt);
      publishReceipt(cancelReceiptPath(located.requestDir!), receipt, due);
      removeIfPresent(cancelErrorPath(located.requestDir!));
      return 'delivered';
    } catch (error) {
      const message = boundedError(error);
      atomicWriteJson(cancelErrorPath(located.requestDir!), { schema: 'humanloop.visual-delivery-error/v1', action: 'cancel', event, failedAt: new Date().toISOString(), error: message });
      withExclusiveDirectoryLock(requestLockPath(located.requestDir!), () => {
        const current = readLocked(located.requestDir!, located.root, located.dir, requestId);
        if (current?.request.cleanup === undefined || current.request.cleanup.attempts !== due.cleanup!.attempts) return;
        atomicWriteJson(requestPath(located.requestDir!), { ...current.request, cleanup: { ...current.request.cleanup, lastError: message } } satisfies VisualProtocolRequest);
      });
      return 'pending';
    }
  });
}

/** State-first cancellation for one handle; the returned promise is cleanup delivery only. */
export function cancelVisualRequest(root: string, dir: string, requestId: string): Promise<VisualCleanupDeliveryResult> {
  const canceled = stateFirstCancel(root, dir, requestId);
  return canceled?.owed === true ? dispatchVisualCleanup(root, dir, requestId) : Promise.resolve('none');
}

function requestIdsForTicket(root: string, dir: string): string[] {
  const ticket = requireCanonicalTicket(root, dir);
  const parent = canonicalVisualsDirectory(ticket.dir, false);
  if (parent === null) return [];
  return readdirSync(parent).filter((entry) => uuid.safeParse(entry).success).sort();
}

/** State-first cancel every running request, then dispatch every owed cleanup (including start failures). */
export function cancelVisualRequestsForTicket(root: string, dir: string): Promise<{ canceled: number; cleanupOwed: number }> {
  const requests = requestIdsForTicket(root, dir).map((requestId) => ({ requestId, canceled: stateFirstCancel(root, dir, requestId) }));
  const owed = requests.filter((entry) => entry.canceled?.owed === true);
  const canceled = requests.filter((entry) => entry.canceled?.changed === true).length;
  return Promise.all(owed.map((entry) => dispatchVisualCleanup(root, dir, entry.requestId))).then(() => ({ canceled, cleanupOwed: owed.length }));
}

/** Durable tasks the next controller-owned retry executor should schedule. */
export function listVisualCleanupObligations(root: string, dir: string): VisualCleanupTask[] {
  const ticket = requireCanonicalTicket(root, dir);
  const tasks: VisualCleanupTask[] = [];
  for (const requestId of requestIdsForTicket(ticket.root, ticket.dir)) {
    const requestDir = canonicalRequestDirectory(ticket.dir, requestId, false);
    if (requestDir === null) continue;
    const request = readVisualRequest(ticket.root, ticket.dir, requestId);
    if (request?.cleanup !== undefined && cleanupOwed(requestDir, request)) tasks.push({ root: ticket.root, dir: ticket.dir, requestId, reason: request.cleanup.reason, nextAttemptAt: request.cleanup.nextAttemptAt });
  }
  return tasks.sort((left, right) => left.nextAttemptAt.localeCompare(right.nextAttemptAt) || left.requestId.localeCompare(right.requestId));
}
