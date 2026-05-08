'use client';

import { cn } from '@/lib/utils';

/**
 * Renders a value that may be undefined while a tool's input is still
 * streaming, falling back to a faded placeholder. Once a string lands the
 * component just renders it inline. Used inside cards so partial fields
 * render nicely without flicker.
 */
export function StreamingText({
  value,
  fallback = '...',
  className,
}: {
  value: string | undefined | null;
  fallback?: string;
  className?: string;
}) {
  if (value === undefined || value === null || value === '') {
    return (
      <span className={cn('text-muted-foreground italic', className)}>
        {fallback}
      </span>
    );
  }
  return <span className={className}>{value}</span>;
}
