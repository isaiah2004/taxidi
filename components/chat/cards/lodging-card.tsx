'use client';

import { useId, useState } from 'react';
import { BedIcon, CheckIcon, PencilIcon, XIcon } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

import { CitationsPanel, type Citation } from '../citations-panel';
import { StreamingText } from '../streaming-text';

interface LodgingInput {
  suggestedTitle?: string;
  suggestedNotes?: string;
  placeId?: string;
  lat?: number;
  lng?: number;
  address?: string;
  checkIn?: string;
  checkOut?: string;
  pricePerNight?: string;
  bookingUrl?: string;
  dayOriginId?: string;
  citations?: Citation[];
}

interface LodgingPart {
  state:
    | 'input-streaming'
    | 'input-available'
    | 'output-available'
    | 'output-error'
    | 'output-denied'
    | 'approval-requested'
    | 'approval-responded';
  input?: LodgingInput;
  output?: LodgingInput;
  errorText?: string;
}

export function LodgingCard({
  part,
  tripBookId,
  variantId,
}: {
  part: LodgingPart;
  tripBookId: string;
  variantId: string;
}) {
  const data: LodgingInput = part.output ?? part.input ?? {};
  const isEditable = part.state === 'output-available';
  const [editing, setEditing] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [title, setTitle] = useState(data.suggestedTitle ?? '');
  const [notes, setNotes] = useState(data.suggestedNotes ?? '');

  const titleId = useId();
  const notesId = useId();
  const titleErrorId = useId();
  const titleInvalid = editing && title.trim().length === 0;

  if (hidden) return null;
  if (part.state === 'output-error') {
    return (
      <Card
        size="sm"
        className="max-w-md border-destructive/40"
        role="alert"
      >
        <CardHeader>
          <CardTitle className="text-destructive">Lodging card failed</CardTitle>
        </CardHeader>
        <CardContent>{part.errorText ?? 'Unknown error'}</CardContent>
      </Card>
    );
  }

  async function handleAccept() {
    const useTitle = editing ? title.trim() : (data.suggestedTitle ?? '').trim();
    if (!useTitle) {
      toast.error('Title is required');
      return;
    }
    setSubmitting(true);
    try {
      const useNotes = editing ? notes : data.suggestedNotes;

      const location =
        data.placeId &&
        typeof data.lat === 'number' &&
        typeof data.lng === 'number' &&
        data.address
          ? {
              placeId: data.placeId,
              lat: data.lat,
              lng: data.lng,
              address: data.address,
            }
          : null;

      const res = await fetch(
        `/api/trips/${tripBookId}/variants/${variantId}/nodes`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'lodging',
            title: useTitle,
            notes: useNotes ?? null,
            startAt: data.checkIn ?? null,
            endAt: data.checkOut ?? null,
            location,
            parentOriginId: data.dayOriginId ?? null,
            typeData: {
              checkIn: data.checkIn ?? null,
              checkOut: data.checkOut ?? null,
              pricePerNight: data.pricePerNight ?? null,
              bookingUrl: data.bookingUrl ?? null,
            },
          }),
        },
      );
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload.error ?? `HTTP ${res.status}`);
      }
      setAccepted(true);
      toast.success(`Added "${useTitle}" lodging`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to add lodging');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card
      size="sm"
      className="max-w-md"
      data-card-type="lodging"
      role="group"
      aria-label="Proposed lodging"
    >
      <CardHeader className="pb-2">
        <div className="flex items-center gap-1.5 text-xs font-medium uppercase text-muted-foreground">
          <BedIcon className="size-3" aria-hidden="true" /> Lodging
        </div>
        <CardTitle>
          {editing ? (
            <>
              <Label htmlFor={titleId} className="sr-only">
                Title
              </Label>
              <Input
                id={titleId}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="h-7 text-base"
                aria-invalid={titleInvalid || undefined}
                aria-describedby={titleInvalid ? titleErrorId : undefined}
                aria-required="true"
              />
              {titleInvalid && (
                <p
                  id={titleErrorId}
                  role="alert"
                  className="mt-1 text-xs text-destructive"
                >
                  Title is required.
                </p>
              )}
            </>
          ) : (
            <StreamingText value={data.suggestedTitle} />
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {editing ? (
          <div className="flex flex-col gap-1">
            <Label htmlFor={notesId} className="text-xs">
              Notes
            </Label>
            <Input
              id={notesId}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
        ) : data.suggestedNotes || part.state === 'input-streaming' ? (
          <p className="text-muted-foreground">
            <StreamingText value={data.suggestedNotes} fallback="" />
          </p>
        ) : null}

        <div className="grid grid-cols-2 gap-2 text-xs">
          <DataRow label="Check-in" value={data.checkIn} />
          <DataRow label="Check-out" value={data.checkOut} />
          <DataRow label="Price/night" value={data.pricePerNight} />
          {data.address ? (
            <DataRow label="Address" value={data.address} />
          ) : null}
        </div>

        {data.bookingUrl ? (
          <a
            href={data.bookingUrl}
            target="_blank"
            rel="noreferrer"
            className="text-xs font-medium text-primary hover:underline"
            aria-label="Booking link (opens in new tab)"
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
              aria-label="Reject lodging suggestion"
            >
              <XIcon aria-hidden="true" /> Reject
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setEditing((v) => !v)}
              disabled={!isEditable || submitting}
              aria-label={editing ? 'Finish editing lodging' : 'Edit lodging'}
              aria-pressed={editing}
            >
              <PencilIcon aria-hidden="true" /> {editing ? 'Done' : 'Edit'}
            </Button>
            <Button
              size="sm"
              onClick={handleAccept}
              disabled={!isEditable || submitting}
              aria-label="Accept and add lodging"
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
