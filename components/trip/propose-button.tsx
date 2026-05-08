'use client';

/**
 * ProposeButton — submits the active variant for owner review. Does a simple
 * `confirm()` gate before POSTing because proposing locks further edits on
 * the variant, so we want the user to opt in deliberately.
 *
 * Owner-only flows hide the button via the `disabled` prop; the parent (page)
 * is responsible for that policy. We keep the button always rendered when
 * mounted and just disable it so the layout stays stable.
 */

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Send } from 'lucide-react';
import { Button } from '@/components/ui/button';

export interface ProposeButtonProps {
  tripBookId: string;
  variantId: string;
  disabled?: boolean;
}

export function ProposeButton({
  tripBookId,
  variantId,
  disabled,
}: ProposeButtonProps) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [, startTransition] = useTransition();

  async function handleClick() {
    if (disabled) return;
    if (
      typeof window !== 'undefined' &&
      !window.confirm(
        'Propose this variant to the owner? You will not be able to edit further until they review it.',
      )
    ) {
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(
        `/api/trips/${tripBookId}/variants/${variantId}/propose`,
        { method: 'POST' },
      );
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `Propose failed (${res.status})`);
      }
      toast.success('Proposal sent — the owner will review it.');
      startTransition(() => {
        router.refresh();
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to propose');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Button
      size="sm"
      onClick={handleClick}
      disabled={disabled || submitting}
    >
      <Send />
      {submitting ? 'Sending…' : 'Propose changes'}
    </Button>
  );
}
