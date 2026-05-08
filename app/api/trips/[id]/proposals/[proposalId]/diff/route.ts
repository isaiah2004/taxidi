/**
 * GET /api/trips/[id]/proposals/[proposalId]/diff
 *
 * Returns the computed `diff(currentMain, frozenVariantSnapshot)` plus both
 * snapshots so the owner can render a side-by-side review. The diff is
 * recomputed on every request because the current main may have advanced
 * since the proposal was created (rebase / other merge committed); the
 * member's variantSnapshot stays frozen on the proposal row.
 *
 * Auth: caller must be a member of the trip book AND either the trip-book
 * owner OR the proposal's variant owner. Other members are denied so a
 * member can't peek at someone else's proposal.
 */
import { eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import {
  ForbiddenError,
  UnauthenticatedError,
  getCurrentUserId,
  requireMembership,
} from '@/lib/auth';
import { db } from '@/lib/db';
import * as schema from '@/db/schema';
import { diff } from '@/lib/diff';
import type { SerializedSnapshot } from '@/lib/graph';
import { isOwner } from '@/lib/variants';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const TripBookIdSchema = z.uuid();
const ProposalIdSchema = z.uuid();

function authErrorResponse(err: unknown): NextResponse | null {
  if (err instanceof UnauthenticatedError) {
    return NextResponse.json({ error: err.message }, { status: 401 });
  }
  if (err instanceof ForbiddenError) {
    return NextResponse.json({ error: err.message }, { status: 403 });
  }
  return null;
}

function emptySnapshot(): SerializedSnapshot {
  return { nodes: [] };
}

function asSerializedSnapshot(value: unknown): SerializedSnapshot {
  if (
    value &&
    typeof value === 'object' &&
    Array.isArray((value as { nodes?: unknown }).nodes)
  ) {
    return value as SerializedSnapshot;
  }
  return emptySnapshot();
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string; proposalId: string }> },
): Promise<Response> {
  const { id: tripBookId, proposalId } = await context.params;

  if (
    !TripBookIdSchema.safeParse(tripBookId).success ||
    !ProposalIdSchema.safeParse(proposalId).success
  ) {
    return NextResponse.json(
      { error: 'Invalid trip book id or proposal id' },
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
    // 1. Load the proposal row + its variant's owner so we can authorize.
    const [proposal] = await db
      .select()
      .from(schema.mergeProposal)
      .where(eq(schema.mergeProposal.id, proposalId))
      .limit(1);

    if (!proposal || proposal.tripBookId !== tripBookId) {
      return NextResponse.json(
        { error: 'Proposal not found' },
        { status: 404 },
      );
    }

    const [variantRow] = await db
      .select({ ownerUserId: schema.variant.ownerUserId })
      .from(schema.variant)
      .where(eq(schema.variant.id, proposal.variantId))
      .limit(1);

    const isVariantOwner = variantRow?.ownerUserId === userId;
    const isTripOwner = await isOwner(tripBookId, userId);

    if (!isTripOwner && !isVariantOwner) {
      return NextResponse.json(
        {
          error:
            'Only the trip-book owner or the variant owner may view this proposal',
        },
        { status: 403 },
      );
    }

    // 2. Load the current main snapshot. If the trip book has no committed
    //    main, treat it as an empty snapshot so the diff still computes.
    const [tripRow] = await db
      .select({
        currentMainVersionId: schema.tripBook.currentMainVersionId,
      })
      .from(schema.tripBook)
      .where(eq(schema.tripBook.id, tripBookId))
      .limit(1);

    if (!tripRow) {
      return NextResponse.json(
        { error: 'Trip book not found' },
        { status: 404 },
      );
    }

    let mainSnapshot: SerializedSnapshot = emptySnapshot();
    if (tripRow.currentMainVersionId) {
      const [mv] = await db
        .select({ snapshot: schema.mainVersion.snapshot })
        .from(schema.mainVersion)
        .where(eq(schema.mainVersion.id, tripRow.currentMainVersionId))
        .limit(1);
      if (mv) {
        mainSnapshot = asSerializedSnapshot(mv.snapshot);
      }
    }

    const variantSnapshot = asSerializedSnapshot(proposal.variantSnapshot);

    // 3. Compute the diff. Pure CPU; no DB I/O.
    const computedDiff = diff(mainSnapshot, variantSnapshot);

    return NextResponse.json({
      proposal: {
        id: proposal.id,
        tripBookId: proposal.tripBookId,
        variantId: proposal.variantId,
        status: proposal.status,
        proposedAt: proposal.proposedAt.toISOString(),
        decidedAt: proposal.decidedAt?.toISOString() ?? null,
        ownerInstructions: proposal.ownerInstructions,
        mergeRunId: proposal.mergeRunId,
        resultingMainVersionId: proposal.resultingMainVersionId,
      },
      diff: computedDiff,
      mainSnapshot,
      variantSnapshot,
    });
  } catch (err) {
    console.error('[GET /proposals/.../diff] failed:', err);
    return NextResponse.json(
      { error: 'Failed to load proposal diff' },
      { status: 500 },
    );
  }
}
