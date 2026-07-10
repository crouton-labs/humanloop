import { existsSync, linkSync, mkdirSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import type { Deck, DeckTicketResult, FeedbackResult, ReviewDescriptor, ReviewTicketResult, TicketResult } from '../types.js';
import { buildSummary } from '../summary.js';
import { clearProgress, claimPath, deckPath, deliveryErrorPath, deliveryPath, progressPath, responsePath, reviewPath } from './convention.js';
import { validateDeck, validateReviewDescriptor, validateReviewProjection, resolveDeckBodyPaths } from './deck-schema.js';
import { registeredInboxRoot } from './registry.js';
import { readTicketClaim, releaseClaimLocked, withTicketLock } from './claim.js';
import { dispatchCompletion } from './completion.js';

const ticketId = z.string().regex(/^[A-Za-z0-9_-]+$/).min(1).max(128);
const responseSchema = z.object({ id: z.string().min(1), selectedOptionId: z.string().optional(), selectedOptionIds: z.array(z.string()).optional(), freetext: z.string().optional(), optionComments: z.record(z.string(), z.string()).optional() }).strict();
const feedbackCommentSchema = z.object({ id: z.string().min(1), line: z.number().int().positive(), endLine: z.number().int().positive(), quote: z.string().optional(), colStart: z.number().int().nonnegative().optional(), colEnd: z.number().int().nonnegative().optional(), lineText: z.string(), comment: z.string().min(1), createdAt: z.string().min(1) }).strict();
const iso = z.string().datetime({ offset: true });
const feedbackSchema = z.object({ file: z.string().min(1).refine(isAbsolute, 'file must be absolute').refine((file) => resolve(file) === file, 'file must be canonical'), submitted: z.literal(true), approved: z.boolean(), comments: z.array(feedbackCommentSchema), submittedAt: iso, savedAt: iso }).strict().superRefine((result, ctx) => {
  if (result.approved !== (result.comments.length === 0)) ctx.addIssue({ code: 'custom', message: 'approved must match empty comments' });
  result.comments.forEach((comment, index) => {
    if (comment.endLine < comment.line) ctx.addIssue({ code: 'custom', message: 'endLine must be >= line', path: ['comments', index, 'endLine'] });
    if ((comment.colStart === undefined) !== (comment.colEnd === undefined)) ctx.addIssue({ code: 'custom', message: 'columns must be supplied together', path: ['comments', index] });
    if (comment.line === comment.endLine && comment.colStart !== undefined && comment.colEnd !== undefined && comment.colEnd <= comment.colStart) ctx.addIssue({ code: 'custom', message: 'colEnd must exceed colStart', path: ['comments', index, 'colEnd'] });
  });
});
const deckResultSchema = z.object({ schema: z.literal('humanloop.response/v2'), kind: z.literal('deck'), responses: z.array(responseSchema), summary: z.string(), completedAt: iso }).strict();
const reviewResultSchema = z.object({ schema: z.literal('humanloop.review-response/v1'), kind: z.literal('review'), result: feedbackSchema, completedAt: iso }).strict();
const canceledResultSchema = z.object({ schema: z.literal('humanloop.cancel/v1'), kind: z.literal('canceled'), canceledAt: iso, reason: z.string().optional(), actor: z.string().optional() }).strict();

/** Strict decoder for the only canonical final marker. */
export function readTicketResult(dirOrResponsePath: string): TicketResult | null {
  const path = basename(dirOrResponsePath) === 'response.json' ? dirOrResponsePath : responsePath(dirOrResponsePath);
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
  const parsed = deckResultSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const review = reviewResultSchema.safeParse(raw);
  if (review.success) return review.data;
  const canceled = canceledResultSchema.safeParse(raw);
  return canceled.success ? canceled.data : null;
}

function rootAndDir(root: string, id: string): { root: string; dir: string } {
  const registration = registeredInboxRoot(root);
  if (registration === null) throw new Error('interaction root is not registered');
  const parsedId = ticketId.parse(id);
  const dir = resolve(registration.root, parsedId);
  if (dirname(dir) !== registration.root) throw new Error('ticket directory must be a direct child of its registered root');
  return { root: registration.root, dir };
}
function ticketDir(root: string, id: string): { dir: string; created: boolean } {
  const candidate = rootAndDir(root, id);
  let created = false;
  if (!existsSync(candidate.dir)) {
    mkdirSync(candidate.dir, { mode: 0o700 });
    created = true;
  }
  const dir = realpathSync(candidate.dir);
  if (dirname(dir) !== candidate.root) throw new Error('ticket directory must canonically be a direct child of its registered root');
  return { dir, created };
}
function discardCreatedTicket(dir: string, created: boolean): void { if (created) rmSync(dir, { recursive: true, force: true }); }
function hasTicketProtocolState(dir: string): boolean {
  return [deckPath(dir), reviewPath(dir), responsePath(dir), progressPath(dir), claimPath(dir), deliveryPath(dir), deliveryErrorPath(dir)].some(existsSync);
}
function requireRegisteredTicket(dir: string): { root: string; dir: string } {
  const canonical = realpathSync(dir);
  const root = dirname(canonical);
  const registration = registeredInboxRoot(root);
  if (registration === null || registration.root !== root || basename(canonical) === '') throw new Error('ticket must be a canonical direct child of a registered root');
  if (!existsSync(deckPath(canonical)) && !existsSync(reviewPath(canonical))) throw new Error('ticket has no request descriptor');
  return { root, dir: canonical };
}

function publishRequest(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  try { linkSync(temp, path); } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`ticket request already exists: ${path}`);
    throw error;
  } finally { unlinkSync(temp); }
}

