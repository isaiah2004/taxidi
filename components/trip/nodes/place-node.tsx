'use client';

/**
 * PlaceNode — generic React Flow custom node renderer for any place-like
 * vertex (destination, lodging, activity, meal). Visual differs by `data.vertex.type`
 * via a swapped lucide icon; the structure stays identical so the graph layout
 * dagre code can rely on a uniform 180×80 box.
 *
 * The component is registered four times in `<GraphTab />`'s `nodeTypes` map
 * (one entry per place-type enum member), so React Flow can route renders by
 * the React Flow node `type` field (which we set from `vertex.type`).
 */

import { memo } from 'react';
import {
  Handle,
  Position,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import { MapPin, Bed, Star, UtensilsCrossed } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { Vertex } from '@/lib/graph';
import { cn } from '@/lib/utils';

const ICONS: Record<Vertex['type'], LucideIcon> = {
  destination: MapPin,
  lodging: Bed,
  activity: Star,
  meal: UtensilsCrossed,
};

/** Node data shape for React Flow — wraps a Vertex inside a Record container. */
export type PlaceNodeData = {
  vertex: Vertex;
} & Record<string, unknown>;

export type PlaceNodeType = Node<PlaceNodeData, Vertex['type']>;

function formatTimeRange(
  startAt: string | null | undefined,
  endAt: string | null | undefined,
): string | null {
  const start = startAt ? new Date(startAt) : null;
  const end = endAt ? new Date(endAt) : null;
  if (!start && !end) return null;

  const fmt = (d: Date) =>
    d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

  if (start && end) return `${fmt(start)} – ${fmt(end)}`;
  if (start) return fmt(start);
  if (end) return `until ${fmt(end)}`;
  return null;
}

function PlaceNodeImpl({ data, selected }: NodeProps<PlaceNodeType>) {
  const vertex = data.vertex;
  const Icon = ICONS[vertex.type] ?? MapPin;
  const time = formatTimeRange(vertex.startAt, vertex.endAt);

  return (
    <div
      className={cn(
        'flex h-[80px] w-[180px] flex-col gap-1 rounded-lg border bg-card p-2 text-card-foreground shadow-sm transition-shadow',
        selected
          ? 'border-primary ring-2 ring-primary/30'
          : 'border-border hover:shadow-md',
      )}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!h-2 !w-2 !border-border !bg-background"
      />
      <div className="flex items-center gap-1.5">
        <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate text-xs font-medium">{vertex.title}</span>
      </div>
      {time && (
        <span className="truncate text-[10px] text-muted-foreground">
          {time}
        </span>
      )}
      {vertex.location?.address && (
        <span className="truncate text-[10px] text-muted-foreground">
          {vertex.location.address}
        </span>
      )}
      <Handle
        type="source"
        position={Position.Right}
        className="!h-2 !w-2 !border-border !bg-background"
      />
    </div>
  );
}

export const PlaceNode = memo(PlaceNodeImpl);
