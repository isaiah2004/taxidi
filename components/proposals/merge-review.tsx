'use client';

/**
 * Owner-only review surface for a single merge proposal. Three stages:
 *
 *   1. Initial diff. Shows `diff(mainSnapshot, variantSnapshot)` and a textarea
 *      where the owner types instructions ("merge everything except day 2").
 *   2. AI Merge. POSTs the instructions to `/merge`, gets back a proposed
 *      snapshot + the ops the agent applied + any conflicts. Renders the
 *      preview as a fresh diff against the current main.
 *   3. Commit. POSTs the proposed snapshot to `/commit`, which writes a new
 *      `main_version` row, marks the proposal merged, and stales sibling
 *      variants.
 *
 * State machine kept deliberately small: a `phase` field plus a `preview`
 * holding the agent's output. We never auto-recommit; the owner always sees
 * the preview before any DB write.
 */

import { useId, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Sparkles } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { diff, type Diff, type DiffOp } from '@/lib/diff';
import type { SerializedSnapshot } from '@/lib/graph';
import type { MergeProposal } from '@/db/schema';

import { DiffRenderer } from './diff-renderer';

interface MergeConflict {
  originId: string;
  kind: string;
  reason: string;
  mainValue?: unknown;
  variantValue?: unknown;
}

interface MergeReviewProps {
  tripBookId: string;
  proposalId: string;
  proposal: MergeProposal;
  mainSnapshot: SerializedSnapshot;
  variantSnapshot: SerializedSnapshot;
  initialDiff: Diff;
}

interface MergePreview {
  proposedSnapshot: SerializedSnapshot;
  opsApplied: DiffOp[];
  conflicts: MergeConflict[];
  agentRunId: string;
}

type Phase = 'idle' | 'merging' | 'previewing' | 'committing' | 'done';