export interface SubmitDeckOptions { root: string; id: string; deck: Deck; }
export function submitDeck(opts: SubmitDeckOptions): { id: string; dir: string; kind: 'deck' } {
  // Validate shape before mutating caller-owned interaction directories.
  validateDeck(opts.deck);
  const { dir, created } = ticketDir(opts.root, opts.id);
  try {
    if (hasTicketProtocolState(dir)) throw new Error(`ticket protocol state already exists: ${dir}`);
    const deck = validateDeck(resolveDeckBodyPaths(opts.deck, dir));
    const stamped: Deck = { ...deck, source: { ...(deck.source ?? {}), blockedSince: deck.source?.blockedSince ?? new Date().toISOString() } };
    publishRequest(deckPath(dir), stamped);
    return { id: opts.id, dir, kind: 'deck' };
  } catch (error) {
    discardCreatedTicket(dir, created);
    throw error;
  }
}

export interface SubmitReviewOptions { root: string; id: string; review: Omit<ReviewDescriptor, 'schema' | 'file' | 'output' | 'blockedSince'> & { file: string; output?: string; blockedSince?: string }; }
export function submitReview(opts: SubmitReviewOptions): { id: string; dir: string; kind: 'review' } {
  if (!isAbsolute(opts.review.file) || !existsSync(opts.review.file)) throw new Error('review file must be an existing absolute markdown file');
  if (!/\.md(?:own)?$/i.test(opts.review.file)) throw new Error('review file must be markdown');
  const source = realpathSync(opts.review.file);
  const { dir, created } = ticketDir(opts.root, opts.id);
  try {
    if (hasTicketProtocolState(dir)) throw new Error(`ticket protocol state already exists: ${dir}`);
    const descriptor = validateReviewProjection(dir, { schema: 'humanloop.review/v1', file: source, output: resolve(opts.review.output ?? `${dir}/feedback.json`), title: opts.review.title, source: opts.review.source, blockedSince: opts.review.blockedSince ?? new Date().toISOString() });
    publishRequest(reviewPath(dir), descriptor);
    return { id: opts.id, dir, kind: 'review' };
  } catch (error) {
    discardCreatedTicket(dir, created);
    throw error;
  }
}

function exclusiveResult(dir: string, result: TicketResult): boolean {
  const path = responsePath(dir);
  const temp = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  writeFileSync(temp, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  try { linkSync(temp, path); return true; } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  } finally { unlinkSync(temp); }
}

function requireDeck(dir: string): Deck { return validateDeck(JSON.parse(readFileSync(deckPath(dir), 'utf8'))); }
function requireReview(dir: string): ReviewDescriptor { return validateReviewDescriptor(JSON.parse(readFileSync(reviewPath(dir), 'utf8'))); }
function validateDeckResponses(deck: Deck, raw: DeckTicketResult['responses']): DeckTicketResult['responses'] {
  const responses = z.array(responseSchema).parse(raw);
  const interactions = new Map(deck.interactions.map((interaction) => [interaction.id, interaction]));
  const seen = new Set<string>();
  for (const response of responses) {
    const interaction = interactions.get(response.id);
    if (interaction === undefined || seen.has(response.id)) throw new Error(`response does not match a unique deck interaction: ${response.id}`);
    seen.add(response.id);
    const optionIds = new Set(interaction.options.map((option) => option.id));
    if (response.selectedOptionId !== undefined && (!optionIds.has(response.selectedOptionId) || interaction.multiSelect === true)) throw new Error(`invalid single-select response for ${response.id}`);
    if (response.selectedOptionIds !== undefined && (interaction.multiSelect !== true || response.selectedOptionIds.some((id) => !optionIds.has(id)) || new Set(response.selectedOptionIds).size !== response.selectedOptionIds.length)) throw new Error(`invalid multi-select response for ${response.id}`);
    if (response.freetext !== undefined && interaction.allowFreetext !== true) throw new Error(`freetext is not allowed for ${response.id}`);
    if (response.optionComments !== undefined && (interaction.multiSelect !== true || Object.keys(response.optionComments).some((id) => !optionIds.has(id)))) throw new Error(`invalid option comments for ${response.id}`);
  }
  return responses;
}
function requireClaimOwnership(dir: string, token: string): void {
  if (readTicketClaim(dir)?.token !== token) throw new Error('only the current claim holder may submit a result');
}
function clearOwnedWork(dir: string, claimToken: string): void { clearProgress(dir); releaseClaimLocked(dir, claimToken); }

