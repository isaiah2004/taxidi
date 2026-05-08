'use client';

/**
 * SidePanel — drawer-style edit form for a single graph element. Renders into
 * a shadcn `<Sheet>` anchored to the right edge. Same component handles both
 * vertices (places) and edges (transport); the form fields swap depending on
 * the kind of node passed in.
 *
 * Persists changes via PATCH/DELETE on the variant nodes endpoint. The server
 * is responsible for the auto-fork-on-first-edit behaviour (variant alias
 * `'mine'` resolves to the user's variant) — the client just sends the patch
 * and trusts the response.
 *
 * Optimistic UI: not yet wired through the parent (which keeps the source of
 * truth and re-fetches on Pusher events anyway). Errors are surfaced via
 * sonner toasts; on success we close the panel.
 */

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import type { GraphEdge, TransportMode, Vertex } from '@/lib/graph';

const TRANSPORT_MODES: TransportMode[] = [
  'flight',
  'train',
  'bus',
  'car',
  'ferry',
  'walk',
];

export type PanelTarget =
  | { kind: 'vertex'; vertex: Vertex }
  | { kind: 'edge'; edge: GraphEdge }
  | null;

export interface SidePanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: PanelTarget;
  tripBookId: string;
  variantId: string;
  /** Read-only view (e.g. main timeline). Hides Save/Delete. */
  readOnly?: boolean;
  /** Called after a successful save/delete so the parent can refresh. */
  onChanged?: () => void;
}

interface BaseFormState {
  title: string;
  notes: string;
  startAt: string;
  endAt: string;
}

interface VertexFormState extends BaseFormState {
  kind: 'vertex';
}

interface EdgeFormState extends BaseFormState {
  kind: 'edge';
  mode: TransportMode | '';
  carrier: string;
  bookingUrl: string;
}

type FormState = VertexFormState | EdgeFormState;

