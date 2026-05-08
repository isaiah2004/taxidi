/**
 * Pure-schema tests for `lib/agents/tools.ts`.
 *
 * `buildPlannerTools` returns a `ToolSet` where each entry was constructed with
 * `tool({ inputSchema: z.object(...), execute: ... })`. We don't exercise
 * `execute` here (that path hits the DB). Instead, for each `propose_*_node`
 * tool we walk the Zod input schema and assert that:
 *   - a representative valid sample passes,
 *   - a malformed sample (missing required field, or a wrong-typed enum) fails.
 *
 * `tool()` from the AI SDK is a passthrough that preserves `inputSchema`, so
 * we can pull the schema off the returned tool object directly without
 * instantiating the model or running the execute closure.
 *
 * We mock `@/lib/db` so importing `tools.ts` doesn't construct a real
 * `pg.Pool` — schema validation is pure and never touches Drizzle, but
 * tools.ts's transitive imports include `@/lib/db` for the `propose_transport`
 * enrichment query. Stub it with a no-op surface so the import succeeds.
 */
import { describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';

vi.mock('@/lib/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve([]),
      }),
    }),
    insert: () => ({
      values: () => ({
        onConflictDoNothing: () => Promise.resolve(),
      }),
    }),
  },
}));

import { buildPlannerTools, type PlannerToolContext } from '@/lib/agents/tools';

// Build the tools once with stub IDs. None of the schemas reference the
// context object, so any non-empty values work. Module-load side effects in
// `@/lib/db` don't open a DB connection until a query is issued.
const ctx: PlannerToolContext = {
  tripBookId: 'tb-test',
  variantId: 'v-test',
  userId: 'u-test',
  agentRunId: 'r-test',
};

const tools = buildPlannerTools(ctx);

/**
 * Pull the Zod input schema off a tool entry. The tool() helper preserves the
 * exact `inputSchema` reference passed in, so this is a direct property read.
 */
function schemaFor(toolName: string): z.ZodTypeAny {
  const t = tools[toolName] as { inputSchema?: unknown } | undefined;
  if (!t || typeof t !== 'object' || !('inputSchema' in t)) {
    throw new Error(`Tool ${toolName} has no inputSchema`);
  }
  return t.inputSchema as z.ZodTypeAny;
}

// ---------------------------------------------------------------------------
// propose_place_node
// ---------------------------------------------------------------------------

describe('propose_place_node schema', () => {
  it('accepts a minimal valid input (just a non-empty title)', () => {
    const schema = schemaFor('propose_place_node');
    const result = schema.safeParse({ suggestedTitle: 'Reykjavik' });
    expect(result.success).toBe(true);
  });

  it('accepts a fully-populated input with citations', () => {
    const schema = schemaFor('propose_place_node');
    const result = schema.safeParse({
      suggestedTitle: 'Reykjavik',
      suggestedNotes: 'Capital of Iceland',
      placeId: 'p-1',
      lat: 64.13,
      lng: -21.93,
      address: 'Reykjavik, Iceland',
      suggestedStartAt: '2026-06-01T00:00:00Z',
      suggestedEndAt: '2026-06-08T00:00:00Z',
      dayOriginId: 'origin-day-1',
      citations: [{ url: 'https://example.com', title: 'Wikipedia' }],
    });
    expect(result.success).toBe(true);
  });

  it('rejects an empty suggestedTitle', () => {
    const schema = schemaFor('propose_place_node');
    const result = schema.safeParse({ suggestedTitle: '' });
    expect(result.success).toBe(false);
  });

  it('rejects a missing suggestedTitle', () => {
    const schema = schemaFor('propose_place_node');
    const result = schema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('rejects a malformed citation url', () => {
    const schema = schemaFor('propose_place_node');
    const result = schema.safeParse({
      suggestedTitle: 'Reykjavik',
      citations: [{ url: 'not-a-url' }],
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// propose_lodging_node
// ---------------------------------------------------------------------------

describe('propose_lodging_node schema', () => {
  it('accepts a valid input with check-in / check-out', () => {
    const schema = schemaFor('propose_lodging_node');
    const result = schema.safeParse({
      suggestedTitle: 'Hotel Reykjavik',
      checkIn: '2026-06-01T16:00:00Z',
      checkOut: '2026-06-02T11:00:00Z',
      bookingUrl: 'https://booking.example.com/hotel-reykjavik',
    });
    expect(result.success).toBe(true);
  });

  it('rejects an invalid bookingUrl', () => {
    const schema = schemaFor('propose_lodging_node');
    const result = schema.safeParse({
      suggestedTitle: 'Hotel Reykjavik',
      bookingUrl: 'not a url',
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// propose_activity_node
// ---------------------------------------------------------------------------

describe('propose_activity_node schema', () => {
  it('accepts a valid input with a positive durationMinutes', () => {
    const schema = schemaFor('propose_activity_node');
    const result = schema.safeParse({
      suggestedTitle: 'Blue Lagoon',
      durationMinutes: 180,
      suggestedStartAt: '2026-06-02T10:00:00Z',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a non-positive durationMinutes', () => {
    const schema = schemaFor('propose_activity_node');
    const result = schema.safeParse({
      suggestedTitle: 'Blue Lagoon',
      durationMinutes: 0,
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// propose_meal_node
// ---------------------------------------------------------------------------

describe('propose_meal_node schema', () => {
  it('accepts a valid input with reservationStatus enum', () => {
    const schema = schemaFor('propose_meal_node');
    const result = schema.safeParse({
      suggestedTitle: 'Dill',
      reservationStatus: 'recommended',
      cuisine: 'Modern Nordic',
    });
    expect(result.success).toBe(true);
  });

  it('rejects an invalid reservationStatus value', () => {
    const schema = schemaFor('propose_meal_node');
    const result = schema.safeParse({
      suggestedTitle: 'Dill',
      reservationStatus: 'maybe',
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// propose_transport_node
// ---------------------------------------------------------------------------

describe('propose_transport_node schema', () => {
  it('accepts a valid flight transport between two origins', () => {
    const schema = schemaFor('propose_transport_node');
    const result = schema.safeParse({
      suggestedTitle: 'KEF -> JFK',
      mode: 'flight',
      fromOriginId: 'origin-airport-kef',
      toOriginId: 'origin-airport-jfk',
      departAt: '2026-06-08T10:00:00Z',
      arriveAt: '2026-06-08T13:30:00Z',
      carrier: 'Icelandair',
    });
    expect(result.success).toBe(true);
  });

  it('rejects an unknown mode', () => {
    const schema = schemaFor('propose_transport_node');
    const result = schema.safeParse({
      suggestedTitle: 'rocket',
      mode: 'rocket',
      fromOriginId: 'origin-a',
      toOriginId: 'origin-b',
    });
    expect(result.success).toBe(false);
  });

  it('rejects when fromOriginId is missing', () => {
    const schema = schemaFor('propose_transport_node');
    const result = schema.safeParse({
      suggestedTitle: 'incomplete',
      mode: 'car',
      toOriginId: 'origin-b',
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// propose_day_node
// ---------------------------------------------------------------------------

describe('propose_day_node schema', () => {
  it('accepts a valid input', () => {
    const schema = schemaFor('propose_day_node');
    const result = schema.safeParse({
      date: '2026-06-01',
      title: 'Day 1',
      sortIndex: 0,
    });
    expect(result.success).toBe(true);
  });

  it('rejects a missing date', () => {
    const schema = schemaFor('propose_day_node');
    const result = schema.safeParse({ title: 'Day 1' });
    expect(result.success).toBe(false);
  });
});