export function finalizeDeck(dir: string, responses: DeckTicketResult['responses'], claimToken: string, completedAt = new Date().toISOString()): { won: boolean; result: TicketResult } {
  const ticket = requireRegisteredTicket(dir);
  return withTicketLock(ticket.dir, () => {
    requireClaimOwnership(ticket.dir, claimToken);
    const deck = requireDeck(ticket.dir);
    const parsedResponses = validateDeckResponses(deck, responses);
    const result: DeckTicketResult = { schema: 'humanloop.response/v2', kind: 'deck', responses: parsedResponses, summary: buildSummary(deck, parsedResponses), completedAt };
    const won = exclusiveResult(ticket.dir, result);
    clearOwnedWork(ticket.dir, claimToken);
    return { won, result: won ? result : readTicketResult(ticket.dir) ?? result };
  });
}

export function finalizeReview(dir: string, feedback: FeedbackResult, claimToken: string, completedAt = new Date().toISOString()): { won: boolean; result: TicketResult; descriptor: ReviewDescriptor } {
  const ticket = requireRegisteredTicket(dir);
  return withTicketLock(ticket.dir, () => {
    requireClaimOwnership(ticket.dir, claimToken);
    const descriptor = requireReview(ticket.dir);
    const parsed = feedbackSchema.parse(feedback) as FeedbackResult;
    if (realpathSync(parsed.file) !== descriptor.file) throw new Error('review result file does not match descriptor');
    const result: ReviewTicketResult = { schema: 'humanloop.review-response/v1', kind: 'review', result: parsed, completedAt };
    const won = exclusiveResult(ticket.dir, result);
    clearOwnedWork(ticket.dir, claimToken);
    return { won, result: won ? result : readTicketResult(ticket.dir) ?? result, descriptor };
  });
}

export function cancelTicketResult(dir: string, opts: { reason?: string; actor?: string } = {}): { status: 'canceled' | 'already_resolved'; result: TicketResult } {
  const ticket = requireRegisteredTicket(dir);
  return withTicketLock(ticket.dir, () => {
    const result: TicketResult = { schema: 'humanloop.cancel/v1', kind: 'canceled', canceledAt: new Date().toISOString(), ...(opts.reason === undefined ? {} : { reason: opts.reason }), ...(opts.actor === undefined ? {} : { actor: opts.actor }) };
    const won = exclusiveResult(ticket.dir, result);
    return { status: won ? 'canceled' : 'already_resolved', result: won ? result : readTicketResult(ticket.dir) ?? result };
  });
}

export function ticketRoot(dir: string): string | null {
  try { return requireRegisteredTicket(dir).root; } catch { return null; }
}

/** Finalize and immediately cross the trusted root completion boundary. */
export async function completeDeck(dir: string, responses: DeckTicketResult['responses'], claimToken: string): Promise<{ won: boolean; result: TicketResult }> {
  const completed = finalizeDeck(dir, responses, claimToken);
  const root = ticketRoot(dir);
  if (completed.won && root !== null) await dispatchCompletion(root, dir);
  return completed;
}

/** Finalize a review, then let completion own its projection and notification boundary. */
export async function completeReview(dir: string, feedback: FeedbackResult, claimToken: string): Promise<{ won: boolean; result: TicketResult; descriptor: ReviewDescriptor }> {
  const completed = finalizeReview(dir, feedback, claimToken);
  const root = ticketRoot(dir);
  if (completed.won && root !== null) await dispatchCompletion(root, dir);
  return completed;
}

/** Cancellation races finalization but never requires or removes another claim. */
export async function cancelTicket(dir: string, opts: { reason?: string; actor?: string } = {}): Promise<{ status: 'canceled' | 'already_resolved'; result: TicketResult }> {
  const canceled = cancelTicketResult(dir, opts);
  const root = ticketRoot(dir);
  if (canceled.status === 'canceled' && root !== null) await dispatchCompletion(root, dir);
  return canceled;
}
