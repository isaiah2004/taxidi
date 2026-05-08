import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { streamText, tool, convertToModelMessages, type UIMessage } from 'ai';
import { z } from 'zod';

export const maxDuration = 60;

const google = createGoogleGenerativeAI({
  apiKey: process.env.GOOGLE_GEMINI_API_KEY?.trim(),
});

export async function POST(req: Request) {
  const { messages }: { messages: UIMessage[] } = await req.json();

  const result = streamText({
    model: google('gemini-2.5-flash'),
    system:
      'You are an AI assistant helping users plan trips collaboratively. Keep your answers concise and helpful. When a user asks about a place, use the searchPlaces tool to find it.',
    messages: await convertToModelMessages(messages),
    tools: {
      searchPlaces: tool({
        description: 'Search for places using Google Places API (Text Search)',
        inputSchema: z.object({
          query: z
            .string()
            .describe('The search query, e.g., "restaurants in Tokyo" or "Eiffel Tower"'),
        }),
        execute: async ({ query }) => {
          const apiKey = process.env.GOOGLE_PLACES_API?.trim();
          if (!apiKey) {
            return { error: 'GOOGLE_PLACES_API is not configured.' };
          }
          try {
            const response = await fetch(
              'https://places.googleapis.com/v1/places:searchText',
              {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'X-Goog-Api-Key': apiKey,
                  'X-Goog-FieldMask':
                    'places.displayName,places.formattedAddress,places.rating,places.userRatingCount,places.websiteUri,places.priceLevel',
                },
                body: JSON.stringify({ textQuery: query }),
              },
            );
            if (!response.ok) {
              throw new Error(`Google Places API error: ${response.statusText}`);
            }
            const data = await response.json();
            return data.places ? data.places.slice(0, 5) : { message: 'No places found' };
          } catch (error) {
            return { error: error instanceof Error ? error.message : 'Unknown error' };
          }
        },
      }),
    },
  });

  return result.toUIMessageStreamResponse();
}
