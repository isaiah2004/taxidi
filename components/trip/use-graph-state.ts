'use client';

/**
 * useGraphState — fetches the initial trip graph for a (tripBookId, variantId)
 * pair (unless one is passed in as `initial`) and keeps it in sync with
 * Pusher events on `private-variant-${variantId}`.
 *
 * Strategy: every recognised event triggers a debounced `refetch()` of the
 * full graph. This is simple and correct; it does mean we round-trip on every
 * mutation, but the trip graph is small (tens of nodes) and the round-trip is
 * cheap relative to the realtime hop. Optimistic patches can be layered on
 * later without changing this hook's signature.
 *
 * The hook validates every Pusher payload through `realtimeEventSchema` so an
 * unrecognised event from the wire (or a future schema bump) is silently
 * ignored rather than crashing the page.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getClientPusher,
  realtimeEventSchema,
  variantChannel,
  type RealtimeEvent,
} from '@/lib/realtime';
import type { TripGraph } from '@/lib/graph';

export interface UseGraphStateResult {
  graph: TripGraph | null;
  refetch: () => Promise<void>;
  isLoading: boolean;
  error: Error | null;
}

const REFETCH_DEBOUNCE_MS = 150;

const NODE_EVENT_KINDS = new Set<RealtimeEvent['kind']>([
  'node.add',
  'node.update',
  'node.delete',
  'node.move',
]);

/**
 * Fetch the active graph snapshot from the variant nodes endpoint.
 */
async function fetchGraph(
  tripBookId: string,
  variantId: string,
  signal?: AbortSignal,
): Promise<TripGraph> {
  const res = await fetch(
    `/api/trips/${tripBookId}/variants/${variantId}/nodes`,
    { signal, headers: { Accept: 'application/json' } },
  );
  if (!res.ok) {
    throw new Error(
      `Failed to load graph (${res.status} ${res.statusText})`,
    );
  }
  return (await res.json()) as TripGraph;
}

export function useGraphState(
  tripBookId: string,
  variantId: string,
  initial?: TripGraph,
): UseGraphStateResult {
  const [graph, setGraph] = useState<TripGraph | null>(initial ?? null);
  const [isLoading, setIsLoading] = useState<boolean>(!initial);
  const [error, setError] = useState<Error | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef<boolean>(true);

  // Keep latest IDs in refs so the debounce closure always reads fresh values.
  const idsRef = useRef({ tripBookId, variantId });
  idsRef.current = { tripBookId, variantId };

  const refetch = useCallback(async () => {
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setIsLoading(true);
    try {
      const next = await fetchGraph(
        idsRef.current.tripBookId,
        idsRef.current.variantId,
        controller.signal,
      );
      if (!mountedRef.current || controller.signal.aborted) return;
      setGraph(next);
      setError(null);
    } catch (err) {
      if (controller.signal.aborted) return;
      if (mountedRef.current) {
        setError(err instanceof Error ? err : new Error(String(err)));
      }
    } finally {
      if (mountedRef.current && !controller.signal.aborted) {
        setIsLoading(false);
      }
    }
  }, []);

  // Initial fetch (skipped when SSR seeded `initial`).
  useEffect(() => {
    mountedRef.current = true;
    if (!initial) {
      void refetch();
    }
    return () => {
      mountedRef.current = false;
      if (abortRef.current) abortRef.current.abort();
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // refetch is stable; we only re-run when the (book, variant) pair changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tripBookId, variantId]);

  // Subscribe to Pusher updates for this variant.
  useEffect(() => {
    let pusher: ReturnType<typeof getClientPusher>;
    try {
      pusher = getClientPusher();
    } catch {
      // Pusher not configured in this environment; realtime is disabled but
      // the page still renders the seeded / fetched graph.
      return;
    }

    const channelName = variantChannel(variantId);
    const channel = pusher.subscribe(channelName);

    const scheduleRefetch = () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        void refetch();
      }, REFETCH_DEBOUNCE_MS);
    };

    const handler = (kind: RealtimeEvent['kind']) =>
      (raw: unknown) => {
        const parsed = realtimeEventSchema.safeParse({
          ...(typeof raw === 'object' && raw !== null ? raw : {}),
          kind,
        });
        if (!parsed.success) return;
        if (NODE_EVENT_KINDS.has(parsed.data.kind)) {
          scheduleRefetch();
        }
      };

    const handlers: Record<string, (raw: unknown) => void> = {
      'node.add': handler('node.add'),
      'node.update': handler('node.update'),
      'node.delete': handler('node.delete'),
      'node.move': handler('node.move'),
    };

    for (const [event, fn] of Object.entries(handlers)) {
      channel.bind(event, fn);
    }

    return () => {
      for (const [event, fn] of Object.entries(handlers)) {
        channel.unbind(event, fn);
      }
      pusher.unsubscribe(channelName);
    };
  }, [variantId, refetch]);

  return { graph, refetch, isLoading, error };
}
