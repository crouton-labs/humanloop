import { readConversation } from '../conversation/reader.js';
import type { GenerateVisual } from '../types.js';
import { defaultGenerateVisual } from './generate.js';

/** Build the standard visual generator from explicit originating-session metadata. */
export function visualGeneratorForConversationSession(sessionId: string): GenerateVisual {
  let conversationContext = '';
  try {
    conversationContext = readConversation(sessionId).map((message) => `${message.role}: ${message.content}`).join('\n\n');
  } catch {
    // A missing or unreadable history still permits the ticket to be answered.
  }
  return (interaction) => defaultGenerateVisual(interaction, conversationContext);
}
