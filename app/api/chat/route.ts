import { openai } from '@ai-sdk/openai';
import { streamText } from 'ai';

export const maxDuration = 30; // Allow longer responses

export async function POST(req: Request) {
  const { messages } = await req.json();

  const result = streamText({
    model: openai('gpt-4o-mini'),
    system: 'You are an AI assistant helping users plan trips. Keep your answers concise and helpful.',
    messages,
  });

  return result.toDataStreamResponse();
}
