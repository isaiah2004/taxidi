/**
 * Suspense fallback for the proposal review page. Mirrors the eventual
 * layout (header + instructions card + diff list) so we don't see layout
 * shift when the real content lands.
 */
import { Skeleton } from '@/components/ui/skeleton';

export default function ProposalReviewLoading(): React.ReactElement {
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-6">
      <header className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Skeleton className="h-7 w-48" />
          <Skeleton className="h-5 w-16" />
        </div>
        <Skeleton className="h-9 w-28" />
      </header>

      {/* Instructions card */}
      <div className="space-y-3 rounded-xl border border-border bg-card p-4">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-24 w-full" />
        <div className="flex gap-2">
          <Skeleton className="h-8 w-28" />
          <Skeleton className="h-8 w-32" />
        </div>
      </div>

      {/* Diff list */}
      <div className="space-y-2 rounded-xl border border-border bg-card p-4">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-3/4" />
      </div>
    </div>
  );
}
