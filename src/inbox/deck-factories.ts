import { validateDeck } from './deck-schema.js';
import type { Deck } from '../types.js';

export interface NotifyDeckOpts {
  /** One plain-English sentence stating the notification's status and stakes. */
  subtitle: string;
  body?: string;
}

/** Build a validated single-option notify deck. id: 'notify', kind: 'notify'. */
export function notifyDeck(title: string, opts: NotifyDeckOpts): Deck {
  return validateDeck({
    title,
    interactions: [{
      id: 'notify',
      title,
      subtitle: opts.subtitle,
      ...(opts.body !== undefined ? { body: opts.body } : {}),
      kind: 'notify',
      options: [{ id: 'ok', label: 'OK' }],
    }],
  });
}
