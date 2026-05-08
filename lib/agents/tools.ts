/**
 * Planner-agent tool definitions.
 *
 * `buildPlannerTools(ctx)` returns a `ToolSet` (in `streamText`'s sense) where
 * each entry is built with the AI SDK v6 `tool({ inputSchema, execute })`
 * helper. Two flavors of tool live here:
 *
 *   - **Research / lookup** (`web_research`, `search_places`): the model uses
 *     these to discover candidates. They have side effects bounded to logging
 *     a step row for traceability.
 *   - **Propose** (`propose_*_node`): these don't mutate the trip plan.
 *     Instead, they emit a structured "card" output that the chat UI renders
 *     as a form. The user clicks **Accept** to commit the node via the
 *     `/api/trips/.../variants/.../nodes` endpoint owned by Agent 2.
 *
 * Every `execute` records an `agent_run_step` with a deterministic
 * idempotency key so a retry replays as a no-op (uniqueness is enforced at
 * the DB layer; we use `recordStep` which performs `ON CONFLICT DO NOTHING`).
 *
 * Note on `search_places`: spec calls for a `searchPlaces` helper that does
 * not yet exist in `lib/places.ts` (Agent 1 will add it). Until it lands, we
 * fall back to `resolvePlace` for a single best match. The tool's external
 * shape (`{ results: [...] }`) is stable so the upgrade is transparent.
 */
import { tool, type Tool, type ToolSet } from 'ai';
import { z } from 'zod';

import { resolvePlace } from '@/lib/places';
import { makeIdempotencyKey, recordStep } from './persist';

// ---------------------------------------------------------------------------
// Context passed in from the route handler
// ---------------------------------------------------------------------------

export interface PlannerToolContext {
  tripBookId: string;
  variantId: string;
  userId: string;
  agentRunId: string;
}

// ---------------------------------------------------------------------------
// Shared sub-schemas — kept small so streamed partial inputs render
// reasonably even when only the head of the JSON object has arrived.
// ---------------------------------------------------------------------------

const citationSchema = z.object({
  url: z.string().url(),
  title: z.string().optional(),
  snippet: z.string().optional(),
});

