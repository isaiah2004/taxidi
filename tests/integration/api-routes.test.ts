/**
 * Integration tests for the trip-book HTTP surface.
 *
 * SKIPPED BY DEFAULT. These tests hit a running Next.js dev server and a real
 * Postgres (Cloud SQL via the Auth Proxy). They round-trip:
 *
 *   POST /api/trips                                   -> create a trip book
 *   GET  /api/trips                                   -> see it in `owned`
 *   GET  /api/trips/{id}                              -> hydrated detail
 *   POST /api/trips/{id}/variants/mine/nodes          -> add a destination
 *   GET  /api/trips/{id}/variants/{variantId}/nodes   -> see the new vertex
 *
 * To enable, in one terminal start the dev server with the Cloud SQL Auth
 * Proxy bridging localhost:5432 to the dev Cloud SQL instance:
 *
 *   pnpm dev
 *
 * Then in another terminal run the suite with the env flag set, plus a
 * Clerk testing token (a `Authorization: Bearer ...` value the dev server
 * accepts — same flow as `tests/integration/clerk-helpers.test.ts`):
 *
 *   $env:INTEGRATION = '1'
 *   $env:INTEGRATION_BASE_URL = 'http://localhost:3000'
 *   $env:INTEGRATION_AUTH_TOKEN = '<clerk testing token>'
 *   pnpm test:run
 *
 * The suite uses `describe.skipIf` so it stays discoverable in the runner's
 * tree view without erroring out on local laptops.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const integrationEnabled = Boolean(process.env.INTEGRATION);
const baseUrl = process.env.INTEGRATION_BASE_URL ?? 'http://localhost:3000';
const authToken = process.env.INTEGRATION_AUTH_TOKEN ?? '';

interface CreatedTrip {
  id: string;
  name: string;
}

interface NodeCreated {
  originId: string;
  id: string;
  version: number;
}

interface VariantGraph {
  vertices: Array<{ originId: string; type: string; title: string }>;
  edges: Array<unknown>;
  days: Array<unknown>;
  tripOriginId: string | null;
}

function authHeaders(): Record<string, string> {
  if (!authToken) return {};
  return { Authorization: `Bearer ${authToken}` };
}

describe.skipIf(!integrationEnabled)('trip-book API (integration)', () => {
  let trip: CreatedTrip | null = null;

  beforeAll(() => {
    if (!authToken) {
      throw new Error(
        'INTEGRATION_AUTH_TOKEN must be set when INTEGRATION=1. ' +
          'Use the Clerk testing token flow described in tests/integration/clerk-helpers.test.ts.',
      );
    }
  });

  afterAll(() => {
    // Intentionally NOT cleaning up the trip — this lets you inspect the row
    // afterwards. If you want it gone, run `DELETE FROM trip_book WHERE id =
    // '<id>'` against the dev DB. Tests that need a clean slate should
    // namespace by timestamp anyway.
  });

  it('POST /api/trips creates a trip book', async () => {
    const name = `Integration trip ${new Date().toISOString()}`;
    const res = await fetch(`${baseUrl}/api/trips`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ name }),
    });
    expect(res.status).toBe(201);

    const body = (await res.json()) as CreatedTrip;
    expect(body.id).toBeTypeOf('string');
    expect(body.name).toBe(name);
    trip = body;
  });

  it('GET /api/trips returns the new trip in `owned`', async () => {
    if (!trip) throw new Error('previous test must have populated trip');
    const res = await fetch(`${baseUrl}/api/trips`, {
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { owned: Array<{ id: string }> };
    const ids = body.owned.map((t) => t.id);
    expect(ids).toContain(trip.id);
  });

  it('GET /api/trips/{id} returns hydrated detail', async () => {
    if (!trip) throw new Error('previous test must have populated trip');
    const res = await fetch(`${baseUrl}/api/trips/${trip.id}`, {
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string };
    expect(body.id).toBe(trip.id);
  });

  it('POST /api/trips/{id}/variants/mine/nodes inserts a destination', async () => {
    if (!trip) throw new Error('previous test must have populated trip');
    const res = await fetch(
      `${baseUrl}/api/trips/${trip.id}/variants/mine/nodes`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({
          type: 'destination',
          title: 'Reykjavik',
          notes: null,
          location: {
            placeId: 'p-reykjavik',
            lat: 64.13,
            lng: -21.93,
            address: 'Reykjavik, Iceland',
          },
        }),
      },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as NodeCreated;
    expect(body.originId).toBeTypeOf('string');
  });

  it('GET .../variants/mine/nodes returns the inserted vertex', async () => {
    if (!trip) throw new Error('previous test must have populated trip');
    const res = await fetch(
      `${baseUrl}/api/trips/${trip.id}/variants/mine/nodes`,
      { headers: authHeaders() },
    );
    expect(res.status).toBe(200);
    const graph = (await res.json()) as VariantGraph;
    const titles = graph.vertices.map((v) => v.title);
    expect(titles).toContain('Reykjavik');

    // Verify the cache headers we set in the handler. The browser should be
    // told to revalidate every load.
    expect(res.headers.get('cache-control')?.toLowerCase()).toContain(
      'must-revalidate',
    );
  });
});
