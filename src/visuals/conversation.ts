import { readConversationText } from '../conversation/reader.js';
import type { GenerateVisual, Interaction } from '../types.js';
import { defaultGenerateVisual } from './generate.js';

type VisualGenerator = (interaction: Interaction, conversationContext: string, cols?: number) => ReturnType<typeof defaultGenerateVisual>;
type ConversationTextReader = (sessionId: string) => Promise<string>;

/** Build the standard visual generator from explicit originating-session metadata. */
export function visualGeneratorForConversationSession(sessionId: string, generateVisual: VisualGenerator = defaultGenerateVisual, readContext: ConversationTextReader = readConversationText): GenerateVisual {
  // One lookup feeds every interaction and resize regeneration in this mounted panel.
  // A failed lookup remains a failed visual rather than falling through to a generic prompt.
  const context = readContext(sessionId);
  return async (interaction, cols) => {
    try {
      return await generateVisual(interaction, await context, cols);
    } catch {
      return { ok: false, error: 'visual context unavailable' };
    }
  };
}