function toLocalInputValue(value: string | Date | null | undefined): string {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  // datetime-local needs `YYYY-MM-DDTHH:mm`. Render in local TZ.
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalInputValue(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function buildInitialForm(target: PanelTarget): FormState {
  if (!target) {
    return {
      kind: 'vertex',
      title: '',
      notes: '',
      startAt: '',
      endAt: '',
    };
  }
  if (target.kind === 'vertex') {
    return {
      kind: 'vertex',
      title: target.vertex.title ?? '',
      notes: target.vertex.notes ?? '',
      startAt: toLocalInputValue(target.vertex.startAt),
      endAt: toLocalInputValue(target.vertex.endAt),
    };
  }
  return {
    kind: 'edge',
    title: '',
    notes: target.edge.notes ?? '',
    startAt: toLocalInputValue(target.edge.departAt),
    endAt: toLocalInputValue(target.edge.arriveAt),
    mode: target.edge.mode ?? '',
    carrier: target.edge.carrier ?? '',
    bookingUrl: target.edge.bookingUrl ?? '',
  };
}

export function SidePanel({
  open,
  onOpenChange,
  target,
  tripBookId,
  variantId,
  readOnly = false,
  onChanged,
}: SidePanelProps) {
  const initial = useMemo(() => buildInitialForm(target), [target]);
  const [form, setForm] = useState<FormState>(initial);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Re-seed when the selected element changes.
  useEffect(() => {
    setForm(initial);
  }, [initial]);

  if (!target) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent />
      </Sheet>
    );
  }

  const expectedVersion =
    target.kind === 'vertex' ? target.vertex.version : target.edge.version;
  const originId =
    target.kind === 'vertex' ? target.vertex.originId : target.edge.originId;
  const address =
    target.kind === 'vertex' ? target.vertex.location?.address : null;

  async function handleSave() {
    if (readOnly) return;
    setSaving(true);
    try {
      const patch: Record<string, unknown> = {
        notes: form.notes || null,
      };
      if (form.kind === 'vertex') {
        patch.title = form.title;
        patch.startAt = fromLocalInputValue(form.startAt);
        patch.endAt = fromLocalInputValue(form.endAt);
      } else {
        patch.departAt = fromLocalInputValue(form.startAt);
        patch.arriveAt = fromLocalInputValue(form.endAt);
        patch.mode = form.mode || null;
        patch.carrier = form.carrier || null;
        patch.bookingUrl = form.bookingUrl || null;
      }

      const res = await fetch(
        `/api/trips/${tripBookId}/variants/${variantId}/nodes/${originId}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ patch, expectedVersion }),
        },
      );
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `Save failed (${res.status})`);
      }
      toast.success('Saved');
      onChanged?.();
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (readOnly) return;
    setDeleting(true);
    try {
      const res = await fetch(
        `/api/trips/${tripBookId}/variants/${variantId}/nodes/${originId}`,
        { method: 'DELETE' },
      );
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `Delete failed (${res.status})`);
      }
      toast.success('Deleted');
      onChanged?.();
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete');
    } finally {
      setDeleting(false);
    }
  }

  const titleLabel =
    target.kind === 'vertex'
      ? labelForVertex(target.vertex)
      : 'Edit transport';

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{titleLabel}</SheetTitle>
          <SheetDescription>
            {target.kind === 'vertex'
              ? 'Update the title, timing, or notes.'
              : 'Update transport mode, schedule, and booking info.'}
          </SheetDescription>
        </SheetHeader>

        <div className="flex flex-1 flex-col gap-3 px-4">
          {target.kind === 'vertex' && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="panel-title">Title</Label>
              <Input
                id="panel-title"
                value={form.title}
                onChange={(e) =>
                  setForm((s) => ({ ...s, title: e.target.value }))
                }
                disabled={readOnly}
              />
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="panel-start">
                {target.kind === 'edge' ? 'Departs' : 'Start'}
              </Label>
              <Input
                id="panel-start"
                type="datetime-local"
                value={form.startAt}
                onChange={(e) =>
                  setForm((s) => ({ ...s, startAt: e.target.value }))
                }
                disabled={readOnly}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="panel-end">
                {target.kind === 'edge' ? 'Arrives' : 'End'}
              </Label>
              <Input
                id="panel-end"
                type="datetime-local"
                value={form.endAt}
                onChange={(e) =>
                  setForm((s) => ({ ...s, endAt: e.target.value }))
                }
                disabled={readOnly}
              />
            </div>
          </div>

          {target.kind === 'vertex' && address && (
            <div className="flex flex-col gap-1.5">
              <Label>Address</Label>
              <p className="rounded-lg border border-border bg-muted/40 px-2.5 py-1.5 text-sm text-muted-foreground">
                {address}
              </p>
            </div>
          )}

          {target.kind === 'edge' && form.kind === 'edge' && (
            <>
              <div className="flex flex-col gap-1.5">
                <Label>Mode</Label>
                <Select
                  value={form.mode || undefined}
                  onValueChange={(v) =>
                    setForm((s) =>
                      s.kind === 'edge'
                        ? { ...s, mode: v as TransportMode }
                        : s,
                    )
                  }
                  disabled={readOnly}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Select a mode" />
                  </SelectTrigger>
                  <SelectContent>
                    {TRANSPORT_MODES.map((m) => (
                      <SelectItem key={m} value={m} className="capitalize">
                        {m}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="panel-carrier">Carrier</Label>
                <Input
                  id="panel-carrier"
                  value={form.carrier}
                  onChange={(e) =>
                    setForm((s) =>
                      s.kind === 'edge'
                        ? { ...s, carrier: e.target.value }
                        : s,
                    )
                  }
                  placeholder="e.g. United, Amtrak"
                  disabled={readOnly}
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="panel-booking">Booking URL</Label>
                <Input
                  id="panel-booking"
                  value={form.bookingUrl}
                  type="url"
                  onChange={(e) =>
                    setForm((s) =>
                      s.kind === 'edge'
                        ? { ...s, bookingUrl: e.target.value }
                        : s,
                    )
                  }
                  placeholder="https://…"
                  disabled={readOnly}
                />
              </div>
            </>
          )}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="panel-notes">Notes</Label>
            <textarea
              id="panel-notes"
              value={form.notes}
              onChange={(e) =>
                setForm((s) => ({ ...s, notes: e.target.value }))
              }
              disabled={readOnly}
              rows={4}
              className={cn(
                'w-full rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm transition-colors outline-none',
                'placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50',
                'disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50',
                'dark:bg-input/30',
              )}
            />
          </div>
        </div>

        {!readOnly && (
          <SheetFooter className="flex-row justify-between gap-2">
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={saving || deleting}
            >
              {deleting ? 'Deleting…' : 'Delete'}
            </Button>
            <div className="flex gap-2">
              <Button
                variant="ghost"
                onClick={() => onOpenChange(false)}
                disabled={saving || deleting}
              >
                Cancel
              </Button>
              <Button onClick={handleSave} disabled={saving || deleting}>
                {saving ? 'Saving…' : 'Save'}
              </Button>
            </div>
          </SheetFooter>
        )}
      </SheetContent>
    </Sheet>
  );
}

function labelForVertex(v: Vertex): string {
  switch (v.type) {
    case 'destination':
      return 'Edit destination';
    case 'lodging':
      return 'Edit lodging';
    case 'activity':
      return 'Edit activity';
    case 'meal':
      return 'Edit meal';
    default:
      return 'Edit place';
  }
}
