/**
 * POST /api/trips/[id]/proposals/[proposalId]/merge
 *
 * Owner-only. Body: { instructions: string }. Runs the merge agent against the
 * current main + the proposal's frozen variant snapshot, guided by the owner's
 * free-text instructions. Returns the proposed (post-merge) snapshot, the ops
 * the agent applied, and any conflicts the owner must resolve. DOES NOT
 * commit — the owner reviews + edits the preview, then hits the separate
 * `/commit` endpoint.
 *
 * Side-effect: updates the `merge_proposal` row with the resulting
 * `mergeRunId` (so the run history is reachable from the proposal) and
 * `ownerInstructions` (so the next run / audit knows what was asked for).
 *
 * Status guard: only `pending` proposals can be merged. Already-merged or
 * rejected proposals return 409.
 */
import { eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';

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
import { runMergeAgent } from '@/lib/agents/merge-agent';
import { isOwner } from '@/lib/variants';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
// Merge runs can take several seconds while the model streams tool calls.
// Bumping the route timeout here keeps Cloud Run from cutting the response
// short on slow Gemini responses.
export const maxDuration = 120;

interface MergeRequestBody {
  instructions?: unknown;
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

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; proposalId: string }> },
): Promise<Response> {
  const { id: tripBookId, proposalId } = await context.params;

  if (!tripBookId || !proposalId) {
    return NextResponse.json(
      { error: 'Missing trip book id or proposal id' },
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

  // Trip-book owner only. The variant owner doesn't get to drive the merge.
  if (!(await isOwner(tripBookId, userId))) {
    return NextResponse.json(
      { error: 'Only the trip-book owner may run a merge' },
      { status: 403 },
    );
  }

  let body: MergeRequestBody;
  try {
    body = (await request.json()) as MergeRequestBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const instructions =
    typeof body.instructions === 'string' ? body.instructions : '';

  // Load the proposal and verify it's still pending.
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

  // Load the current main snapshot.
  const [tripRow] = await db
    .select({ currentMainVersionId: schema.tripBook.currentMainVersionId })
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
    if (mv) mainSnapshot = asSerializedSnapshot(mv.snapshot);
  }

  const variantSnapshot = asSerializedSnapshot(proposal.variantSnapshot);
  const computedDiff = diff(mainSnapshot, variantSnapshot);

  // Run the agent. This is the only call that may take meaningful time.
  let result;
  try {
    result = await runMergeAgent({
      tripBookId,
      proposalId,
      variantId: proposal.variantId,
      userId,
      mainSnapshot,
      variantSnapshot,
      computedDiff,
      ownerInstructions: instructions,
    });
  } catch (err) {
    console.error('[POST /proposals/.../merge] runMergeAgent failed:', err);
    return NextResponse.json(
      { error: 'Merge agent failed' },
      { status: 500 },
    );
  }

  // Persist linkage from proposal -> agent run + the instructions that were used.
  try {
    await db
      .update(schema.mergeProposal)
      .set({
        mergeRunId: result.agentRunId,
        ownerInstructions: instructions,
      })
      .where(eq(schema.mergeProposal.id, proposalId));
  } catch (err) {
    // Persistence of the link is non-critical for returning the preview, but
    // log loudly so we know if it ever fails.
    console.error('[POST /proposals/.../merge] proposal update failed:', err);
  }

  return NextResponse.json({
    proposedSnapshot: result.proposedSnapshot,
    opsApplied: result.opsApplied,
    conflicts: result.conflicts,
    agentRunId: result.agentRunId,
  });
}
