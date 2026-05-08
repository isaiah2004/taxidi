/**
 * Owner-only proposal review page. Renders the diff between the trip-book's
 * current main and the proposal's frozen variant snapshot, and exposes the
 * AI Merge + Commit flow via `<MergeReview />`.
 *
 * Auth gating:
 *   - Unauthenticated -> /sign-in
 *   - Member but not owner -> 404 (we don't leak which trips have proposals)
 *   - Owner but the proposal doesn't belong to this trip-book -> notFound()
 *
 * Server-side, we compute the initial diff so the first paint can render the
 * full review without a client-side fetch round-trip.
 */
import { eq } from 'drizzle-orm';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import {
  ForbiddenError,
  UnauthenticatedError,
  getCurrentUserId,
  requireMembership,
} from '@/lib/auth';
import { db } from '@/lib/db';
import { mainVersion, mergeProposal, tripBook } from '@/db/schema';
import { diff } from '@/lib/diff';
import type { SerializedSnapshot } from '@/lib/graph';
import { isOwner } from '@/lib/variants';
import { MergeReview } from '@/components/proposals/merge-review';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

export const dynamic = 'force-dynamic';

interface ProposalPageProps {
  params: Promise<{ id: string; proposalId: string }>;
}

function asSerializedSnapshot(value: unknown): SerializedSnapshot {
  if (
    value &&
    typeof value === 'object' &&
    Array.isArray((value as { nodes?: unknown }).nodes)
  ) {
    return value as SerializedSnapshot;
  }
  return { nodes: [] };
}

export default async function ProposalReviewPage({
  params,
}: ProposalPageProps): Promise<React.ReactElement> {
  const { id: tripBookId, proposalId } = await params;

  let userId: string;
  try {
    userId = await getCurrentUserId();
  } catch (err) {
    if (err instanceof UnauthenticatedError) {
      redirect('/sign-in');
    }
    throw err;
  }

  try {
    await requireMembership(tripBookId, userId);
  } catch (err) {
    if (err instanceof ForbiddenError) {
      notFound();
    }
    throw err;
  }

  if (!(await isOwner(tripBookId, userId))) {
    // Members who happen to land on a proposal URL get a 404 rather than a
    // 403 — same rationale as the trip detail page (don't leak existence).
    notFound();
  }

  const [proposal] = await db
    .select()
    .from(mergeProposal)
    .where(eq(mergeProposal.id, proposalId))
    .limit(1);

  if (!proposal || proposal.tripBookId !== tripBookId) {
    notFound();
  }

  const [tripRow] = await db
    .select()
    .from(tripBook)
    .where(eq(tripBook.id, tripBookId))
    .limit(1);

  if (!tripRow) {
    notFound();
  }

  let mainSnapshot: SerializedSnapshot = { nodes: [] };
  if (tripRow.currentMainVersionId) {
    const [mv] = await db
      .select({ snapshot: mainVersion.snapshot })
      .from(mainVersion)
      .where(eq(mainVersion.id, tripRow.currentMainVersionId))
      .limit(1);
    if (mv) mainSnapshot = asSerializedSnapshot(mv.snapshot);
  }

  const variantSnapshot = asSerializedSnapshot(proposal.variantSnapshot);
  const initialDiff = diff(mainSnapshot, variantSnapshot);

  const statusVariant: 'default' | 'secondary' | 'destructive' | 'outline' =
    proposal.status === 'pending'
      ? 'default'
      : proposal.status === 'merged'
        ? 'secondary'
        : proposal.status === 'rejected'
          ? 'destructive'
          : 'outline';

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-6">
      <header className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <h1 className="font-heading text-2xl font-semibold">
              {tripRow.name}
            </h1>
            <Badge variant={statusVariant} className="uppercase">
              {proposal.status}
            </Badge>
          </div>
          <Button variant="outline" asChild>
            <Link href={`/trips/${tripBookId}`}>Back to trip</Link>
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">
          Proposal {proposal.id.slice(0, 8)} · proposed{' '}
          {proposal.proposedAt.toLocaleString()}
        </p>
      </header>

      {proposal.status === 'pending' ? (
        <MergeReview
          tripBookId={tripBookId}
          proposalId={proposalId}
          proposal={proposal}
          mainSnapshot={mainSnapshot}
          variantSnapshot={variantSnapshot}
          initialDiff={initialDiff}
        />
      ) : (
        <section className="space-y-2 rounded-md border border-border bg-card p-4 text-sm">
          <p>
            This proposal has already been{' '}
            <span className="font-medium">{proposal.status}</span>.
          </p>
          {proposal.decidedAt && (
            <p className="text-muted-foreground">
              Decided at {proposal.decidedAt.toLocaleString()}.
            </p>
          )}
          {proposal.resultingMainVersionId && (
            <p className="text-muted-foreground">
              Resulting main version:{' '}
              <code className="font-mono text-xs">
                {proposal.resultingMainVersionId.slice(0, 8)}
              </code>
            </p>
          )}
        </section>
      )}
    </div>
  );
}
