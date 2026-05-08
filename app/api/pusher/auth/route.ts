/**
 * Pusher private-channel auth endpoint.
 *
 * The browser `pusher-js` client POSTs (form-encoded) `socket_id` and
 * `channel_name` here whenever it subscribes to a `private-*` channel. We
 * verify the caller is a member of the trip book that owns the channel, then
 * sign the channel auth token with the server Pusher secret.
 *
 * Channel naming:
 *   - `private-trip-book-${tripBookId}`  -> verify membership of `tripBookId`
 *   - `private-variant-${variantId}`     -> look up the variant's tripBookId
 *                                           and verify membership of that
 *
 * Anything else is rejected with 403 — we don't sign channels we don't know.
 */
import { eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';

import { getCurrentUserId, requireMembership } from '@/lib/auth';
import { db } from '@/lib/db';
import { variant } from '@/db/schema';
import { getServerPusher } from '@/lib/realtime';

// Pusher channel-auth posts must hit a fresh request each time; never cache.
export const dynamic = 'force-dynamic';

const TRIP_BOOK_PREFIX = 'private-trip-book-';
const VARIANT_PREFIX = 'private-variant-';

/**
 * Resolves a channel name to the trip-book id whose membership we should
 * gate on. Returns null when the channel name doesn't match a recognised
 * pattern, so callers can return 403 without leaking why.
 */
async function tripBookIdForChannel(
  channelName: string,
): Promise<string | null> {
  if (channelName.startsWith(TRIP_BOOK_PREFIX)) {
    const id = channelName.slice(TRIP_BOOK_PREFIX.length);
    return id || null;
  }

  if (channelName.startsWith(VARIANT_PREFIX)) {
    const variantId = channelName.slice(VARIANT_PREFIX.length);
    if (!variantId) return null;

    const rows = await db
      .select({ tripBookId: variant.tripBookId })
      .from(variant)
      .where(eq(variant.id, variantId))
      .limit(1);

    return rows[0]?.tripBookId ?? null;
  }

  return null;
}

export async function POST(request: Request): Promise<Response> {
  // Pusher SDK posts as `application/x-www-form-urlencoded`.
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: 'Invalid form body' }, { status: 400 });
  }

  const socketId = formData.get('socket_id');
  const channelName = formData.get('channel_name');

  if (typeof socketId !== 'string' || typeof channelName !== 'string') {
    return NextResponse.json(
      { error: 'Missing socket_id or channel_name' },
      { status: 400 },
    );
  }

  // Authenticate the caller. `getCurrentUserId` throws when there's no Clerk
  // session — translate that into a 401 rather than a 500.
  let userId: string;
  try {
    userId = await getCurrentUserId();
  } catch {
    return NextResponse.json({ error: 'Unauthenticated' }, { status: 401 });
  }

  // Authorize the caller for this specific channel.
  const tripBookId = await tripBookIdForChannel(channelName);
  if (!tripBookId) {
    return NextResponse.json(
      { error: 'Unsupported channel' },
      { status: 403 },
    );
  }

  try {
    await requireMembership(tripBookId, userId);
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // Sign the channel auth token. `authorizeChannel` is synchronous.
  const pusher = getServerPusher();
  const authResponse = pusher.authorizeChannel(socketId, channelName);

  return NextResponse.json(authResponse);
}
