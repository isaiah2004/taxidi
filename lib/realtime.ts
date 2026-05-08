/**
 * Pusher Channels server + client helpers.
 *
 * Server side:
 *   - `getServerPusher()` returns a lazily-initialized `Pusher` singleton driven
 *     by `PUSHER_APP_ID`, `PUSHER_KEY`, `PUSHER_SECRET`, `PUSHER_CLUSTER`.
 *   - `broadcastToTripBook(id, event, payload)` -> `private-trip-book-${id}`
 *   - `broadcastToVariant(id, event, payload)`   -> `private-variant-${id}`
 *
 * Client side:
 *   - `getClientPusher()` returns a lazily-initialized `pusher-js` singleton
 *     driven by `NEXT_PUBLIC_PUSHER_KEY` and `NEXT_PUBLIC_PUSHER_CLUSTER`.
 *
 * IMPORTANT: `getClientPusher` reads `NEXT_PUBLIC_*` env vars and connects a
 * websocket — it must only be imported from client components / browser code.
 * Importing it from a server module won't crash, but it will create a useless
 * connection on the server. Prefer dynamic-importing it from `'use client'`
 * components.
 *
 * Realtime event payloads are described as a Zod-discriminated union, so the
 * Zod schema is the source of truth and the TypeScript types are inferred from
 * it — there's no parallel hand-maintained `type` definition.
 */
import PusherServer from 'pusher';
import PusherClient from 'pusher-js';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Channel name helpers
// ---------------------------------------------------------------------------

/** Build the private channel name for a trip-book. */
export function tripBookChannel(tripBookId: string): string {
  return `private-trip-book-${tripBookId}`;
}

/** Build the private channel name for a variant. */
export function variantChannel(variantId: string): string {
  return `private-variant-${variantId}`;
}

// ---------------------------------------------------------------------------
// Realtime event schema
// ---------------------------------------------------------------------------

/**
 * Discriminated union of all realtime events broadcast over Pusher channels.
 * Add a new branch here when introducing a new event kind so that producers
 * and consumers stay in sync via the inferred `RealtimeEvent` type.
 */
export const realtimeEventSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('chat.message'),
    messageId: z.string(),
    tripBookId: z.string(),
    userId: z.string().nullable(),
    role: z.enum(['user', 'assistant', 'tool', 'system']),
    content: z.string(),
    createdAt: z.string(),
  }),
  z.object({
    kind: z.literal('node.add'),
    variantId: z.string(),
    nodeId: z.string(),
    originId: z.string(),
    parentOriginId: z.string().nullable(),
  }),
  z.object({
    kind: z.literal('node.update'),
    variantId: z.string(),
    originId: z.string(),
    patch: z.record(z.string(), z.unknown()),
    version: z.number().int(),
  }),
  z.object({
    kind: z.literal('node.delete'),
    variantId: z.string(),
    originId: z.string(),
  }),
  z.object({
    kind: z.literal('node.move'),
    variantId: z.string(),
    originId: z.string(),
    newParentOriginId: z.string().nullable(),
    newSortIndex: z.number().int(),
  }),
  z.object({
    kind: z.literal('merge.proposal.created'),
    tripBookId: z.string(),
    proposalId: z.string(),
    variantId: z.string(),
    proposedByUserId: z.string(),
  }),
  z.object({
    kind: z.literal('merge.committed'),
    tripBookId: z.string(),
    mainVersionId: z.string(),
    proposalId: z.string().nullable(),
  }),
]);

/** Inferred TypeScript discriminated union for realtime events. */
export type RealtimeEvent = z.infer<typeof realtimeEventSchema>;

/** All recognised event kinds, derived from the schema for completeness. */
export type RealtimeEventKind = RealtimeEvent['kind'];

// ---------------------------------------------------------------------------
// Server-side singleton
// ---------------------------------------------------------------------------

let serverPusherInstance: PusherServer | null = null;

/**
 * Test-only seam: swap out the server Pusher singleton (e.g. for unit tests
 * that want to inject a mock without touching env vars). Pass `null` to clear
 * the cached instance and force re-initialization on the next call.
 */
export function __setServerPusherForTesting(instance: PusherServer | null): void {
  serverPusherInstance = instance;
}

/**
 * Returns a lazily-initialized server-side `Pusher` instance. Throws with a
 * clear error if any required env var is missing — fail fast at the call site
 * rather than at broadcast time.
 */
export function getServerPusher(): PusherServer {
  if (serverPusherInstance) return serverPusherInstance;

  const appId = process.env.PUSHER_APP_ID;
  const key = process.env.PUSHER_KEY;
  const secret = process.env.PUSHER_SECRET;
  const cluster = process.env.PUSHER_CLUSTER;

  const missing = [
    ['PUSHER_APP_ID', appId],
    ['PUSHER_KEY', key],
    ['PUSHER_SECRET', secret],
    ['PUSHER_CLUSTER', cluster],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length > 0) {
    throw new Error(
      `Pusher server is not configured: missing env var(s) ${missing.join(', ')}.`,
    );
  }

  serverPusherInstance = new PusherServer({
    appId: appId as string,
    key: key as string,
    secret: secret as string,
    cluster: cluster as string,
    useTLS: true,
  });

  return serverPusherInstance;
}

/**
 * Broadcasts an event to all subscribers of `private-trip-book-${tripBookId}`.
 * Returns the underlying Pusher response so callers can `await` for delivery.
 */
export async function broadcastToTripBook(
  tripBookId: string,
  event: string,
  payload: unknown,
): Promise<unknown> {
  const pusher = getServerPusher();
  return pusher.trigger(tripBookChannel(tripBookId), event, payload);
}

/**
 * Broadcasts an event to all subscribers of `private-variant-${variantId}`.
 */
export async function broadcastToVariant(
  variantId: string,
  event: string,
  payload: unknown,
): Promise<unknown> {
  const pusher = getServerPusher();
  return pusher.trigger(variantChannel(variantId), event, payload);
}

// ---------------------------------------------------------------------------
// Client-side singleton
// ---------------------------------------------------------------------------

let clientPusherInstance: PusherClient | null = null;

/**
 * Returns a lazily-initialized browser `pusher-js` instance configured to call
 * `/api/pusher/auth` for private-channel signing.
 *
 * Must only be invoked from client components — it reads `NEXT_PUBLIC_*` env
 * vars and opens a websocket. Calling it during server rendering is wasteful.
 */
export function getClientPusher(): PusherClient {
  if (clientPusherInstance) return clientPusherInstance;

  const key = process.env.NEXT_PUBLIC_PUSHER_KEY;
  const cluster = process.env.NEXT_PUBLIC_PUSHER_CLUSTER;

  if (!key || !cluster) {
    throw new Error(
      'Pusher client is not configured: missing NEXT_PUBLIC_PUSHER_KEY or NEXT_PUBLIC_PUSHER_CLUSTER.',
    );
  }

  clientPusherInstance = new PusherClient(key, {
    cluster,
    forceTLS: true,
    authEndpoint: '/api/pusher/auth',
  });

  return clientPusherInstance;
}
