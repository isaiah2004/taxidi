'use client';

import { useState } from 'react';
import { CheckIcon, PencilIcon, UtensilsIcon, XIcon } from 'lucide-react';
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

interface MealInput {
  suggestedTitle?: string;
  suggestedNotes?: string;
  placeId?: string;
  lat?: number;
  lng?: number;
  address?: string;
  suggestedStartAt?: string;
  cuisine?: string;
  reservationStatus?: 'none' | 'recommended' | 'required' | 'booked';
  bookingUrl?: string;
  priceRange?: string;
  dayOriginId?: string;
  citations?: Citation[];
}

interface MealPart {
  state:
    | 'input-streaming'
    | 'input-available'
    | 'output-available'
    | 'output-error'
    | 'output-denied'
    | 'approval-requested'
    | 'approval-responded';
  input?: MealInput;
  output?: MealInput;
  errorText?: string;
}

export function MealCard({
  part,
  tripBookId,
  variantId,
}: {
  part: MealPart;
  tripBookId: string;
  variantId: string;
}) {
  const data: MealInput = part.output ?? part.input ?? {};
  const isEditable = part.state === 'output-available';
  const [editing, setEditing] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [title, setTitle] = useState(data.suggestedTitle ?? '');
  const [notes, setNotes] = useState(data.suggestedNotes ?? '');

  if (hidden) return null;
  if (part.state === 'output-error') {
    return (
      <Card size="sm" className="max-w-md border-destructive/40">
        <CardHeader>
          <CardTitle className="text-destructive">Meal card failed</CardTitle>
        </CardHeader>
        <CardContent>{part.errorText ?? 'Unknown error'}</CardContent>
      </Card>
    );
  }

  async function handleAccept() {
    setSubmitting(true);
    try {
      const useTitle = editing ? title : data.suggestedTitle ?? '';
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
            type: 'meal',
            title: useTitle,
            notes: useNotes ?? null,
            startAt: data.suggestedStartAt ?? null,
            endAt: null,
            location,
            parentOriginId: data.dayOriginId ?? null,
            typeData: {
              cuisine: data.cuisine ?? null,
              reservationStatus: data.reservationStatus ?? null,
              bookingUrl: data.bookingUrl ?? null,
              priceRange: data.priceRange ?? null,
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
      toast.error(err instanceof Error ? err.message : 'Failed to add meal');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card size="sm" className="max-w-md" data-card-type="meal">
      <CardHeader className="pb-2">
        <div className="flex items-center gap-1.5 text-xs font-medium uppercase text-muted-foreground">
          <UtensilsIcon className="size-3" /> Meal
        </div>
        <CardTitle>
          {editing ? (
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="h-7 text-base"
            />
          ) : (
            <StreamingText value={data.suggestedTitle} />
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {editing ? (
          <div className="flex flex-col gap-1">
            <Label className="text-xs">Notes</Label>
            <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
        ) : data.suggestedNotes || part.state === 'input-streaming' ? (
          <p className="text-muted-foreground">
            <StreamingText value={data.suggestedNotes} fallback="" />
          </p>
        ) : null}

        <div className="grid grid-cols-2 gap-2 text-xs">
          {data.cuisine ? <DataRow label="Cuisine" value={data.cuisine} /> : null}
          {data.priceRange ? (
            <DataRow label="Price" value={data.priceRange} />
          ) : null}
          {data.reservationStatus ? (
            <DataRow label="Reservation" value={data.reservationStatus} />
          ) : null}
          {data.suggestedStartAt ? (
            <DataRow label="When" value={data.suggestedStartAt} />
          ) : null}
        </div>

        {data.bookingUrl ? (
          <a
            href={data.bookingUrl}
            target="_blank"
            rel="noreferrer"
            className="text-xs font-medium text-primary hover:underline"
          >
            Reservation link
          </a>
        ) : null}

        <CitationsPanel citations={data.citations} />
      </CardContent>
      <CardFooter className="justify-end gap-1.5">
        {accepted ? (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-primary">
            <CheckIcon className="size-3.5" /> Added
          </span>
        ) : (
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setHidden(true)}
              disabled={!isEditable || submitting}
            >
              <XIcon /> Reject
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setEditing((v) => !v)}
              disabled={!isEditable || submitting}
            >
              <PencilIcon /> {editing ? 'Done' : 'Edit'}
            </Button>
            <Button
              size="sm"
              onClick={handleAccept}
              disabled={!isEditable || submitting}
            >
              <CheckIcon /> Accept
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