const placeRefSchema = z.object({
  placeId: z.string().optional(),
  lat: z.number().optional(),
  lng: z.number().optional(),
  address: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Step counter — each tool execution increments to produce a stable `idx`
// in the agent_run_step table. Closure-private to the factory so we get
// per-run counters rather than a global one.
// ---------------------------------------------------------------------------

function stepCounter(): () => number {
  let i = 0;
  return () => i++;
}

// ---------------------------------------------------------------------------
// Helper to wrap a tool execute fn with step recording. We intentionally
// fire-and-forget the recordStep promise inside a try/catch — failing to
// persist the step shouldn't break the user's chat experience, and the
// idempotency key keeps things consistent if the call retries.
// ---------------------------------------------------------------------------

async function withStep<I, O>(
  ctx: PlannerToolContext,
  next: () => number,
  toolName: string,
  input: I,
  execute: () => Promise<O>,
): Promise<O> {
  const idx = next();
  const idempotencyKey = makeIdempotencyKey(toolName, input);
  let output: O;
  try {
    output = await execute();
  } catch (err) {
    // Persist a step with the error so the run history shows what was
    // attempted — but don't let persistence problems mask the original.
    try {
      await recordStep({
        agentRunId: ctx.agentRunId,
        idx,
        toolName,
        toolInput: input,
        toolOutput: { error: err instanceof Error ? err.message : String(err) },
        idempotencyKey,
      });
    } catch {
      // swallow
    }
    throw err;
  }

  try {
    await recordStep({
      agentRunId: ctx.agentRunId,
      idx,
      toolName,
      toolInput: input,
      toolOutput: output,
      idempotencyKey,
    });
  } catch (e) {
    console.error('[planner.tools] recordStep failed', { toolName, error: e });
  }
  return output;
}

// ---------------------------------------------------------------------------
// buildPlannerTools — factory invoked once per agent run
// ---------------------------------------------------------------------------

export function buildPlannerTools(ctx: PlannerToolContext): ToolSet {
  const next = stepCounter();

  // -------------------------------------------------------------------------
  // Research / lookup tools
  // -------------------------------------------------------------------------

  const webResearchInput = z.object({
    query: z.string().min(1).describe('A focused web research query.'),
  });
  const web_research = tool({
    description:
      'Note an explicit research query. Gemini Search Grounding (configured at the model level) does the real work — this tool exists so the agent can structure its intent and so the UI can show a research bubble.',
    inputSchema: webResearchInput,
    execute: async (input) =>
      withStep(ctx, next, 'web_research', input, async () => {
        return {
          query: input.query,
          note: 'Gemini Search Grounding is enabled at the model level; sources will appear on the assistant message as source-url parts.',
        };
      }),
  });

  // -------------------------------------------------------------------------

  const searchPlacesInput = z.object({
    query: z.string().min(1).describe('Free-text place search.'),
    near: z
      .object({
        lat: z.number(),
        lng: z.number(),
        radiusMeters: z.number().int().positive().optional(),
      })
      .optional()
      .describe('Bias results toward this point.'),
    type: z
      .string()
      .optional()
      .describe('Optional place type hint, e.g. "restaurant", "hotel".'),
    limit: z.number().int().positive().max(10).optional(),
  });
  const search_places = tool({
    description:
      'Look up real places via Google Places. Use after web_research narrows you to a city or area.',
    inputSchema: searchPlacesInput,
    execute: async (input) =>
      withStep(ctx, next, 'search_places', input, async () => {
        // searchPlaces (multi-result) is owned by Agent 1 and may not be
        // present yet. Fall back to resolvePlace's single best match so the
        // agent can keep moving — the public output shape stays the same.
        try {
          const lib = await import('@/lib/places');
          const maybeFn = (lib as unknown as Record<string, unknown>)
            .searchPlaces;
          if (typeof maybeFn === 'function') {
            const fn = maybeFn as (
              args: typeof input,
            ) => Promise<{ results: unknown[] }>;
            const result = await fn(input);
            return result;
          }
        } catch {
          // fall through to fallback
        }

        const place = await resolvePlace(input.query);
        return {
          results: place
            ? [
                {
                  placeId: place.placeId,
                  name: place.name,
                  address: place.address,
                  lat: place.lat,
                  lng: place.lng,
                },
              ]
            : [],
        };
      }),
  });

  // -------------------------------------------------------------------------
  // Propose tools — produce structured cards. They DO NOT mutate the DB.
  // -------------------------------------------------------------------------

  const placeCardInput = z
    .object({
      suggestedTitle: z.string().min(1),
      suggestedNotes: z.string().optional(),
      placeId: z.string().optional(),
      lat: z.number().optional(),
      lng: z.number().optional(),
      address: z.string().optional(),
      suggestedStartAt: z.string().optional(),
      suggestedEndAt: z.string().optional(),
      dayOriginId: z
        .string()
        .optional()
        .describe('Origin id of the parent day node, when the card belongs to a day.'),
      citations: z.array(citationSchema).optional(),
    })
    .merge(placeRefSchema.partial());

  const propose_place_node = tool({
    description:
      'Propose a Place / destination node (city, POI). Renders as a card the user can Accept.',
    inputSchema: placeCardInput,
    execute: async (input) =>
      withStep(ctx, next, 'propose_place_node', input, async () => input),
  });

  // -------------------------------------------------------------------------

  const lodgingCardInput = z.object({
    suggestedTitle: z.string().min(1),
    suggestedNotes: z.string().optional(),
    placeId: z.string().optional(),
    lat: z.number().optional(),
    lng: z.number().optional(),
    address: z.string().optional(),
    checkIn: z.string().optional().describe('ISO datetime for check-in.'),
    checkOut: z.string().optional().describe('ISO datetime for check-out.'),
    pricePerNight: z.string().optional(),
    bookingUrl: z.string().url().optional(),
    dayOriginId: z.string().optional(),
    citations: z.array(citationSchema).optional(),
  });
  const propose_lodging_node = tool({
    description: 'Propose a Lodging (hotel / Airbnb / hostel) node.',
    inputSchema: lodgingCardInput,
    execute: async (input) =>
      withStep(ctx, next, 'propose_lodging_node', input, async () => input),
  });

  // -------------------------------------------------------------------------

  const activityCardInput = z.object({
    suggestedTitle: z.string().min(1),
    suggestedNotes: z.string().optional(),
    placeId: z.string().optional(),
    lat: z.number().optional(),
    lng: z.number().optional(),
    address: z.string().optional(),
    suggestedStartAt: z.string().optional(),
    durationMinutes: z.number().int().positive().optional(),
    bookingUrl: z.string().url().optional(),
    price: z.string().optional(),
    dayOriginId: z.string().optional(),
    citations: z.array(citationSchema).optional(),
  });
  const propose_activity_node = tool({
    description: 'Propose an Activity (tour, attraction, experience) node.',
    inputSchema: activityCardInput,
    execute: async (input) =>
      withStep(ctx, next, 'propose_activity_node', input, async () => input),
  });

  // -------------------------------------------------------------------------

  const mealCardInput = z.object({
    suggestedTitle: z.string().min(1),
    suggestedNotes: z.string().optional(),
    placeId: z.string().optional(),
    lat: z.number().optional(),
    lng: z.number().optional(),
    address: z.string().optional(),
    suggestedStartAt: z.string().optional(),
    cuisine: z.string().optional(),
    reservationStatus: z
      .enum(['none', 'recommended', 'required', 'booked'])
      .optional(),
    bookingUrl: z.string().url().optional(),
    priceRange: z.string().optional(),
    dayOriginId: z.string().optional(),
    citations: z.array(citationSchema).optional(),
  });
  const propose_meal_node = tool({
    description: 'Propose a Meal (restaurant / cafe / bar) node.',
    inputSchema: mealCardInput,
    execute: async (input) =>
      withStep(ctx, next, 'propose_meal_node', input, async () => input),
  });

  // -------------------------------------------------------------------------

  const transportCardInput = z.object({
    suggestedTitle: z.string().min(1),
    mode: z.enum(['flight', 'train', 'bus', 'car', 'ferry', 'walk']),
    fromOriginId: z
      .string()
      .describe('Origin id of an already-committed source place node.'),
    toOriginId: z
      .string()
      .describe('Origin id of an already-committed destination place node.'),
    departAt: z.string().optional(),
    arriveAt: z.string().optional(),
    carrier: z.string().optional(),
    bookingUrl: z.string().url().optional(),
    price: z.string().optional(),
    suggestedNotes: z.string().optional(),
    citations: z.array(citationSchema).optional(),
  });
  const propose_transport_node = tool({
    description:
      'Propose a Transport leg between two committed places. Both endpoints must already exist (origin ids).',
    inputSchema: transportCardInput,
    execute: async (input) =>
      withStep(ctx, next, 'propose_transport_node', input, async () => input),
  });

  // -------------------------------------------------------------------------

  const dayCardInput = z.object({
    date: z.string().describe('Calendar date (YYYY-MM-DD) for this day.'),
    title: z.string().optional(),
    sortIndex: z.number().int().optional(),
    suggestedNotes: z.string().optional(),
    citations: z.array(citationSchema).optional(),
  });
  const propose_day_node = tool({
    description: 'Propose a Day grouping node.',
    inputSchema: dayCardInput,
    execute: async (input) =>
      withStep(ctx, next, 'propose_day_node', input, async () => input),
  });

  // -------------------------------------------------------------------------
  // Optional v1 extras — light-weight node ops the model can suggest.
  // -------------------------------------------------------------------------

  const updatePatchSchema = z.object({
    originId: z.string(),
    patch: z.record(z.string(), z.unknown()),
    citations: z.array(citationSchema).optional(),
  });
  const update_node_proposal = tool({
    description:
      'Propose a patch to an existing node in the user\'s variant. The user reviews the diff before applying.',
    inputSchema: updatePatchSchema,
    execute: async (input) =>
      withStep(ctx, next, 'update_node_proposal', input, async () => input),
  });

  const deleteProposalSchema = z.object({
    originId: z.string(),
    reason: z.string().optional(),
  });
  const delete_node_proposal = tool({
    description: 'Propose deleting a node. The user confirms.',
    inputSchema: deleteProposalSchema,
    execute: async (input) =>
      withStep(ctx, next, 'delete_node_proposal', input, async () => input),
  });

  const moveProposalSchema = z.object({
    originId: z.string(),
    newParentOriginId: z.string().nullable(),
    newSortIndex: z.number().int().optional(),
  });
  const move_node_proposal = tool({
    description:
      'Propose moving a node under a new parent (or to the trip root, with newParentOriginId=null).',
    inputSchema: moveProposalSchema,
    execute: async (input) =>
      withStep(ctx, next, 'move_node_proposal', input, async () => input),
  });

  // -------------------------------------------------------------------------

  const tools: Record<string, Tool<unknown, unknown>> = {
    web_research: web_research as unknown as Tool<unknown, unknown>,
    search_places: search_places as unknown as Tool<unknown, unknown>,
    propose_place_node: propose_place_node as unknown as Tool<unknown, unknown>,
    propose_lodging_node:
      propose_lodging_node as unknown as Tool<unknown, unknown>,
    propose_activity_node:
      propose_activity_node as unknown as Tool<unknown, unknown>,
    propose_meal_node: propose_meal_node as unknown as Tool<unknown, unknown>,
    propose_transport_node:
      propose_transport_node as unknown as Tool<unknown, unknown>,
    propose_day_node: propose_day_node as unknown as Tool<unknown, unknown>,
    update_node_proposal:
      update_node_proposal as unknown as Tool<unknown, unknown>,
    delete_node_proposal:
      delete_node_proposal as unknown as Tool<unknown, unknown>,
    move_node_proposal:
      move_node_proposal as unknown as Tool<unknown, unknown>,
  };

  return tools as ToolSet;
}
