import { describe, expect, it } from 'vitest';
import { z } from 'zod';

/**
 * Placeholder for the future `lib/diff.ts` module.
 *
 * Once `lib/diff.ts` exists, replace the skipped test below with a real suite
 * covering the four diff operation kinds keyed by `origin_id`:
 *
 *   - ADD:    item present in `next` but not in `prev`
 *   - UPDATE: item present in both, with at least one field changed
 *   - DELETE: item present in `prev` but not in `next`
 *   - MOVE:   item present in both with the same fields, but a different
 *             parent / position (i.e. ordering or container changed)
 *
 * Tests should also cover:
 *   - stable ordering of operations (DELETE before MOVE before UPDATE before ADD,
 *     or whatever order the diff applier expects)
 *   - no-op when `prev` and `next` are deeply equal
 *   - items missing `origin_id` are treated as ADD/DELETE pairs, never UPDATE
 */
describe('lib/diff', () => {
  it.skip('TODO: diff(prev, next) emits ADD/UPDATE/DELETE/MOVE keyed by origin_id', () => {
    // intentionally empty until lib/diff.ts lands
  });
});

/**
 * Shape tests — exercise the runner before `lib/diff.ts` exists. These define
 * the fixture / wire shape that the future diff module will operate on so the
 * eventual implementation has a contract to target.
 */
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
    const result = VariantSnapshot.safeParse({ ...sampleSnapshot, origin_id: 'not-a-uuid' });
    expect(result.success).toBe(false);
  });

  it('allows parent_id to be null for top-level nodes', () => {
    const parsed = VariantSnapshot.parse(sampleSnapshot);
    expect(parsed.parent_id).toBeNull();
  });
});
