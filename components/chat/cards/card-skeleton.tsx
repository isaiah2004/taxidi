'use client';

import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

type CardKind =
  | 'place'
  | 'lodging'
  | 'activity'
  | 'meal'
  | 'transport'
  | 'day';

/**
 * Per-type skeleton. Layout intentionally mirrors the card it stands in
 * for so the swap looks like the content "filling in" rather than a layout
 * shift. We render a static set of placeholder bars sized roughly like the
 * fields we expect for each kind.
 */
export function CardSkeleton({ type }: { type: CardKind }) {
  const lines = LINES_BY_KIND[type] ?? LINES_BY_KIND.place;

  return (
    <Card
      size="sm"
      className="max-w-md motion-reduce:animate-none"
      data-card-skeleton="true"
      role="status"
      aria-busy="true"
      aria-live="polite"
      aria-label={`Loading ${type} suggestion`}
    >
      <span className="sr-only">Loading {type} suggestion…</span>
      <CardHeader className="pb-2" aria-hidden="true">
        <Skeleton className="h-4 w-1/3 motion-reduce:animate-none" />
        <Skeleton className="h-5 w-3/4 motion-reduce:animate-none" />
      </CardHeader>
      <CardContent className="flex flex-col gap-2" aria-hidden="true">
        {lines.map((width, i) => (
          <Skeleton
            key={i}
            className="h-3 motion-reduce:animate-none"
            style={{ width }}
          />
        ))}
      </CardContent>
    </Card>
  );
}

const LINES_BY_KIND: Record<CardKind, string[]> = {
  place: ['80%', '60%', '40%'],
  lodging: ['80%', '50%', '50%', '70%'],
  activity: ['85%', '60%', '50%'],
  meal: ['75%', '55%', '40%'],
  transport: ['70%', '60%', '60%', '50%'],
  day: ['40%', '60%'],
};
