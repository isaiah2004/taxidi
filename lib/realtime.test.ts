/**
 * Unit tests for `lib/realtime.ts`.
 *
 * Two concerns:
 *   1. The Zod `realtimeEventSchema` rejects unknown event kinds and accepts
 *      every documented one. This is the type-safety check that producers and
 *      consumers can rely on the inferred `RealtimeEvent` union.
 *   2. `broadcastToTripBook` builds the correct channel name and forwards the
 *      event/payload. We swap the server Pusher singleton via the
 *      `__setServerPusherForTesting` seam so we don't have to mock the
 *      constructor or reach into internals.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  __setServerPusherForTesting,
  broadcastToTripBook,
  broadcastToVariant,
  realtimeEventSchema,
  tripBookChannel,
  variantChannel,
  type RealtimeEvent,
} from './realtime';

afterEach(() => {
  __setServerPusherForTesting(null);
});

describe('realtimeEventSchema', () => {
  it('rejects unknown event kinds', () => {
    const result = realtimeEventSchema.safeParse({
      kind: 'totally.made.up',
      foo: 'bar',
    });
    expect(result.success).toBe(false);
  });

  it('rejects known kinds with malformed payloads', () => {
    const result = realtimeEventSchema.safeParse({
      kind: 'node.update',
      // missing variantId, originId, patch, version
    });
    expect(result.success).toBe(false);
  });

  it('accepts each documented event kind', () => {
    const cases: RealtimeEvent[] = [
      {
        kind: 'chat.message',
        messageId: 'm1',
        tripBookId: 'tb1',
        userId: 'u1',
        role: 'user',
        content: 'hi',
        createdAt: new Date().toISOString(),
      },
      {
        kind: 'node.add',
        variantId: 'v1',
        nodeId: 'n1',
        originId: 'o1',
        parentOriginId: null,
      },
      {
        kind: 'node.update',
        variantId: 'v1',
        originId: 'o1',
        patch: { title: 'New title' },
        version: 2,
      },
      {
        kind: 'node.delete',
        variantId: 'v1',
        originId: 'o1',
      },
      {
        kind: 'node.move',
        variantId: 'v1',
        originId: 'o1',
        newParentOriginId: 'p1',
        newSortIndex: 3,
      },
      {
        kind: 'merge.proposal.created',
        tripBookId: 'tb1',
        proposalId: 'p1',
        variantId: 'v1',
        proposedByUserId: 'u1',
      },
      {
        kind: 'merge.committed',
        tripBookId: 'tb1',
        mainVersionId: 'mv1',
        proposalId: 'p1',
      },
    ];

    for (const event of cases) {
      const result = realtimeEventSchema.safeParse(event);
      expect(result.success, `expected ${event.kind} to parse`).toBe(true);
    }
  });
});

describe('channel name helpers', () => {
  it('builds the correct trip-book channel name', () => {
    expect(tripBookChannel('abc-123')).toBe('private-trip-book-abc-123');
  });

  it('builds the correct variant channel name', () => {
    expect(variantChannel('xyz-789')).toBe('private-variant-xyz-789');
  });
});

describe('broadcastToTripBook', () => {
  it('triggers on the correct channel and forwards event + payload', async () => {
    const trigger = vi.fn().mockResolvedValue({ ok: true });
    // Cast through `unknown` because we only need a stub that satisfies the
    // narrow surface `broadcastToTripBook` actually calls.
    __setServerPusherForTesting({
      trigger,
    } as unknown as Parameters<typeof __setServerPusherForTesting>[0]);

    const payload = { hello: 'world' };
    await broadcastToTripBook('book-1', 'node.add', payload);

    expect(trigger).toHaveBeenCalledTimes(1);
    expect(trigger).toHaveBeenCalledWith(
      'private-trip-book-book-1',
      'node.add',
      payload,
    );
  });

  it('triggers on the correct variant channel for broadcastToVariant', async () => {
    const trigger = vi.fn().mockResolvedValue({ ok: true });
    __setServerPusherForTesting({
      trigger,
    } as unknown as Parameters<typeof __setServerPusherForTesting>[0]);

    await broadcastToVariant('var-7', 'node.update', { v: 2 });

    expect(trigger).toHaveBeenCalledWith(
      'private-variant-var-7',
      'node.update',
      { v: 2 },
    );
  });
});
