/**
 * POST /api/trips/[id]/proposals/[proposalId]/commit
 *
 * Owner-only. Body: { snapshot: SerializedSnapshot, message?: string }. Atomically:
 *   1. Inserts a `main_version` row whose `parentVersionId` is the trip-book's
 *      current main pointer. The UNIQUE on (trip_book_id, parent_version_id)
 *      means two concurrent commits race for the slot — only one wins.
 *   2. Updates `tripBook.currentMainVersionId` to the new row.
 *   3. Marks the proposal as `merged`, sets `decidedAt`, links the resulting
 *      main version.
 *   4. Marks the proposal's variant as `merged`.
 *   5. Marks every sibling variant (different owner) currently in `draft` /
 *      `proposed` state as `stale` so members know to rebase.
 *   6. Broadcasts a `merge.committed` event so connected clients refresh.
 *
 * The `snapshot` body comes from the owner's preview — they may have edited
 * the agent's output before approving, so we trust whatever they send.
 *
 * Concurrency: the parent-pointer UNIQUE check throws on conflict; we surface
 * that as 409 so the client can re-fetch and try again.
 */
import { and, eq, inArray, ne } from 'drizzle-orm';
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
import type { SerializedSnapshot } from '@/lib/graph';
import { safeBroadcastToTripBook } from '@/lib/realtime';
import { isOwner } from '@/lib/variants';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const TripBookIdSchema = z.uuid();
const ProposalIdSchema = z.uuid();

// `snapshot` is opaque JSON we trust to whatever the owner reviewed in the
// preview. We sanity-check the outer shape (`{ nodes: [] }`) below; the inner
// shape is enforced by the merge agent that produced it. The commit message
// is bounded so we don't store unbounded user input verbatim.
const CommitBodySchema = z
  .object({
    snapshot: z.object({ nodes: z.array(z.unknown()) }).passthrough(),
    message: z.string().max(500).optional(),
  })
  .strict();

function authErrorResponse(err: unknown): NextResponse | null {
  if (err instanceof UnauthenticatedError) {
    return NextResponse.json({ error: err.message }, { status: 401 });
  }
  if (err instanceof ForbiddenError) {
    return NextResponse.json({ error: err.message }, { status: 403 });
  }
  return null;
}


/**
 * Postgres unique-violation error code. We use it to translate concurrent
 * commit races into a 409 (the parent_version_id slot was taken by another
 * commit between when we read main and when we tried to insert).
 */
function isUniqueViolation(err: unknown): boolean {
  return (
    !!err &&
    typeof err === 'object' &&
    (err as { code?: unknown }).code === '23505'
  );
}

