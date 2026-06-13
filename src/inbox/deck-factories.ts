import { validateDeck } from './deck-schema.js';
import type { Deck } from '../types.js';

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
