'use client';

/**
 * VariantSwitcher — dropdown that lets a user jump between the read-only
 * `Main` timeline, their own draft variant, and (for owners) any member
 * variant currently open against this trip-book.
 *
 * For v1 the page URL is the source of truth: clicking an entry pushes
 * `/trips/{id}?variant={variantId}`. The list of selectable variants is
 * passed in by the parent (server component knows the membership), so this
 * component is presentational and stateless beyond the dropdown's open flag.
 */

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronDown, Check, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export interface VariantOption {
  id: string;
  label: string;
  /** Shown beneath the label. e.g. "Owner", "Alice's variant". */
  hint?: string;
  /** When true, this option is read-only (the merged `Main` timeline). */
  readOnly?: boolean;
}

export interface VariantSwitcherProps {
  tripBookId: string;
  /** Currently active variant id (or 'main'). */
  activeId: string;
  /** All selectable variants — typically: main, your variant, member variants. */
  options: VariantOption[];
}

export function VariantSwitcher({
  tripBookId,
  activeId,
  options,
}: VariantSwitcherProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const active =
    options.find((o) => o.id === activeId) ?? options[0] ?? null;

  const select = (id: string) => {
    if (id === activeId) return;
    startTransition(() => {
      router.push(
        id === 'main'
          ? `/trips/${tripBookId}`
          : `/trips/${tripBookId}?variant=${id}`,
      );
    });
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" disabled={isPending}>
          <Users className="text-muted-foreground" />
          <span className="font-medium">{active?.label ?? 'Select variant'}</span>
          <ChevronDown className="text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[220px]">
        <DropdownMenuLabel>Variants</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {options.map((opt) => {
          const isActive = opt.id === activeId;
          return (
            <DropdownMenuItem
              key={opt.id}
              onSelect={() => select(opt.id)}
              className="flex items-start gap-2"
            >
              <span className="mt-0.5 inline-flex w-4 justify-center">
                {isActive ? <Check /> : null}
              </span>
              <span className="flex flex-1 flex-col">
                <span className="font-medium">{opt.label}</span>
                {opt.hint && (
                  <span className="text-xs text-muted-foreground">
                    {opt.hint}
                  </span>
                )}
              </span>
              {opt.readOnly && (
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  read-only
                </span>
              )}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
