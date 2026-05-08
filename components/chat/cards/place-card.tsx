'use client';

import { useState } from 'react';
import { CheckIcon, MapPinIcon, PencilIcon, XIcon } from 'lucide-react';
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

interface PlaceInput {
  suggestedTitle?: string;
  suggestedNotes?: string;
  placeId?: string;
  lat?: number;
  lng?: number;
  address?: string;
  suggestedStartAt?: string;
  suggestedEndAt?: string;
  dayOriginId?: string;
  citations?: Citation[];
}

interface PlacePart {
  state:
    | 'input-streaming'
    | 'input-available'
    | 'output-available'
    | 'output-error'
    | 'output-denied'
    | 'approval-requested'
    | 'approval-responded';
  input?: PlaceInput;
  output?: PlaceInput;
  errorText?: string;
}

interface PlaceCardProps {
  part: PlacePart;
  tripBookId: string;
  variantId: string;
}

/**
 * Renders a "propose place" card. While the model streams its arguments
 * (`state === 'input-streaming'`) the fields render as `<StreamingText />`
 * with placeholders; once the tool output is available we switch to an
 * editable form, gated behind an Edit toggle. Accept POSTs to the variant
 * nodes endpoint owned by Agent 2.
 */
export function PlaceCard({ part, tripBookId, variantId }: PlaceCardProps) {
  const data: PlaceInput = part.output ?? part.input ?? {};
  const isEditable = part.state === 'output-available';

  const [editing, setEditing] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Local controlled fields (only meaningful in edit mode).
  const [title, setTitle] = useState(data.suggestedTitle ?? '');
  const [notes, setNotes] = useState(data.suggestedNotes ?? '');
  const [address, setAddress] = useState(data.address ?? '');

  if (hidden) return null;
  if (part.state === 'output-error') {
    return (
      <Card size="sm" className="max-w-md border-destructive/40">
        <CardHeader>
          <CardTitle className="text-destructive">Place card failed</CardTitle>
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
      const useAddress = editing ? address : data.address;

      const location =
        data.placeId &&
        typeof data.lat === 'number' &&
        typeof data.lng === 'number' &&
        useAddress
          ? {
              placeId: data.placeId,
              lat: data.lat,
              lng: data.lng,
              address: useAddress,
            }
          : null;

      const res = await fetch(
        `/api/trips/${tripBookId}/variants/${variantId}/nodes`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'destination',
            title: useTitle,
            notes: useNotes ?? null,
            startAt: data.suggestedStartAt ?? null,
            endAt: data.suggestedEndAt ?? null,
            location,
            parentOriginId: data.dayOriginId ?? null,
          }),
        },
      );
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload.error ?? `HTTP ${res.status}`);
      }
      setAccepted(true);
      toast.success(`Added "${useTitle}" to your trip`);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : 'Failed to add place',
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card size="sm" className="max-w-md" data-card-type="place">
      <CardHeader className="pb-2">
        <div className="flex items-center gap-1.5 text-xs font-medium uppercase text-muted-foreground">
          <MapPinIcon className="size-3" /> Place
        </div>
        <CardTitle>
          {editing ? (
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="h-7 text-base"
            />
          ) : (
            <StreamingText value={data.suggestedTitle} fallback="…" />
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {editing ? (
          <Field label="Notes">
            <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
        ) : data.suggestedNotes || part.state === 'input-streaming' ? (
          <p className="text-muted-foreground">
            <StreamingText value={data.suggestedNotes} fallback="" />
          </p>
        ) : null}

        {editing ? (
          <Field label="Address">
            <Input value={address} onChange={(e) => setAddress(e.target.value)} />
          </Field>
        ) : data.address ? (
          <p className="text-xs text-muted-foreground">{data.address}</p>
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
              aria-label="Reject"
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

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <Label className="text-xs">{label}</Label>
      {children}
    </div>
  );
}
