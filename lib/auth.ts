import { auth } from '@clerk/nextjs/server';
import { and, eq } from 'drizzle-orm';

import { db } from '@/lib/db';
import { membership, type Membership } from '@/db/schema';

/**
 * Auth helpers for Taxidi server code (Route Handlers, Server Actions,
 * Server Components). These intentionally throw rather than returning
 * `null` so callers can `await` them at the top of a handler and trust
 * the rest of the function runs only when the caller is authenticated /
 * authorized.
 */

export class UnauthenticatedError extends Error {
  readonly status = 401;
  constructor(message = 'Not authenticated') {
    super(message);
    this.name = 'UnauthenticatedError';
  }
}

export class ForbiddenError extends Error {
  readonly status = 403;
  constructor(message = 'Forbidden') {
    super(message);
    this.name = 'ForbiddenError';
  }
}

/**
 * Returns the Clerk user id of the currently authenticated user.
 * Throws `UnauthenticatedError` (HTTP 401) if no session is present.
 */
export async function getCurrentUserId(): Promise<string> {
  const { userId } = await auth();
  if (!userId) {
    throw new UnauthenticatedError();
  }
  return userId;
}

/**
 * Looks up the membership row for `(tripBookId, userId)` and returns it.
 * Throws `ForbiddenError` (HTTP 403) when no row exists or the membership
 * is not in `active` status — invitations don't grant data access yet.
 *
 * Callers that need extra fields (role, joinedAt, etc.) get them via the
 * returned row; we deliberately avoid joining other tables here to keep
 * this hot path a single indexed lookup.
 */
export async function requireMembership(
  tripBookId: string,
  userId: string,
): Promise<Membership> {
  const [row] = await db
    .select()
    .from(membership)
    .where(
      and(
        eq(membership.tripBookId, tripBookId),
        eq(membership.userId, userId),
      ),
    )
    .limit(1);

  if (!row) {
    throw new ForbiddenError('Not a member of this trip book');
  }
  if (row.status !== 'active') {
    throw new ForbiddenError('Membership is not active');
  }
  return row;
}
