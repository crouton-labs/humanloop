import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, resolve, sep } from 'node:path';
import { claimPath, deckPath, deliveryErrorPath, deliveryPath, followupRequestPath, followupResultPath, progressPath, responsePath, reviewPath } from './convention.js';
import { z } from 'zod';
import { INTERACTION_KINDS } from '../types.js';
import type { Deck, ReviewDescriptor } from '../types.js';
import { checkMarkdown } from '../render/termrender.js';

export const interactionOptionSchema = z.object({ id: z.string().min(1), label: z.string().min(1), description: z.string().optional() });
export const preAnswerSchema = z.object({ selectedOptionId: z.string().optional(), selectedOptionIds: z.array(z.string()).optional(), freetext: z.string().optional(), label: z.string().optional() });
const interactionSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]+$/, { error: 'interaction id must match /^[A-Za-z0-9_-]+$/' }).min(1).max(64),
  title: z.string().min(1), subtitle: z.string().min(1).optional(), body: z.string().optional(), bodyPath: z.string().optional(),
  options: z.array(interactionOptionSchema), multiSelect: z.boolean().optional(), allowFreetext: z.boolean().optional(), freetextLabel: z.string().optional(), kind: z.enum(INTERACTION_KINDS).optional(), preAnswered: preAnswerSchema.optional(),
});
const deckSourceSchema = z.object({ sessionName: z.string().optional(), askedBy: z.string().optional(), blockedSince: z.string().optional(), nodeId: z.string().optional() });
export const deckSchema = z.object({ title: z.string().optional(), source: deckSourceSchema.optional(), interactions: z.array(interactionSchema).min(1) }).superRefine((input, ctx) => {
  const seen = new Set<string>();
  input.interactions.forEach((interaction, index) => {
    if (interaction.body !== undefined && interaction.bodyPath !== undefined) ctx.addIssue({ code: 'custom', message: 'body and bodyPath are mutually exclusive', path: ['interactions', index] });
    if (seen.has(interaction.id)) ctx.addIssue({ code: 'custom', message: `duplicate interaction id "${interaction.id}"`, path: ['interactions', index, 'id'] });
    seen.add(interaction.id);
  });
});

const reviewSourceSchema = deckSourceSchema;
export const reviewDescriptorSchema = z.object({
  schema: z.literal('humanloop.review/v1'),
  file: z.string().min(1).refine(isAbsolute, 'file must be absolute'),
  output: z.string().min(1).refine(isAbsolute, 'output must be absolute'),
  title: z.string().min(1),
  source: reviewSourceSchema,
  blockedSince: z.string().datetime({ offset: true }),
}).strict();

function readBodyPathFile(dir: string, bodyPath: string): string {
  const joined = resolve(dir, bodyPath);
  if (!existsSync(joined)) throw new Error(`bodyPath does not exist: '${bodyPath}'`);
  if (!lstatSync(joined).isFile()) throw new Error(`bodyPath must be a regular file: ${bodyPath}`);
  const realResolved = realpathSync(joined);
  const realDeckDir = realpathSync(dir);
  if (!realResolved.startsWith(realDeckDir + sep)) throw new Error(`bodyPath '${bodyPath}' escapes the deck directory`);
  return readFileSync(joined, 'utf8');
}

export function resolveDeckBodyPaths(deck: Deck, dir: string): Deck {
  return { ...deck, interactions: deck.interactions.map((interaction) => {
    if (interaction.bodyPath === undefined) return interaction;
    const { bodyPath: _bodyPath, ...rest } = interaction;
    return { ...rest, body: readBodyPathFile(dir, interaction.bodyPath) };
  }) };
}

export function parseDeck(path: string): Deck {
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, 'utf8')); } catch { throw new Error('deck is not valid JSON'); }
  const deck = resolveDeckBodyPaths(deckSchema.parse(raw), dirname(path));
  for (const interaction of deck.interactions) if (interaction.body !== undefined) {
    const check = checkMarkdown(interaction.body);
    if (!check.ok) throw new Error(check.error);
  }
  return deck;
}

export function validateDeck(parsed: unknown): Deck { return deckSchema.parse(parsed) as Deck; }
export function validateReviewDescriptor(parsed: unknown): ReviewDescriptor { return reviewDescriptorSchema.parse(parsed) as ReviewDescriptor; }

/** Canonicalize and authorize the one review projection boundary before every write. */
export function validateReviewProjection(dir: string, parsed: unknown): ReviewDescriptor {
  const descriptor = validateReviewDescriptor(parsed);
  if (!/\.md(?:own)?$/i.test(descriptor.file) || !existsSync(descriptor.file)) throw new Error('review file must be an existing absolute markdown file');
  const file = realpathSync(descriptor.file);
  const output = resolve(realpathSync(dirname(descriptor.output)), basename(descriptor.output));
  const reserved = new Set(['deck.json', 'review.json', 'response.json', 'progress.json', 'claim.json', 'delivery.json', 'delivery-error.json', 'followup-request.json', 'followup-result.json']);
  const ownProtocolPaths = new Set([deckPath(dir), reviewPath(dir), responsePath(dir), progressPath(dir), claimPath(dir), deliveryPath(dir), deliveryErrorPath(dir), followupRequestPath(dir), followupResultPath(dir)]);
  if (output === file || reserved.has(basename(output)) || ownProtocolPaths.has(output)) throw new Error('review output must not alias the source or ticket protocol files');
  return { ...descriptor, file, output };
}
