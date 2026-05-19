import { validateDeck } from './deck-schema.js';
import type { Deck } from '../types.js';

export interface ApproveDeckOpts {
  subtitle?: string;
  body?: string;
}

/** Build a validated Yes/No validation deck. id: 'approve', kind: 'validation'. */
export function approveDeck(title: string, opts: ApproveDeckOpts = {}): Deck {
  return validateDeck({
    interactions: [{
      id: 'approve',
      title,
      ...(opts.subtitle !== undefined ? { subtitle: opts.subtitle } : {}),
      ...(opts.body !== undefined ? { body: opts.body } : {}),
      kind: 'validation',
      options: [
        { id: 'yes', label: 'Yes' },
        { id: 'no', label: 'No' },
      ],
    }],
  });
}

export interface NotifyDeckOpts {
  body?: string;
}

/** Build a validated single-option notify deck. id: 'notify', kind: 'notify'. */
export function notifyDeck(title: string, opts: NotifyDeckOpts = {}): Deck {
  return validateDeck({
    interactions: [{
      id: 'notify',
      title,
      ...(opts.body !== undefined ? { body: opts.body } : {}),
      kind: 'notify',
      options: [{ id: 'ok', label: 'OK' }],
    }],
  });
}
