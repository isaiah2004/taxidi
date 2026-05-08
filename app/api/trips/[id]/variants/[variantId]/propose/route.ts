/**
 * Freeze a variant into a `merge_proposal` row and notify the owner.
 *
 * The frozen `variantSnapshot` JSONB is the merge agent's stable input — the
 * member can keep editing their variant after proposing without affecting the
 * proposal that's been sent for review.
 *
 * Auth: variant owner only. (Nothing prevents the trip-book owner from
 * proposing their own variant, but it's their own variant they're proposing.)
 */
import { and, asc, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import {
  ForbiddenError,
  UnauthenticatedError,
  getCurrentUserId,
  requireMembership,
} from '@/lib/auth';
import { db } from '@/lib/db';
import {
  mergeProposal,
  node as nodeTable,
  variant as variantTable,
} from '@/db/schema';
import { safeBroadcastToTripBook } from '@/lib/realtime';
import { getOrCreateVariantForUser } from '@/lib/variants';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const TripBookIdSchema = z.uuid();
const VariantIdParamSchema = z.union([z.literal('mine'), z.uuid()]);

interface SerializedLocation {
  placeId: string;
  lat: number;
  lng: number;
  address: string;
}

interface SerializedNode {
  originId: string;
  parentOriginId: string | null;
  type: string;
  title: string;
  notes: string | null;
  startAt: string | null;
  endAt: string | null;
  location: SerializedLocation | null;
  typeData: Record<string, unknown>;
  sortIndex: number;
  version: number;
}

interface SerializedSnapshot {
  nodes: SerializedNode[];
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

async function resolveVariantId(
  rawVariantId: string,
  tripBookId: string,
  userId: string,
): Promise<string> {
  if (rawVariantId === 'mine') {
    const summary = await getOrCreateVariantForUser(tripBookId, userId);
    return summary.id;
  }
  return rawVariantId;
}

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string; variantId: string }> },
): Promise<Response> {
  const { id: tripBookId, variantId: rawVariantId } = await context.params;

  if (
    !TripBookIdSchema.safeParse(tripBookId).success ||
    !VariantIdParamSchema.safeParse(rawVariantId).success
  ) {
    return NextResponse.json(
      { error: 'Invalid trip book id or variant id' },
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

  let variantId: string;
  try {
    variantId = await resolveVariantId(rawVariantId, tripBookId, userId);
  } catch (err) {
    console.error('[POST propose] resolveVariant failed:', err);
    return NextResponse.json(
      { error: 'Failed to resolve variant' },
      { status: 500 },
    );
  }

  // Owner check happens against the variant, not the trip book.
  const [variantRow] = await db
    .select({
      id: variantTable.id,
      ownerUserId: variantTable.ownerUserId,
      tripBookId: variantTable.tripBookId,
      status: variantTable.status,
    })
    .from(variantTable)
    .where(eq(variantTable.id, variantId))
    .limit(1);

  if (!variantRow || variantRow.tripBookId !== tripBookId) {
    return NextResponse.json({ error: 'Variant not found' }, { status: 404 });
  }
  if (variantRow.ownerUserId !== userId) {
    return NextResponse.json(
      { error: 'Only the variant owner may propose' },
      { status: 403 },
    );
  }

  try {
    const proposalId = await db.transaction(async (tx) => {
      // 1. Read all non-deleted node rows for this variant. Ordered by sort
      //    index so the snapshot is deterministic for diffing later.
      const nodes = await tx
        .select()
        .from(nodeTable)
        .where(
          and(
            eq(nodeTable.variantId, variantId),
            eq(nodeTable.deleted, false),
          ),
        )
        .orderBy(asc(nodeTable.sortIndex), asc(nodeTable.createdAt));

      // Build a node.id -> originId map so we can resolve `parent_node_id`
      // back to the parent's stable origin id without a second query.
      const idToOrigin = new Map<string, string>();
      for (const n of nodes) {
        idToOrigin.set(n.id, n.originId);
      }

      const serializedNodes: SerializedNode[] = nodes.map((n) => {
        const location: SerializedLocation | null =
          n.locationPlaceId &&
          n.locationLat !== null &&
          n.locationLng !== null &&
          n.locationAddress !== null
            ? {
                placeId: n.locationPlaceId,
                lat: n.locationLat,
                lng: n.locationLng,
                address: n.locationAddress,
              }
            : null;

        return {
          originId: n.originId,
          parentOriginId: n.parentNodeId
            ? idToOrigin.get(n.parentNodeId) ?? null
            : null,
          type: n.type,
          title: n.title,
          notes: n.notes,
          startAt: n.startAt ? n.startAt.toISOString() : null,
          endAt: n.endAt ? n.endAt.toISOString() : null,
          location,
          typeData: (n.typeData as Record<string, unknown>) ?? {},
          sortIndex: n.sortIndex,
          version: n.version,
        };
      });

      const snapshot: SerializedSnapshot = { nodes: serializedNodes };

      // 2. Insert the proposal row.
      const [proposal] = await tx
        .insert(mergeProposal)
        .values({
          tripBookId,
          variantId,
          variantSnapshot: snapshot,
          status: 'pending',
        })
        .returning({ id: mergeProposal.id });

      // 3. Mark the variant as proposed so the UI can grey out further edits
      //    (the API still allows them — the snapshot is what matters).
      await tx
        .update(variantTable)
        .set({ status: 'proposed', updatedAt: new Date() })
        .where(eq(variantTable.id, variantId));

      return proposal.id;
    });

    await safeBroadcastToTripBook(tripBookId, 'merge.proposal.created', {
      kind: 'merge.proposal.created',
      tripBookId,
      proposalId,
      variantId,
      proposedByUserId: userId,
    });

    return NextResponse.json({ proposalId }, { status: 201 });
  } catch (err) {
    console.error('[POST propose] failed:', err);
    return NextResponse.json(
      { error: 'Failed to create proposal' },
      { status: 500 },
    );
  }
}