export async function POST(
  request: Request,
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

  if (!(await isOwner(tripBookId, userId))) {
    return NextResponse.json(
      { error: 'Only the trip-book owner may commit a merge' },
      { status: 403 },
    );
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsedBody = CommitBodySchema.safeParse(raw);
  if (!parsedBody.success) {
    const details = parsedBody.error.issues.map((i) => ({
      path: i.path.join('.'),
      message: i.message,
    }));
    return NextResponse.json(
      { error: 'Invalid request', details },
      { status: 400 },
    );
  }
  // The outer shape is validated; the snapshot's inner shape is whatever the
  // owner approved in the preview. `as` cast is safe because the agent and
  // diff layers expect the documented `SerializedSnapshot`.
  const snapshot = parsedBody.data.snapshot as SerializedSnapshot;
  const message =
    parsedBody.data.message && parsedBody.data.message.length > 0
      ? parsedBody.data.message
      : null;

  // Up-front status check so we can short-circuit obviously bad calls without
  // a transaction. Re-checked inside the transaction for safety.
  const [proposal] = await db
    .select()
    .from(schema.mergeProposal)
    .where(eq(schema.mergeProposal.id, proposalId))
    .limit(1);

  if (!proposal || proposal.tripBookId !== tripBookId) {
    return NextResponse.json({ error: 'Proposal not found' }, { status: 404 });
  }
  if (proposal.status !== 'pending') {
    return NextResponse.json(
      { error: `Proposal is ${proposal.status}, not pending` },
      { status: 409 },
    );
  }

  let newMainVersionId: string;
  try {
    newMainVersionId = await db.transaction(async (tx) => {
      // Re-read inside tx to lock-step against concurrent commits.
      const [tripRow] = await tx
        .select({
          id: schema.tripBook.id,
          currentMainVersionId: schema.tripBook.currentMainVersionId,
        })
        .from(schema.tripBook)
        .where(eq(schema.tripBook.id, tripBookId))
        .limit(1);

      if (!tripRow) {
        throw Object.assign(new Error('Trip book not found'), { status: 404 });
      }

      const [proposalRow] = await tx
        .select()
        .from(schema.mergeProposal)
        .where(eq(schema.mergeProposal.id, proposalId))
        .limit(1);

      if (!proposalRow || proposalRow.tripBookId !== tripBookId) {
        throw Object.assign(new Error('Proposal not found'), { status: 404 });
      }
      if (proposalRow.status !== 'pending') {
        throw Object.assign(
          new Error(`Proposal is ${proposalRow.status}, not pending`),
          { status: 409 },
        );
      }

      // 1. Insert the new main version. The UNIQUE on
      //    (trip_book_id, parent_version_id) prevents a fork.
      const [inserted] = await tx
        .insert(schema.mainVersion)
        .values({
          tripBookId,
          parentVersionId: tripRow.currentMainVersionId ?? null,
          snapshot,
          committedByUserId: userId,
          message,
        })
        .returning({ id: schema.mainVersion.id });

      if (!inserted) {
        throw new Error('Failed to insert main version');
      }

      // 2. Move the trip book's pointer.
      await tx
        .update(schema.tripBook)
        .set({
          currentMainVersionId: inserted.id,
          updatedAt: new Date(),
        })
        .where(eq(schema.tripBook.id, tripBookId));

      // 3. Mark the proposal merged.
      await tx
        .update(schema.mergeProposal)
        .set({
          status: 'merged',
          decidedAt: new Date(),
          resultingMainVersionId: inserted.id,
        })
        .where(eq(schema.mergeProposal.id, proposalId));

      // 4. Mark the proposal's variant merged.
      await tx
        .update(schema.variant)
        .set({ status: 'merged', updatedAt: new Date() })
        .where(eq(schema.variant.id, proposalRow.variantId));

      // 5. Stale every other variant in this trip-book that was draft / proposed.
      //    The merged one is excluded by `ne(id, ...)` so we don't bounce its
      //    status back to stale.
      await tx
        .update(schema.variant)
        .set({ status: 'stale', updatedAt: new Date() })
        .where(
          and(
            eq(schema.variant.tripBookId, tripBookId),
            ne(schema.variant.id, proposalRow.variantId),
            inArray(schema.variant.status, ['draft', 'proposed']),
          ),
        );

      return inserted.id;
    });
  } catch (err) {
    if (
      err &&
      typeof err === 'object' &&
      'status' in err &&
      typeof (err as { status: unknown }).status === 'number'
    ) {
      const status = (err as { status: number }).status;
      const messageStr =
        err instanceof Error ? err.message : 'Bad request';
      return NextResponse.json({ error: messageStr }, { status });
    }
    if (isUniqueViolation(err)) {
      return NextResponse.json(
        {
          error:
            'Main has advanced since this preview; please re-run the merge.',
        },
        { status: 409 },
      );
    }
    console.error('[POST /proposals/.../commit] failed:', err);
    return NextResponse.json(
      { error: 'Failed to commit merge' },
      { status: 500 },
    );
  }

  // Best-effort realtime fanout — don't fail the request if Pusher is down.
  await safeBroadcastToTripBook(tripBookId, 'merge.committed', {
    kind: 'merge.committed',
    tripBookId,
    mainVersionId: newMainVersionId,
    proposalId,
  });

  return NextResponse.json({ mainVersionId: newMainVersionId });
}
