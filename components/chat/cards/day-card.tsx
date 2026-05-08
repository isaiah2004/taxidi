'use client';

import { useState } from 'react';
import { CalendarIcon, CheckIcon, XIcon } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

import { CitationsPanel, type Citation } from '../citations-panel';
import { StreamingText } from '../streaming-text';

interface DayInput {
  date?: string;
  title?: string;
  sortIndex?: number;
  suggestedNotes?: string;
  citations?: Citation[];
}

interface DayPart {
  state:
    | 'input-streaming'
    | 'input-available'
    | 'output-available'
    | 'output-error'
    | 'output-denied'
    | 'approval-requested'
    | 'approval-responded';
  input?: DayInput;
  output?: DayInput;
  errorText?: string;
}

export function DayCard({
  part,
  tripBookId,
  variantId,
}: {
  part: DayPart;
  tripBookId: string;
  variantId: string;
}) {
  const data: DayInput = part.output ?? part.input ?? {};
  const isEditable = part.state === 'output-available';
  const [accepted, setAccepted] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  if (hidden) return null;
  if (part.state === 'output-error') {
    return (
      <Card
        size="sm"
        className="max-w-md border-destructive/40"
        role="alert"
      >
        <CardHeader>
          <CardTitle className="text-destructive">Day card failed</CardTitle>
        </CardHeader>
        <CardContent>{part.errorText ?? 'Unknown error'}</CardContent>
      </Card>
    );
  }

  async function handleAccept() {
    setSubmitting(true);
    try {
      // For days we encode the date in startAt and reuse the title; the
      // type field "day" tells the renderer how to group children.
      const useTitle = data.title ?? (data.date ? `Day ${data.date}` : 'Day');
      const startAt = data.date ? `${data.date}T00:00:00.000Z` : null;

      const res = await fetch(
        `/api/trips/${tripBookId}/variants/${variantId}/nodes`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'day',
            title: useTitle,
            notes: data.suggestedNotes ?? null,
            startAt,
            endAt: null,
            location: null,
            parentOriginId: null,
            sortIndex: data.sortIndex ?? 0,
            typeData: {
              date: data.date ?? null,
            },
          }),
        },
      );
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload.error ?? `HTTP ${res.status}`);
      }
      setAccepted(true);
      toast.success(`Added "${useTitle}"`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to add day');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card
      size="sm"
      className="max-w-md"
      data-card-type="day"
      role="group"
      aria-label="Proposed day"
    >
      <CardHeader className="pb-2">
        <div className="flex items-center gap-1.5 text-xs font-medium uppercase text-muted-foreground">
          <CalendarIcon className="size-3" aria-hidden="true" /> Day
        </div>
        <CardTitle>
          <StreamingText
            value={data.title ?? (data.date ? `Day · ${data.date}` : undefined)}
          />
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-1.5 text-xs">
        {data.date ? (
          <p>
            <span className="text-muted-foreground">Date </span>
            <span className="font-medium">{data.date}</span>
          </p>
        ) : null}
        {data.suggestedNotes ? (
          <p className="text-muted-foreground">{data.suggestedNotes}</p>
        ) : null}
        <CitationsPanel citations={data.citations} />
      </CardContent>
      <CardFooter className="justify-end gap-1.5">
        {accepted ? (
          <span
            className="inline-flex items-center gap-1 text-xs font-medium text-primary"
            role="status"
            aria-live="polite"
          >
            <CheckIcon className="size-3.5" aria-hidden="true" /> Added
          </span>
        ) : (
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setHidden(true)}
              disabled={!isEditable || submitting}
              aria-label="Reject day suggestion"
            >
              <XIcon aria-hidden="true" /> Reject
            </Button>
            <Button
              size="sm"
              onClick={handleAccept}
              disabled={!isEditable || submitting}
              aria-label="Accept and add day"
            >
              <CheckIcon aria-hidden="true" /> Accept
            </Button>
          </>
        )}
      </CardFooter>
    </Card>
  );
}
