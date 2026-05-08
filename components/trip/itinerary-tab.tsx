'use client';

/**
 * ItineraryTab — flat day-by-day list of the trip. Each `DayVertex` is a
 * card; vertices that belong to the day are listed in `sortIndex` order, and
 * any transport edge that originates at one of those vertices is rendered
 * inline below the source so the user can see the journey legs in context.
 *
 * Vertices that have no `dayOriginId` (e.g. trip-level destinations or items
 * the agent hasn't slotted into a day yet) bubble up into a synthetic
 * "Unscheduled" group at the bottom.
 */

import { Fragment, useMemo } from 'react';
import { Plane, Train, Bus, Car, Ship, Footprints } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import type {
  DayVertex,
  GraphEdge,
  TransportMode,
  TripGraph,
  Vertex,
} from '@/lib/graph';

const MODE_ICONS: Record<TransportMode, LucideIcon> = {
  flight: Plane,
  train: Train,
  bus: Bus,
  car: Car,
  ferry: Ship,
  walk: Footprints,
};

export interface ItineraryTabProps {
  graph: TripGraph | null;
  onVertexClick?: (vertex: Vertex) => void;
  onEdgeClick?: (edge: GraphEdge) => void;
}

interface DayBucket {
  day: DayVertex | null;
  vertices: Vertex[];
}

function compareDays(a: DayVertex, b: DayVertex): number {
  const aDate = a.date ? new Date(a.date).getTime() : Number.MAX_SAFE_INTEGER;
  const bDate = b.date ? new Date(b.date).getTime() : Number.MAX_SAFE_INTEGER;
  if (aDate !== bDate) return aDate - bDate;
  return (a.sortIndex ?? 0) - (b.sortIndex ?? 0);
}

function compareWithinDay(a: Vertex, b: Vertex): number {
  if ((a.sortIndex ?? 0) !== (b.sortIndex ?? 0)) {
    return (a.sortIndex ?? 0) - (b.sortIndex ?? 0);
  }
  const aTime = a.startAt ? new Date(a.startAt).getTime() : Number.MAX_SAFE_INTEGER;
  const bTime = b.startAt ? new Date(b.startAt).getTime() : Number.MAX_SAFE_INTEGER;
  return aTime - bTime;
}

function formatDayHeader(day: DayVertex | null, fallback: string): string {
  if (!day) return fallback;
  if (day.title) return day.title;
  if (day.date) {
    return new Date(day.date).toLocaleDateString(undefined, {
      weekday: 'long',
      month: 'short',
      day: 'numeric',
    });
  }
  return fallback;
}

function formatTime(value: string | null | undefined): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function formatTimeRange(
  start: string | null | undefined,
  end: string | null | undefined,
): string | null {
  const a = formatTime(start);
  const b = formatTime(end);
  if (a && b) return `${a} – ${b}`;
  return a ?? b ?? null;
}

export function ItineraryTab({
  graph,
  onVertexClick,
  onEdgeClick,
}: ItineraryTabProps) {
  const buckets = useMemo<DayBucket[]>(() => {
    if (!graph) return [];

    const days = [...graph.days].sort(compareDays);
    const items = graph.vertices;

    const byDay = new Map<string, Vertex[]>();
    const unscheduled: Vertex[] = [];
    for (const v of items) {
      if (v.dayOriginId) {
        const list = byDay.get(v.dayOriginId) ?? [];
        list.push(v);
        byDay.set(v.dayOriginId, list);
      } else {
        unscheduled.push(v);
      }
    }

    const result: DayBucket[] = days.map((d) => ({
      day: d,
      vertices: (byDay.get(d.originId) ?? []).slice().sort(compareWithinDay),
    }));

    if (unscheduled.length > 0) {
      result.push({
        day: null,
        vertices: unscheduled.slice().sort(compareWithinDay),
      });
    }
    return result;
  }, [graph]);

  const edgesBySource = useMemo(() => {
    const map = new Map<string, GraphEdge[]>();
    if (!graph) return map;
    for (const e of graph.edges) {
      const list = map.get(e.sourceOriginId) ?? [];
      list.push(e);
      map.set(e.sourceOriginId, list);
    }
    return map;
  }, [graph]);

  if (!graph || buckets.length === 0) {
    return (
      <div className="flex h-full min-h-[400px] items-center justify-center rounded-lg border border-dashed border-border bg-background/40 text-sm text-muted-foreground">
        Nothing scheduled yet.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {buckets.map((bucket, idx) => (
        <Card key={bucket.day?.originId ?? `unscheduled-${idx}`}>
          <CardHeader>
            <CardTitle>
              {formatDayHeader(bucket.day, 'Unscheduled')}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {bucket.vertices.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No items for this day.
              </p>
            ) : (
              <ol className="flex flex-col gap-2">
                {bucket.vertices.map((v) => {
                  const time = formatTimeRange(v.startAt, v.endAt);
                  const outgoing = edgesBySource.get(v.originId) ?? [];
                  return (
                    <Fragment key={v.originId}>
                      <li>
                        <button
                          type="button"
                          onClick={() => onVertexClick?.(v)}
                          className="flex w-full flex-col gap-0.5 rounded-md border border-border bg-background px-3 py-2 text-left transition-colors hover:bg-muted"
                        >
                          <span className="flex items-center justify-between gap-2">
                            <span className="font-medium">{v.title}</span>
                            {time && (
                              <span className="text-xs text-muted-foreground">
                                {time}
                              </span>
                            )}
                          </span>
                          {v.location?.address && (
                            <span className="text-xs text-muted-foreground">
                              {v.location.address}
                            </span>
                          )}
                        </button>
                      </li>
                      {outgoing.map((e) => {
                        const Icon = MODE_ICONS[e.mode] ?? Car;
                        return (
                          <li key={e.originId} className="pl-6">
                            <button
                              type="button"
                              onClick={() => onEdgeClick?.(e)}
                              className="flex items-center gap-2 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                            >
                              <Icon className="h-3.5 w-3.5" />
                              <span className="capitalize">{e.mode}</span>
                              {e.carrier && <span>· {e.carrier}</span>}
                            </button>
                          </li>
                        );
                      })}
                    </Fragment>
                  );
                })}
              </ol>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
