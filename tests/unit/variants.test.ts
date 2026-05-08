/**
 * Unit tests for the pure helpers in `lib/variants.ts`.
 *
 * `_materializePure` is the core transform: given a `SerializedSnapshot` and a
 * target variantId, produce node rows ready to insert with `parentNodeId`
 * pointers correctly translated from `parentOriginId`. Everything else in
 * `getOrCreateVariantForUser` is plumbing around DB transactions, which we
 * leave to integration tests rather than mocking the Drizzle surface.
 */
import { describe, expect, it } from 'vitest';

import type { SerializedSnapshot } from '@/lib/graph';
import { _materializePure } from '@/lib/variants';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('_materializePure', () => {
  it('returns an empty array for an empty snapshot', () => {
    const rows = _materializePure({ nodes: [] }, 'variant-1');
    expect(rows).toEqual([]);
  });

  it('mints a fresh nodeId per row while preserving originId', () => {
    const snapshot: SerializedSnapshot = {
      nodes: [
        {
          originId: 'a',
          type: 'destination',
          parentOriginId: null,
          sortIndex: 0,
          title: 'A',
          notes: null,
          startAt: null,
          endAt: null,
          location: null,
          typeData: {},
          version: 1,
        },
        {
          originId: 'b',
          type: 'destination',
          parentOriginId: null,
          sortIndex: 1,
          title: 'B',
          notes: null,
          startAt: null,
          endAt: null,
          location: null,
          typeData: {},
          version: 1,
        },
      ],
    };
    const rows = _materializePure(snapshot, 'variant-1');
    expect(rows).toHaveLength(2);
    expect(rows[0].id).not.toEqual(rows[1].id);
    expect(rows[0].originId).toBe('a');
    expect(rows[1].originId).toBe('b');
    // Both rows should be tagged with the target variantId.
    expect(rows.every((r) => r.variantId === 'variant-1')).toBe(true);
  });

  it('rewires parentOriginId references to the freshly-minted nodeId', () => {
    const snapshot: SerializedSnapshot = {
      nodes: [
        {
          originId: 'parent',
          type: 'day',
          parentOriginId: null,
          sortIndex: 0,
          title: 'Day 1',
          notes: null,
          startAt: null,
          endAt: null,
          location: null,
          typeData: {},
          version: 1,
        },
        {
          originId: 'child',
          type: 'destination',
          parentOriginId: 'parent',
          sortIndex: 0,
          title: 'Reykjavik',
          notes: null,
          startAt: null,
          endAt: null,
          location: null,
          typeData: {},
          version: 1,
        },
      ],
    };
    const rows = _materializePure(snapshot, 'variant-1');
    const parent = rows.find((r) => r.originId === 'parent');
    const child = rows.find((r) => r.originId === 'child');
    expect(parent).toBeDefined();
    expect(child).toBeDefined();
    expect(child?.parentNodeId).toBe(parent?.id);
    expect(parent?.parentNodeId).toBeNull();
  });

  it('handles forward references (child appears before parent in input)', () => {
    const snapshot: SerializedSnapshot = {
      nodes: [
        // Child first
        {
          originId: 'child',
          type: 'destination',
          parentOriginId: 'parent',
          sortIndex: 0,
          title: 'Child',
          notes: null,
          startAt: null,
          endAt: null,
          location: null,
          typeData: {},
          version: 1,
        },
        {
          originId: 'parent',
          type: 'day',
          parentOriginId: null,
          sortIndex: 0,
          title: 'Parent',
          notes: null,
          startAt: null,
          endAt: null,
          location: null,
          typeData: {},
          version: 1,
        },
      ],
    };
    const rows = _materializePure(snapshot, 'variant-1');
    const child = rows.find((r) => r.originId === 'child');
    const parent = rows.find((r) => r.originId === 'parent');
    expect(child?.parentNodeId).toBe(parent?.id);
  });

  it('parses ISO strings into Date instances for startAt/endAt', () => {
    const snapshot: SerializedSnapshot = {
      nodes: [
        {
          originId: 'a',
          type: 'activity',
          parentOriginId: null,
          sortIndex: 0,
          title: 'Hike',
          notes: null,
          startAt: '2026-06-02T10:00:00.000Z',
          endAt: '2026-06-02T13:00:00.000Z',
          location: null,
          typeData: {},
          version: 1,
        },
      ],
    };
    const rows = _materializePure(snapshot, 'variant-1');
    expect(rows[0].startAt).toBeInstanceOf(Date);
    expect(rows[0].endAt).toBeInstanceOf(Date);
    expect(rows[0].startAt?.toISOString()).toBe('2026-06-02T10:00:00.000Z');
  });

  it('flattens GraphLocation into the four location columns', () => {
    const snapshot: SerializedSnapshot = {
      nodes: [
        {
          originId: 'a',
          type: 'destination',
          parentOriginId: null,
          sortIndex: 0,
          title: 'Reykjavik',
          notes: null,
          startAt: null,
          endAt: null,
          location: {
            placeId: 'p-1',
            lat: 64.13,
            lng: -21.93,
            address: 'Reykjavik, Iceland',
          },
          typeData: {},
          version: 1,
        },
      ],
    };
    const rows = _materializePure(snapshot, 'variant-1');
    expect(rows[0].locationPlaceId).toBe('p-1');
    expect(rows[0].locationLat).toBe(64.13);
    expect(rows[0].locationLng).toBe(-21.93);
    expect(rows[0].locationAddress).toBe('Reykjavik, Iceland');
  });

  it('leaves all four location columns null when location is null', () => {
    const snapshot: SerializedSnapshot = {
      nodes: [
        {
          originId: 'a',
          type: 'note',
          parentOriginId: null,
          sortIndex: 0,
          title: 'Reminder',
          notes: null,
          startAt: null,
          endAt: null,
          location: null,
          typeData: {},
          version: 1,
        },
      ],
    };
    const rows = _materializePure(snapshot, 'variant-1');
    expect(rows[0].locationPlaceId).toBeNull();
    expect(rows[0].locationLat).toBeNull();
    expect(rows[0].locationLng).toBeNull();
    expect(rows[0].locationAddress).toBeNull();
  });
});
