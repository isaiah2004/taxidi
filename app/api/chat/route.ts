import { google } from '@ai-sdk/google';
import { streamText, tool } from 'ai';
import { z } from 'zod';

export const maxDuration = 60; // Allow longer responses

export async function POST(req: Request) {
  const { messages } = await req.json();

  const result = streamText({
    model: google('gemini-1.5-pro'),
    system: 'You are an AI assistant helping users plan trips collaboratively. Keep your answers concise and helpful. When a user asks about a place, use the searchPlaces tool to find it.',
    messages,
    tools: {
      searchPlaces: tool({
        description: 'Search for places using Google Places API (Text Search)',
        parameters: z.object({
          query: z.string().describe('The search query, e.g., "restaurants in Tokyo" or "Eiffel Tower"'),
        }),
        // @ts-ignore
        execute: async ({ query }: { query: string }) => {
          const apiKey = process.env.GOOGLE_PLACES_API_KEY;
          if (!apiKey) {
            return { error: 'GOOGLE_PLACES_API_KEY is not configured.' };
          }
          try {
            const response = await fetch(
              `https://places.googleapis.com/v1/places:searchText`,
              {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'X-Goog-Api-Key': apiKey,
                  'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.rating,places.userRatingCount,places.websiteUri,places.priceLevel',
                },
                body: JSON.stringify({ textQuery: query }),
              }
            );
            if (!response.ok) {
              throw new Error(`Google Places API error: ${response.statusText}`);
            }
            const data = await response.json();
            return data.places ? data.places.slice(0, 5) : { message: 'No places found' };
          } catch (error: any) {
            return { error: error.message };
          }
        },
      }) as any,
    },
  });

  return result.toTextStreamResponse();
}

