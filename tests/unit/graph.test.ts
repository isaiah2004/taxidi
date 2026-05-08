/**
 * Pure-projection tests for `lib/graph.ts`. These exercise `snapshotToGraph`
 * end-to-end against a small but realistic fixture: a Trip with two Days,
 * three places (one lodging, one activity, one meal), and two transport rows
 * connecting the places. We don't touch the DB-backed loaders here — they're
 * thin wrappers around the pure helpers.
 */
import { describe, expect, it } from 'vitest';

import type { SerializedSnapshot } from '@/lib/graph';
import { snapshotToGraph } from '@/lib/graph';

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const TRIP = 'origin-trip';
const DAY_1 = 'origin-day-1';
const DAY_2 = 'origin-day-2';
const PLACE_HOTEL = 'origin-hotel';
const PLACE_ACTIVITY = 'origin-activity';
const PLACE_MEAL = 'origin-meal';
const TRANSPORT_1 = 'origin-transport-1';
const TRANSPORT_2 = 'origin-transport-2';

function buildFixture(): SerializedSnapshot {
  return {
    nodes: [
      {
        originId: TRIP,
        type: 'trip',
        parentOriginId: null,
        sortIndex: 0,
        title: 'Iceland adventure',
        notes: null,
        startAt: '2026-06-01T00:00:00.000Z',
        endAt: '2026-06-08T00:00:00.000Z',
        location: null,
        typeData: {},
        version: 1,
      },
      {
        originId: DAY_1,
        type: 'day',
        parentOriginId: TRIP,
        sortIndex: 0,
        title: 'Day 1',
        notes: null,
        startAt: '2026-06-01T00:00:00.000Z',
        endAt: null,
        location: null,
        typeData: { date: '2026-06-01' },
        version: 1,
      },
      {
        originId: DAY_2,
        type: 'day',
        parentOriginId: TRIP,
        sortIndex: 1,
        title: 'Day 2',
        notes: null,
        startAt: '2026-06-02T00:00:00.000Z',
        endAt: null,
        location: null,
        typeData: { date: '2026-06-02' },
        version: 1,
      },
      {
        originId: PLACE_HOTEL,
        type: 'lodging',
        parentOriginId: DAY_1,
        sortIndex: 0,
        title: 'Hotel Reykjavik',
        notes: null,
        startAt: '2026-06-01T16:00:00.000Z',
        endAt: '2026-06-02T11:00:00.000Z',
        location: {
          placeId: 'p-hotel',
          lat: 64.13,
          lng: -21.93,
          address: 'Reykjavik, Iceland',
        },
        typeData: { check_in: '16:00', check_out: '11:00' },
        version: 1,
      },
      {
        originId: PLACE_ACTIVITY,
        type: 'activity',
        parentOriginId: DAY_2,
        sortIndex: 0,
        title: 'Blue Lagoon',
        notes: null,
        startAt: '2026-06-02T10:00:00.000Z',
        endAt: '2026-06-02T13:00:00.000Z',
        location: {
          placeId: 'p-blue-lagoon',
          lat: 63.88,
          lng: -22.45,
          address: 'Grindavík, Iceland',
        },
        typeData: {},
        version: 1,
      },
      {
        originId: PLACE_MEAL,
        type: 'meal',
        parentOriginId: DAY_2,
        sortIndex: 1,
        title: 'Dinner at Dill',
        notes: null,
        startAt: '2026-06-02T19:30:00.000Z',
        endAt: null,
        location: {
          placeId: 'p-dill',
          lat: 64.146,
          lng: -21.94,
          address: 'Reykjavik, Iceland',
        },
        typeData: {},
        version: 1,
      },
      {
        originId: TRANSPORT_1,
        type: 'transport',
        parentOriginId: TRIP,
        sortIndex: 10,
        title: 'Hotel to Blue Lagoon',
        notes: 'Rental car',
        startAt: '2026-06-02T09:00:00.000Z',
        endAt: '2026-06-02T10:00:00.000Z',
        location: null,
        typeData: {
          from_origin_id: PLACE_HOTEL,
          to_origin_id: PLACE_ACTIVITY,
          mode: 'car',
        },
        version: 1,
      },
      {
        originId: TRANSPORT_2,
        type: 'transport',
        parentOriginId: TRIP,
        sortIndex: 11,
        title: 'Blue Lagoon to Dill',
        notes: null,
        startAt: '2026-06-02T18:30:00.000Z',
        endAt: '2026-06-02T19:30:00.000Z',
        location: null,
        typeData: {
          from_origin_id: PLACE_ACTIVITY,
          to_origin_id: PLACE_MEAL,
          mode: 'car',
        },
        version: 1,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('snapshotToGraph', () => {
  it('extracts 3 vertices, 2 edges, 2 days, and the trip root', () => {
    const graph = snapshotToGraph(buildFixture());

    expect(graph.vertices).toHaveLength(3);
    expect(graph.edges).toHaveLength(2);
    expect(graph.days).toHaveLength(2);
    expect(graph.tripOriginId).toBe(TRIP);
  });

  it('attributes each vertex to its parent day via dayOriginId', () => {
    const graph = snapshotToGraph(buildFixture());
    const byOrigin = new Map(graph.vertices.map((v) => [v.originId, v]));

    expect(byOrigin.get(PLACE_HOTEL)?.dayOriginId).toBe(DAY_1);
    expect(byOrigin.get(PLACE_ACTIVITY)?.dayOriginId).toBe(DAY_2);
    expect(byOrigin.get(PLACE_MEAL)?.dayOriginId).toBe(DAY_2);
  });

  it('projects transport rows as edges with from/to originIds', () => {
    const graph = snapshotToGraph(buildFixture());
    const byOrigin = new Map(graph.edges.map((e) => [e.originId, e]));

    const t1 = byOrigin.get(TRANSPORT_1);
    expect(t1).toBeDefined();
    expect(t1?.sourceOriginId).toBe(PLACE_HOTEL);
    expect(t1?.targetOriginId).toBe(PLACE_ACTIVITY);
    expect(t1?.mode).toBe('car');

    const t2 = byOrigin.get(TRANSPORT_2);
    expect(t2).toBeDefined();
    expect(t2?.sourceOriginId).toBe(PLACE_ACTIVITY);
    expect(t2?.targetOriginId).toBe(PLACE_MEAL);
  });

  it('preserves day metadata: title, sortIndex, and date', () => {
    const graph = snapshotToGraph(buildFixture());
    const byOrigin = new Map(graph.days.map((d) => [d.originId, d]));

    const d1 = byOrigin.get(DAY_1);
    expect(d1).toBeDefined();
    expect(d1?.title).toBe('Day 1');
    expect(d1?.sortIndex).toBe(0);
    expect(d1?.date).toBe('2026-06-01');

    const d2 = byOrigin.get(DAY_2);
    expect(d2?.sortIndex).toBe(1);
    expect(d2?.date).toBe('2026-06-02');
  });

  it('returns an empty graph for an empty snapshot', () => {
    const graph = snapshotToGraph({ nodes: [] });
    expect(graph.vertices).toEqual([]);
    expect(graph.edges).toEqual([]);
    expect(graph.days).toEqual([]);
    expect(graph.tripOriginId).toBeNull();
  });

  it('drops transport rows that lack from/to ids', () => {
    const snapshot: SerializedSnapshot = {
      nodes: [
        {
          originId: 'broken-transport',
          type: 'transport',
          parentOriginId: null,
          sortIndex: 0,
          title: 'broken',
          notes: null,
          startAt: null,
          endAt: null,
          location: null,
          typeData: { mode: 'car' },
          version: 1,
        },
      ],
    };
    const graph = snapshotToGraph(snapshot);
    expect(graph.edges).toHaveLength(0);
  });
});
