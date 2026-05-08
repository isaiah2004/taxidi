/**
 * Unit tests for `lib/diff.ts`.
 *
 * The four diff op kinds keyed by `origin_id`:
 *   - ADD:    item present in `next` but not in `prev`
 *   - UPDATE: item present in both, with at least one non-position field changed
 *   - DELETE: item present in `prev` but not in `next`
 *   - MOVE:   parent or sortIndex changed (parent fields excluded from UPDATE)
 *
 * Plus the cross-cutting properties:
 *   - applyDiff(prev, diff(prev, next)) deep-equals next for any pair
 *   - no-op snapshots produce zero ops
 *   - origin-id-less items become ADD/DELETE pairs, never UPDATE
 *   - update + move on the same node emits both ops
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { applyDiff, diff, type DiffOp } from '@/lib/diff';
import type { SerializedNode, SerializedSnapshot } from '@/lib/graph';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeNode(overrides: Partial<SerializedNode> = {}): SerializedNode {
  return {
    originId: 'origin-1',
    type: 'destination',
    parentOriginId: null,
    sortIndex: 0,
    title: 'Reykjavik',
    notes: null,
    startAt: null,
    endAt: null,
    location: null,
    typeData: {},
    version: 1,
    ...overrides,
  };
}

function snap(...nodes: SerializedNode[]): SerializedSnapshot {
  return { nodes };
}

// ---------------------------------------------------------------------------
// Op kind tests
// ---------------------------------------------------------------------------

describe('diff: ADD', () => {
  it('emits an ADD op for nodes only present in next', () => {
    const prev = snap();
    const next = snap(makeNode({ originId: 'a', title: 'A' }));
    const result = diff(prev, next);
    expect(result.ops).toHaveLength(1);
    expect(result.ops[0]).toEqual({
      kind: 'add',
      originId: 'a',
      payload: expect.objectContaining({ originId: 'a', title: 'A' }),
    });
  });
});

describe('diff: DELETE', () => {
  it('emits a DELETE op for nodes only present in prev', () => {
    const prev = snap(makeNode({ originId: 'a', title: 'A' }));
    const next = snap();
    const result = diff(prev, next);
    expect(result.ops).toHaveLength(1);
    expect(result.ops[0]).toEqual({ kind: 'delete', originId: 'a' });
  });
});

describe('diff: UPDATE', () => {
  it('emits an UPDATE op when only non-position fields change', () => {
    const prev = snap(makeNode({ originId: 'a', title: 'Reykjavik' }));
    const next = snap(makeNode({ originId: 'a', title: 'Reykjavík' }));
    const result = diff(prev, next);
    expect(result.ops).toHaveLength(1);
    expect(result.ops[0]).toEqual({
      kind: 'update',
      originId: 'a',
      patch: { title: 'Reykjavík' },
    });
  });

  it('only includes changed fields in the patch', () => {
    const prev = snap(
      makeNode({
        originId: 'a',
        title: 'A',
        notes: 'old',
        version: 1,
      }),
    );
    const next = snap(
      makeNode({
        originId: 'a',
        title: 'A',
        notes: 'new',
        version: 2,
      }),
    );
    const result = diff(prev, next);
    expect(result.ops).toHaveLength(1);
    const op = result.ops[0] as Extract<DiffOp, { kind: 'update' }>;
    expect(op.patch).toEqual({ notes: 'new', version: 2 });
    // title should NOT be in the patch since it didn't change
    expect(Object.keys(op.patch)).not.toContain('title');
  });
});

describe('diff: MOVE', () => {
  it('emits a MOVE op when parent changes', () => {
    const prev = snap(makeNode({ originId: 'a', parentOriginId: 'p1' }));
    const next = snap(makeNode({ originId: 'a', parentOriginId: 'p2' }));
    const result = diff(prev, next);
    expect(result.ops).toHaveLength(1);
    expect(result.ops[0]).toEqual({
      kind: 'move',
      originId: 'a',
      newParentOriginId: 'p2',
      newSortIndex: 0,
    });
  });

  it('emits a MOVE op when only sortIndex changes', () => {
    const prev = snap(makeNode({ originId: 'a', sortIndex: 1 }));
    const next = snap(makeNode({ originId: 'a', sortIndex: 5 }));
    const result = diff(prev, next);
    expect(result.ops).toHaveLength(1);
    expect(result.ops[0]).toEqual({
      kind: 'move',
      originId: 'a',
      newParentOriginId: null,
      newSortIndex: 5,
    });
  });
});

describe('diff: MOVE + UPDATE on same node', () => {
  it('emits both a MOVE and an UPDATE when title and parent change', () => {
    const prev = snap(
      makeNode({
        originId: 'a',
        parentOriginId: 'p1',
        sortIndex: 0,
        title: 'Old',
      }),
    );
    const next = snap(
      makeNode({
        originId: 'a',
        parentOriginId: 'p2',
        sortIndex: 3,
        title: 'New',
      }),
    );
    const result = diff(prev, next);
    expect(result.ops).toHaveLength(2);

    const move = result.ops.find((op) => op.kind === 'move');
    const update = result.ops.find((op) => op.kind === 'update');
    expect(move).toEqual({
      kind: 'move',
      originId: 'a',
      newParentOriginId: 'p2',
      newSortIndex: 3,
    });
    expect(update).toEqual({
      kind: 'update',
      originId: 'a',
      patch: { title: 'New' },
    });
  });
});

describe('diff: no-op', () => {
  it('emits zero ops for deeply-equal snapshots', () => {
    const a = snap(
      makeNode({ originId: 'x', title: 'X', typeData: { foo: 'bar' } }),
      makeNode({
        originId: 'y',
        title: 'Y',
        sortIndex: 1,
        typeData: { nested: { ok: true } },
      }),
    );
    const b = snap(
      makeNode({ originId: 'x', title: 'X', typeData: { foo: 'bar' } }),
      makeNode({
        originId: 'y',
        title: 'Y',
        sortIndex: 1,
        typeData: { nested: { ok: true } },
      }),
    );
    expect(diff(a, b).ops).toHaveLength(0);
  });
});

describe('diff: origin-id-less items', () => {
  it('treats originless items as ADD/DELETE, not UPDATE', () => {
    const prev = snap(makeNode({ originId: '', title: 'Old' }));
    const next = snap(makeNode({ originId: '', title: 'New' }));
    const result = diff(prev, next);
    // Even though they share originId="" and look "the same" key, we never
    // match them — they should produce a delete and an add.
    const kinds = result.ops.map((o) => o.kind).sort();
    expect(kinds).toEqual(['add', 'delete']);
  });
});

// ---------------------------------------------------------------------------
// Order convention
// ---------------------------------------------------------------------------

describe('diff: op ordering', () => {
  it('emits deletes before moves before updates before adds', () => {
    const prev = snap(
      makeNode({ originId: 'd', title: 'gone' }),
      makeNode({ originId: 'm', sortIndex: 0, parentOriginId: 'p1' }),
      makeNode({ originId: 'u', title: 'old' }),
    );
    const next = snap(
      makeNode({ originId: 'm', sortIndex: 5, parentOriginId: 'p2' }),
      makeNode({ originId: 'u', title: 'new' }),
      makeNode({ originId: 'a', title: 'fresh' }),
    );
    const result = diff(prev, next);
    const kinds = result.ops.map((op) => op.kind);
    // The exact length depends on which fields differ; all four kinds should
    // appear at least once and in the documented order.
    const firstDelete = kinds.indexOf('delete');
    const firstMove = kinds.indexOf('move');
    const firstUpdate = kinds.indexOf('update');
    const firstAdd = kinds.indexOf('add');
    expect(firstDelete).toBeGreaterThanOrEqual(0);
    expect(firstMove).toBeGreaterThan(firstDelete);
    expect(firstUpdate).toBeGreaterThan(firstMove);
    expect(firstAdd).toBeGreaterThan(firstUpdate);
  });
});

// ---------------------------------------------------------------------------
// Round-trip property: applyDiff(prev, diff(prev, next)) deep-equals next
// ---------------------------------------------------------------------------

describe('applyDiff round-trip', () => {
  const cases: Array<{ name: string; prev: SerializedSnapshot; next: SerializedSnapshot }> = [
    {
      name: 'add only',
      prev: snap(),
      next: snap(makeNode({ originId: 'a' })),
    },
    {
      name: 'delete only',
      prev: snap(makeNode({ originId: 'a' })),
      next: snap(),
    },
    {
      name: 'update only',
      prev: snap(makeNode({ originId: 'a', title: 'Old' })),
      next: snap(makeNode({ originId: 'a', title: 'New' })),
    },
    {
      name: 'move only',
      prev: snap(makeNode({ originId: 'a', sortIndex: 0 })),
      next: snap(makeNode({ originId: 'a', sortIndex: 7 })),
    },
    {
      name: 'update + move on same node',
      prev: snap(
        makeNode({
          originId: 'a',
          title: 'Old',
          parentOriginId: 'p1',
          sortIndex: 0,
        }),
      ),
      next: snap(
        makeNode({
          originId: 'a',
          title: 'New',
          parentOriginId: 'p2',
          sortIndex: 3,
        }),
      ),
    },
    {
      name: 'mixed delete + move + update + add',
      prev: snap(
        makeNode({ originId: 'd', title: 'gone' }),
        makeNode({ originId: 'm', parentOriginId: 'p1', sortIndex: 0 }),
        makeNode({ originId: 'u', title: 'old' }),
      ),
      next: snap(
        makeNode({ originId: 'm', parentOriginId: 'p2', sortIndex: 5 }),
        makeNode({ originId: 'u', title: 'new' }),
        makeNode({ originId: 'a', title: 'fresh' }),
      ),
    },
  ];

  for (const c of cases) {
    it(`round-trips for ${c.name}`, () => {
      const result = applyDiff(c.prev, diff(c.prev, c.next));
      // Sort by originId so we don't depend on order of trailing-add insertion.
      const sortByOrigin = (s: SerializedSnapshot) =>
        [...s.nodes].sort((a, b) => a.originId.localeCompare(b.originId));
      expect(sortByOrigin(result)).toEqual(sortByOrigin(c.next));
    });
  }
});

// ---------------------------------------------------------------------------
// Shape tests carried over from the placeholder file (kept to ensure the test
// runner exercises Zod fixtures we declared on the original wire shape).
// ---------------------------------------------------------------------------

const VariantSnapshot = z.object({
  origin_id: z.string().uuid(),
  trip_id: z.string().uuid(),
  parent_id: z.string().uuid().nullable(),
  position: z.number().int().nonnegative(),
  payload: z.record(z.string(), z.unknown()),
});

type VariantSnapshot = z.infer<typeof VariantSnapshot>;

const sampleSnapshot: VariantSnapshot = {
  origin_id: '11111111-1111-4111-8111-111111111111',
  trip_id: '22222222-2222-4222-8222-222222222222',
  parent_id: null,
  position: 0,
  payload: { kind: 'leg', title: 'Reykjavik to Vik' },
};

describe('VariantSnapshot fixture shape', () => {
  it('accepts a well-formed snapshot', () => {
    const result = VariantSnapshot.safeParse(sampleSnapshot);
    expect(result.success).toBe(true);
  });

  it('rejects a snapshot with a non-uuid origin_id', () => {
    const result = VariantSnapshot.safeParse({
      ...sampleSnapshot,
      origin_id: 'not-a-uuid',
    });
    expect(result.success).toBe(false);
  });

  it('allows parent_id to be null for top-level nodes', () => {
    const parsed = VariantSnapshot.parse(sampleSnapshot);
    expect(parsed.parent_id).toBeNull();
  });
});
