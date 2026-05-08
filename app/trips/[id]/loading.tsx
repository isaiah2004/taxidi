/**
 * Suspense fallback for `app/trips/[id]/page.tsx`. Renders a three-pane
 * skeleton in the same dimensions as the eventual layout so we don't see a
 * layout shift when the real content lands.
 */
import { Skeleton } from '@/components/ui/skeleton';

export default function TripLoading() {
  return (
    <div className="flex h-screen w-full">
      {/* Sidebar */}
      <div className="hidden w-[19rem] shrink-0 border-r bg-background p-3 md:block">
        <Skeleton className="h-8 w-32" />
        <div className="mt-6 space-y-2">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-3/4" />
        </div>
        <div className="mt-6 space-y-2">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-2/3" />
        </div>
      </div>

      {/* Main */}
      <div className="flex flex-1 flex-col">
        {/* Header */}
        <div className="flex h-[60px] shrink-0 items-center justify-between border-b px-6">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-9 w-24" />
        </div>
        <div className="flex flex-1 overflow-hidden">
          {/* Trip view */}
          <div className="flex-1 space-y-4 bg-muted/20 p-6">
            <Skeleton className="h-8 w-1/3" />
            <Skeleton className="h-32 w-full" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-3/4" />
          </div>
          {/* Chat */}
          <div className="hidden w-96 shrink-0 flex-col border-l bg-background p-4 lg:flex">
            <Skeleton className="h-6 w-24" />
            <div className="mt-6 flex-1 space-y-4">
              <Skeleton className="ml-auto h-12 w-3/4" />
              <Skeleton className="h-12 w-2/3" />
              <Skeleton className="ml-auto h-12 w-1/2" />
            </div>
            <Skeleton className="mt-4 h-10 w-full" />
          </div>
        </div>
      </div>
    </div>
  );
}
