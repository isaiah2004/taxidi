'use client';

import { useState } from 'react';
import {
  ArrowRightIcon,
  CheckIcon,
  PlaneIcon,
  XIcon,
} from 'lucide-react';
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

type TransportMode = 'flight' | 'train' | 'bus' | 'car' | 'ferry' | 'walk';

interface TransportInput {
  suggestedTitle?: string;
  mode?: TransportMode;
  fromOriginId?: string;
  toOriginId?: string;
  departAt?: string;
  arriveAt?: string;
  carrier?: string;
  bookingUrl?: string;
  price?: string;
  suggestedNotes?: string;
  citations?: Citation[];
}

interface TransportPart {
  state:
    | 'input-streaming'
    | 'input-available'
    | 'output-available'
    | 'output-error'
    | 'output-denied'
    | 'approval-requested'
    | 'approval-responded';
  input?: TransportInput;
  output?: TransportInput;
  errorText?: string;
}

export function TransportCard({
  part,
  tripBookId,
  variantId,
}: {
  part: TransportPart;
  tripBookId: string;
  variantId: string;
}) {
  const data: TransportInput = part.output ?? part.input ?? {};
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
          <CardTitle className="text-destructive">Transport card failed</CardTitle>
        </CardHeader>
        <CardContent>{part.errorText ?? 'Unknown error'}</CardContent>
      </Card>
    );
  }

  async function handleAccept() {
    if (!data.fromOriginId || !data.toOriginId) {
      toast.error('Transport requires both endpoints to be committed first');
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(
        `/api/trips/${tripBookId}/variants/${variantId}/nodes`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'transport',
            title: data.suggestedTitle ?? `${data.mode ?? 'Transport'}`,
            notes: data.suggestedNotes ?? null,
            startAt: data.departAt ?? null,
            endAt: data.arriveAt ?? null,
            location: null,
            parentOriginId: null,
            typeData: {
              mode: data.mode ?? null,
              from_origin_id: data.fromOriginId,
              to_origin_id: data.toOriginId,
              carrier: data.carrier ?? null,
              bookingUrl: data.bookingUrl ?? null,
              price: data.price ?? null,
            },
          }),
        },
      );
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload.error ?? `HTTP ${res.status}`);
      }
      setAccepted(true);
      toast.success('Added transport leg');
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : 'Failed to add transport',
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card
      size="sm"
      className="max-w-md"
      data-card-type="transport"
      role="group"
      aria-label="Proposed transport"
    >
      <CardHeader className="pb-2">
        <div className="flex items-center gap-1.5 text-xs font-medium uppercase text-muted-foreground">
          <PlaneIcon className="size-3" aria-hidden="true" /> Transport
          {data.mode ? <span className="lowercase">({data.mode})</span> : null}
        </div>
        <CardTitle>
          <StreamingText value={data.suggestedTitle} />
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 text-xs">
        <div
          className="flex items-center gap-1.5 font-medium"
          aria-label={`Route from ${
            data.fromOriginId ? truncate(data.fromOriginId, 8) : 'unknown'
          } to ${data.toOriginId ? truncate(data.toOriginId, 8) : 'unknown'}`}
        >
          <span className="rounded-md bg-muted px-1.5 py-0.5">
            {data.fromOriginId ? truncate(data.fromOriginId, 8) : '?'}
          </span>
          <ArrowRightIcon
            className="size-3 text-muted-foreground"
            aria-hidden="true"
          />
          <span className="rounded-md bg-muted px-1.5 py-0.5">
            {data.toOriginId ? truncate(data.toOriginId, 8) : '?'}
          </span>
        </div>

        {data.suggestedNotes ? (
          <p className="text-muted-foreground">{data.suggestedNotes}</p>
        ) : null}

        <div className="grid grid-cols-2 gap-2">
          {data.departAt ? <DataRow label="Depart" value={data.departAt} /> : null}
          {data.arriveAt ? <DataRow label="Arrive" value={data.arriveAt} /> : null}
          {data.carrier ? <DataRow label="Carrier" value={data.carrier} /> : null}
          {data.price ? <DataRow label="Price" value={data.price} /> : null}
        </div>

        {data.bookingUrl ? (
          <a
            href={data.bookingUrl}
            target="_blank"
            rel="noreferrer"
            className="font-medium text-primary hover:underline"
            aria-label={`Booking link (opens in new tab)`}
          >
            Booking link
          </a>
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
              aria-label="Reject transport suggestion"
            >
              <XIcon aria-hidden="true" /> Reject
            </Button>
            <Button
              size="sm"
              onClick={handleAccept}
              disabled={!isEditable || submitting}
              aria-label="Accept and add transport"
            >
              <CheckIcon aria-hidden="true" /> Accept
            </Button>
          </>
        )}
      </CardFooter>
    </Card>
  );
}

function DataRow({ label, value }: { label: string; value: string | undefined }) {
  if (!value) return null;
  return (
    <div className="flex flex-col">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
