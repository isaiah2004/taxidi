/**
 * Per-trip-book detail endpoint.
 *
 * Returns the trip-book row, the caller's variant id (creating a draft
 * variant for first-time visitors via `getOrCreateVariantForUser`), and —
 * for owners only — the list of other variants in the book so the owner can
 * preview members' work before any merge proposal.
 */
import { and, desc, eq, ne } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import {
  ForbiddenError,
  UnauthenticatedError,
  getCurrentUserId,
  requireMembership,
} from '@/lib/auth';
import { db } from '@/lib/db';
import { tripBook, variant, type TripBook } from '@/db/schema';
import { getOrCreateVariantForUser, isOwner } from '@/lib/variants';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Trip-book ids are UUIDs. Reject anything else up-front so we don't waste a
// DB round trip and don't leak a "not found" oracle for malformed ids.
const TripBookIdSchema = z.uuid();

interface VariantSummary {
  id: string;
  ownerUserId: string;
  status: 'draft' | 'proposed' | 'merged' | 'rejected' | 'stale';
  updatedAt: string;
}

interface TripDetailResponse {
  tripBook: TripBook;
  currentMainVersionId: string | null;
  isOwner: boolean;
  myVariantId: string;
  otherVariants?: VariantSummary[];
}

function authErrorResponse(err: unknown): NextResponse | null {
  if (err instanceof UnauthenticatedError) {
    return NextResponse.json({ error: err.message }, { status: 401 });
  }
  if (err instanceof ForbiddenError) {
    return NextResponse.json({ error: err.message }, { status: 403 });
  }
  return null;
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id: tripBookId } = await context.params;

  if (!TripBookIdSchema.safeParse(tripBookId).success) {
    return NextResponse.json(
      { error: 'Invalid trip book id' },
      { status: 400 },
    );
  }

  let userId: string;
  try {
    userId = await getCurrentUserId();
    await requireMembership(tripBookId, userId);
  } catch (err) {
    const resp = authErrorResponse(err);
    if (resp) return resp;
    throw err;
  }

  try {
    const [tripRow] = await db
      .select()
      .from(tripBook)
      .where(eq(tripBook.id, tripBookId))
      .limit(1);

    if (!tripRow) {
      return NextResponse.json({ error: 'Trip not found' }, { status: 404 });
    }

    const [callerIsOwner, myVariant] = await Promise.all([
      isOwner(tripBookId, userId),
      getOrCreateVariantForUser(tripBookId, userId),
    ]);

    const response: TripDetailResponse = {
      tripBook: tripRow,
      currentMainVersionId: tripRow.currentMainVersionId,
      isOwner: callerIsOwner,
      myVariantId: myVariant.id,
    };

    if (callerIsOwner) {
      const otherRows = await db
        .select({
          id: variant.id,
          ownerUserId: variant.ownerUserId,
          status: variant.status,
          updatedAt: variant.updatedAt,
        })
        .from(variant)
        .where(
          and(
            eq(variant.tripBookId, tripBookId),
            ne(variant.ownerUserId, userId),
          ),
        )
        .orderBy(desc(variant.updatedAt));

      response.otherVariants = otherRows.map((row) => ({
        id: row.id,
        ownerUserId: row.ownerUserId,
        status: row.status,
        updatedAt: row.updatedAt.toISOString(),
      }));
    }

    return NextResponse.json(response);
  } catch (err) {
    console.error('[GET /api/trips/[id]] failed:', err);
    return NextResponse.json(
      { error: 'Failed to load trip' },
      { status: 500 },
    );
  }
}
