/**
 * Collection-level handlers for trip books.
 *
 *   POST /api/trips   -> create a new trip book (initial main_version + owner
 *                       membership + owner variant) in a single transaction.
 *   GET  /api/trips   -> list the caller's owned and shared (member) trips,
 *                       with a `hasPendingProposal` flag for owned trips so
 *                       the sidebar can render a badge without a second call.
 *
 * Auth: every method requires a Clerk session. We translate the auth helpers'
 * thrown errors into structured JSON responses so the client can display a
 * consistent message and the response body shape stays uniform across success
 * and failure paths.
 */
import { and, desc, eq, exists, inArray } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import {
  ForbiddenError,
  UnauthenticatedError,
  getCurrentUserId,
} from '@/lib/auth';
import { db } from '@/lib/db';
import {
  mainVersion,
  membership,
  mergeProposal,
  tripBook,
  variant,
} from '@/db/schema';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Body schema for POST. Length-capped to keep DB columns bounded and to make
// trivial DoS via giant payloads unprofitable. Trim happens implicitly via
// `min(1)` after the optional `transform`.
const CreateTripSchema = z.object({
  name: z
    .string()
    .min(1, 'name is required')
    .max(200, 'name must be 200 characters or fewer')
    .transform((s) => s.trim())
    .refine((s) => s.length > 0, { message: 'name is required' }),
});

interface CreateTripResponse {
  id: string;
  name: string;
}

interface TripSummary {
  id: string;
  name: string;
  role: 'owner' | 'member';
  updatedAt: string;
  hasPendingProposal: boolean;
}

interface ListTripsResponse {
  owned: TripSummary[];
  shared: TripSummary[];
}

/**
 * Translate a thrown auth error into the matching JSON Response. Other errors
 * bubble up to the route's catch where they become 500s.
 */
function authErrorResponse(err: unknown): NextResponse | null {
  if (err instanceof UnauthenticatedError) {
    return NextResponse.json({ error: err.message }, { status: 401 });
  }
  if (err instanceof ForbiddenError) {
    return NextResponse.json({ error: err.message }, { status: 403 });
  }
  return null;
}

export async function POST(request: Request): Promise<Response> {
  let userId: string;
  try {
    userId = await getCurrentUserId();
  } catch (err) {
    const resp = authErrorResponse(err);
    if (resp) return resp;
    throw err;
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = CreateTripSchema.safeParse(raw);
  if (!parsed.success) {
    // Strip zod's internal tree to surface field names + messages only.
    const details = parsed.error.issues.map((i) => ({
      path: i.path.join('.'),
      message: i.message,
    }));
    return NextResponse.json(
      { error: 'Invalid request', details },
      { status: 400 },
    );
  }
  const { name } = parsed.data;

  try {
    const created = await db.transaction(async (tx) => {
      // 1. Insert the trip-book row. `current_main_version_id` stays null
      //    until we've created the first main_version below — the column is
      //    a deferred self-reference precisely to handle this chicken-and-egg.
      const [tripRow] = await tx
        .insert(tripBook)
        .values({
          name,
          ownerUserId: userId,
        })
        .returning();

      // 2. Initial main_version snapshot — empty plan, no parent.
      const [versionRow] = await tx
        .insert(mainVersion)
        .values({
          tripBookId: tripRow.id,
          parentVersionId: null,
          snapshot: { nodes: [] },
          committedByUserId: userId,
          message: 'Initial trip',
        })
        .returning();

      // 3. Point the trip book at the just-created version.
      await tx
        .update(tripBook)
        .set({ currentMainVersionId: versionRow.id })
        .where(eq(tripBook.id, tripRow.id));

      // 4. Owner membership row.
      await tx.insert(membership).values({
        tripBookId: tripRow.id,
        userId,
        role: 'owner',
        status: 'active',
        joinedAt: new Date(),
      });

      // 5. Owner's variant — empty (no node rows for an empty snapshot).
      await tx.insert(variant).values({
        tripBookId: tripRow.id,
        ownerUserId: userId,
        baseMainVersionId: versionRow.id,
        status: 'draft',
      });

      // 6. No nodes to materialize for an empty snapshot.

      return { id: tripRow.id, name: tripRow.name };
    });

    const response: CreateTripResponse = created;
    return NextResponse.json(response, { status: 201 });
  } catch (err) {
    console.error('[POST /api/trips] create failed:', err);
    return NextResponse.json(
      { error: 'Failed to create trip book' },
      { status: 500 },
    );
  }
}

export async function GET(): Promise<Response> {
  let userId: string;
  try {
    userId = await getCurrentUserId();
  } catch (err) {
    const resp = authErrorResponse(err);
    if (resp) return resp;
    throw err;
  }

  try {
    // Owned trips: trip_book.owner_user_id = userId. We also surface a
    // `hasPendingProposal` flag so the sidebar can show the merge badge
    // without an extra round trip per row.
    const ownedRows = await db
      .select({
        id: tripBook.id,
        name: tripBook.name,
        updatedAt: tripBook.updatedAt,
      })
      .from(tripBook)
      .where(eq(tripBook.ownerUserId, userId))
      .orderBy(desc(tripBook.updatedAt));

    let pendingTripIds = new Set<string>();
    if (ownedRows.length > 0) {
      const ownedIds = ownedRows.map((r) => r.id);
      const pendingRows = await db
        .selectDistinct({ tripBookId: mergeProposal.tripBookId })
        .from(mergeProposal)
        .where(
          and(
            inArray(mergeProposal.tripBookId, ownedIds),
            eq(mergeProposal.status, 'pending'),
          ),
        );
      pendingTripIds = new Set(pendingRows.map((p) => p.tripBookId));
    }

    const owned: TripSummary[] = ownedRows.map((row) => ({
      id: row.id,
      name: row.name,
      role: 'owner',
      updatedAt: row.updatedAt.toISOString(),
      hasPendingProposal: pendingTripIds.has(row.id),
    }));

    // Shared trips: rows where the user has a `member` (not `owner`) active
    // membership. We use an EXISTS subquery so we read the trip_book row, not
    // membership-shaped data.
    const sharedRows = await db
      .select({
        id: tripBook.id,
        name: tripBook.name,
        updatedAt: tripBook.updatedAt,
      })
      .from(tripBook)
      .where(
        exists(
          db
            .select({ one: membership.userId })
            .from(membership)
            .where(
              and(
                eq(membership.tripBookId, tripBook.id),
                eq(membership.userId, userId),
                eq(membership.role, 'member'),
                eq(membership.status, 'active'),
              ),
            ),
        ),
      )
      .orderBy(desc(tripBook.updatedAt));

    const shared: TripSummary[] = sharedRows.map((row) => ({
      id: row.id,
      name: row.name,
      role: 'member',
      updatedAt: row.updatedAt.toISOString(),
      // Pending-proposal flag is owner-facing only.
      hasPendingProposal: false,
    }));

    const response: ListTripsResponse = { owned, shared };
    return NextResponse.json(response);
  } catch (err) {
    console.error('[GET /api/trips] list failed:', err);
    return NextResponse.json(
      { error: 'Failed to list trips' },
      { status: 500 },
    );
  }
}