export function MergeReview({
  tripBookId,
  proposalId,
  proposal,
  mainSnapshot,
  variantSnapshot,
  initialDiff,
}: MergeReviewProps): React.ReactElement {
  const router = useRouter();
  const [instructions, setInstructions] = useState<string>(
    proposal.ownerInstructions ?? '',
  );
  const [preview, setPreview] = useState<MergePreview | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const instructionsId = useId();
  const instructionsHelpId = useId();

  // The diff that drives the review pane. While `preview === null` we show
  // the raw variant-vs-main diff. Once the agent has run, we show the diff
  // between current main and the proposed (post-merge) snapshot — so the
  // owner sees exactly what would change if they hit Commit.
  const reviewDiff = useMemo<Diff>(() => {
    if (!preview) return initialDiff;
    return diff(mainSnapshot, preview.proposedSnapshot);
  }, [preview, initialDiff, mainSnapshot]);

  const reviewVariantSnapshot = preview?.proposedSnapshot ?? variantSnapshot;

  async function handleAiMerge(): Promise<void> {
    setPhase('merging');
    const trimmed = instructions.trim();
    try {
      const res = await fetch(
        `/api/trips/${tripBookId}/proposals/${proposalId}/merge`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ instructions: trimmed }),
        },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        toast.error(body.error ?? `Merge failed (${res.status})`);
        setPhase('idle');
        return;
      }
      const data = (await res.json()) as MergePreview;
      setPreview(data);
      setPhase('previewing');
      if (data.conflicts.length > 0) {
        toast.warning(
          `Merge ran with ${data.conflicts.length} conflict${
            data.conflicts.length === 1 ? '' : 's'
          } — review before committing.`,
        );
      } else {
        toast.success(
          `Merge ran — ${data.opsApplied.length} op${
            data.opsApplied.length === 1 ? '' : 's'
          } applied. Review before committing.`,
        );
      }
    } catch (err) {
      console.error('[MergeReview] /merge failed', err);
      toast.error('Network error while running merge.');
      setPhase('idle');
    }
  }

  async function handleCommit(): Promise<void> {
    if (!preview) {
      toast.error('Run AI Merge first to produce a preview.');
      return;
    }
    setPhase('committing');
    try {
      const res = await fetch(
        `/api/trips/${tripBookId}/proposals/${proposalId}/commit`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            snapshot: preview.proposedSnapshot,
            message: instructions.trim() || undefined,
          }),
        },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        toast.error(body.error ?? `Commit failed (${res.status})`);
        setPhase('previewing');
        return;
      }
      toast.success('Merge committed to main.');
      setPhase('done');
      router.refresh();
      router.push(`/trips/${tripBookId}`);
    } catch (err) {
      console.error('[MergeReview] /commit failed', err);
      toast.error('Network error while committing merge.');
      setPhase('previewing');
    }
  }

  const isMerging = phase === 'merging';
  const isCommitting = phase === 'committing';
  const isDone = phase === 'done';
  const canCommit = preview !== null && !isCommitting && !isDone;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Sparkles aria-hidden="true" className="h-4 w-4" />
            <Label htmlFor={instructionsId} className="text-base font-medium">
              Merge instructions
            </Label>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p
            id={instructionsHelpId}
            className="text-sm text-muted-foreground"
          >
            Tell the merge agent how to reconcile this variant. For example:
            &ldquo;Merge everything except day 2&rdquo; or &ldquo;Drop the meal
            on day 3.&rdquo;
          </p>
          <textarea
            id={instructionsId}
            aria-describedby={instructionsHelpId}
            className="w-full min-h-[120px] resize-y rounded-md border border-border bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            placeholder="Free-text instructions for the merge agent…"
            disabled={isMerging || isCommitting || isDone}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              onClick={handleAiMerge}
              disabled={isMerging || isCommitting || isDone}
              aria-busy={isMerging || undefined}
              aria-label={
                isMerging
                  ? 'Running AI merge'
                  : preview
                    ? 'Re-run AI merge with current instructions'
                    : 'Run AI merge with current instructions'
              }
            >
              {isMerging ? (
                <>
                  <Loader2
                    aria-hidden="true"
                    className="h-4 w-4 animate-spin motion-reduce:animate-none"
                  />
                  Merging…
                </>
              ) : preview ? (
                <>
                  <Sparkles aria-hidden="true" className="h-4 w-4" />
                  Re-run AI merge
                </>
              ) : (
                <>
                  <Sparkles aria-hidden="true" className="h-4 w-4" />
                  AI merge
                </>
              )}
            </Button>
            <Button
              type="button"
              variant="default"
              onClick={handleCommit}
              disabled={!canCommit}
              aria-busy={isCommitting || undefined}
              aria-label={
                isCommitting ? 'Committing merge to main' : 'Commit merge to main'
              }
            >
              {isCommitting ? (
                <>
                  <Loader2
                    aria-hidden="true"
                    className="h-4 w-4 animate-spin motion-reduce:animate-none"
                  />
                  Committing…
                </>
              ) : (
                'Commit to main'
              )}
            </Button>
            {preview && (
              <Badge
                variant="secondary"
                aria-label={`${preview.opsApplied.length} ${
                  preview.opsApplied.length === 1 ? 'op' : 'ops'
                } applied, ${preview.conflicts.length} ${
                  preview.conflicts.length === 1 ? 'conflict' : 'conflicts'
                }`}
              >
                {preview.opsApplied.length} op
                {preview.opsApplied.length === 1 ? '' : 's'} ·{' '}
                {preview.conflicts.length} conflict
                {preview.conflicts.length === 1 ? '' : 's'}
              </Badge>
            )}
          </div>
        </CardContent>
      </Card>

      {preview && preview.conflicts.length > 0 && (
        <Card role="region" aria-label="Merge conflicts">
          <CardHeader>
            <CardTitle>Conflicts flagged by the agent</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <ul className="space-y-2" aria-label="Conflict list">
              {preview.conflicts.map((c, i) => (
                <li
                  key={`${c.originId}-${i}`}
                  className="rounded border border-amber-300 bg-amber-50 p-2 text-xs dark:border-amber-800 dark:bg-amber-950/40"
                  role="alert"
                >
                  <div className="font-mono text-[10px] text-muted-foreground">
                    {c.originId.slice(0, 12)}
                  </div>
                  <div className="font-medium uppercase tracking-wide">
                    {c.kind}
                  </div>
                  <div>{c.reason}</div>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>
            {preview ? 'Preview: main after merge' : 'Variant vs. main'}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <DiffRenderer
            ops={reviewDiff.ops}
            mainSnapshot={mainSnapshot}
            variantSnapshot={reviewVariantSnapshot}
          />
        </CardContent>
      </Card>
    </div>
  );
}
