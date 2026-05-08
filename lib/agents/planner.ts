/**
 * Planning agent. Wires Gemini + the planner tool set into a `streamText`
 * call and converts the result into a UI message stream that `useChat`
 * consumes on the client.
 *
 * Search grounding: AI SDK v6 dropped the `useSearchGrounding` constructor
 * option in favour of the provider-tool factory `google.tools.googleSearch({})`.
 * We register that tool alongside our planner tools so Gemini can call it
 * autonomously and emit `source-url` parts on the assistant message.
 *
 * Lifecycle: at the start of a run we create one `agent_run` row; in
 * `onFinish` we update it with totals + status and append a sentinel
 * assistant message linking the chat thread to the run. Failures path
 * through `onError` -> `finishAgentRun({ status: 'failed' })`.
 */
import { google } from '@ai-sdk/google';
import {
  convertToModelMessages,
  stepCountIs,
  streamText,
  type UIMessage,
} from 'ai';

import { appendChatMessage, finishAgentRun, startAgentRun } from './persist';
import { buildPlannerTools } from './tools';

interface RunPlannerInput {
  tripBookId: string;
  variantId: string;
  userId: string;
  /** UIMessage[] from the client (already validated for membership upstream). */
  messages: UIMessage[];
}

// Pinned model + system prompt. Keep these centralized so the A/B agent
// can consume the same defaults if we ever need to experiment.
const MODEL_ID = 'gemini-2.5-flash';
const MAX_STEPS = 8;

const SYSTEM_PROMPT = `You are Taxidi's planning agent helping plan a trip collaboratively.

Workflow:
1. Use web_research to scope research queries when you need fresh info (Gemini Search Grounding will fetch real sources).
2. Use search_places to find specific real places. Pass \`near={lat,lng}\` whenever you already know the area.
3. Propose ONE card per concrete recommendation — do not propose abstract ideas.

Tool routing:
- propose_place_node — cities / destinations / POIs.
- propose_lodging_node — hotels, hostels, apartments. Include checkIn/checkOut when known.
- propose_activity_node — tours, attractions, experiences. Include durationMinutes / bookingUrl when known.
- propose_meal_node — restaurants, cafes, bars. Include cuisine and reservationStatus when relevant.
- propose_transport_node — ONLY when both endpoints already exist as committed places (referenced by origin_id).
- propose_day_node — to add a Day grouping. Days hold places via parent_origin_id.

Quality bar:
- Notes must be concise (<= 2 sentences).
- Cite a source URL when you used web_research.
- Prefer real, specific places; avoid generic placeholders.
- Stop after generating enough cards for the user to choose from (a handful per request is plenty).`;

export async function runPlanner(input: RunPlannerInput): Promise<Response> {
  const agentRunId = await startAgentRun({
    tripBookId: input.tripBookId,
    variantId: input.variantId,
    kind: 'edit',
    triggeredByUserId: input.userId,
    model: MODEL_ID,
  });

  const tools = buildPlannerTools({
    tripBookId: input.tripBookId,
    variantId: input.variantId,
    userId: input.userId,
    agentRunId,
  });

  // `convertToModelMessages` is async in v6; await it before passing on.
  const modelMessages = await convertToModelMessages(input.messages, {
    tools,
    ignoreIncompleteToolCalls: true,
  });

  // Mix in Gemini's googleSearch provider tool so the model can ground
  // freely. It has no input schema we need to cite — Google handles the
  // search and emits source URLs as part of the response.
  const toolsWithSearch = {
    ...tools,
    google_search: google.tools.googleSearch({}),
  };

  const result = streamText({
    model: google(MODEL_ID),
    system: SYSTEM_PROMPT,
    messages: modelMessages,
    tools: toolsWithSearch,
    stopWhen: stepCountIs(MAX_STEPS),
    onFinish: async ({ usage }) => {
      try {
        await finishAgentRun({
          agentRunId,
          status: 'succeeded',
          totalInputTokens: usage?.inputTokens ?? 0,
          totalOutputTokens: usage?.outputTokens ?? 0,
        });
        await appendChatMessage({
          tripBookId: input.tripBookId,
          userId: null,
          role: 'assistant',
          content: '[planner run complete]',
          agentRunId,
          variantId: input.variantId,
        });
      } catch (e) {
        console.error('[planner] finalize failed', e);
      }
    },
    onError: async (event) => {
      const err = (event as { error?: unknown })?.error ?? event;
      console.error('[planner] error', err);
      try {
        await finishAgentRun({ agentRunId, status: 'failed' });
      } catch {
        // already logged
      }
    },
  });

  return result.toUIMessageStreamResponse();
}
