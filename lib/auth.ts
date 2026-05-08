import { auth } from '@clerk/nextjs/server';
import { and, eq } from 'drizzle-orm';

import { db } from '@/lib/db';
import { membership, tripBook, type Membership } from '@/db/schema';

/**
 * Auth helpers for Taxidi server code (Route Handlers, Server Actions,
 * Server Components). These intentionally throw rather than returning
 * `null` so callers can `await` them at the top of a handler and trust
 * the rest of the function runs only when the caller is authenticated /
 * authorized.
 *
 * Dev escape hatch: when `DISABLE_AUTH=true` is set, both helpers short-
 * circuit to a fixed test user (`dev-user`). This is a TEMPORARY testing
 * flag; never set it in production.
 */

const DEV_BYPASS = process.env.DISABLE_AUTH === 'true';
const DEV_USER_ID = 'dev-user';

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
  if (DEV_BYPASS) return DEV_USER_ID;
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
 *
 * In `DISABLE_AUTH=true` mode, if there's no membership row for the dev
 * user but the trip book exists, we synthesize an owner-shaped row so
 * the rest of the request flow proceeds. This lets a clean DB get
 * exercised end-to-end without a sign-in step.
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
    if (DEV_BYPASS) {
      const [book] = await db
        .select({ id: tripBook.id, ownerUserId: tripBook.ownerUserId })
        .from(tripBook)
        .where(eq(tripBook.id, tripBookId))
        .limit(1);
      if (!book) {
        throw new ForbiddenError('Trip book not found');
      }
      const isOwner = book.ownerUserId === userId;
      const synthetic: Membership = {
        tripBookId,
        userId,
        role: isOwner ? 'owner' : 'member',
        status: 'active',
        invitedByUserId: null,
        invitationToken: null,
        joinedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      return synthetic;
    }
    throw new ForbiddenError('Not a member of this trip book');
  }
  if (row.status !== 'active') {
    throw new ForbiddenError('Membership is not active');
  }
  return row;
}
