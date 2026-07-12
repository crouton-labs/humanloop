import { readPiConversationText } from '../conversation/reader.js';
import type { GenerateVisual, Interaction } from '../types.js';
import { defaultGenerateVisual } from './generate.js';

type VisualGenerator = (interaction: Interaction, conversationContext: string, cols?: number) => ReturnType<typeof defaultGenerateVisual>;

/** Build the standard visual generator from explicit originating pi-session metadata. */
export function visualGeneratorForConversationSession(sessionId: string, generateVisual: VisualGenerator = defaultGenerateVisual): GenerateVisual {
  // One lookup feeds every interaction and resize regeneration in this mounted panel.
  // A failed lookup remains a failed visual rather than falling through to a generic prompt.
  const context = readPiConversationText(sessionId);
  return async (interaction, cols) => {
    try {
      return await generateVisual(interaction, await context, cols);
    } catch {
      return { ok: false, error: 'visual context unavailable' };
    }
  };
}
