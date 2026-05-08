'use client';

/**
 * TransportEdge — React Flow custom edge that renders a smooth-step path
 * between two place nodes plus a label badge with a mode icon (Plane/Train/
 * Bus/Car/Ship/Footprints) and an optional duration string.
 *
 * Registered as `edgeTypes.transport` in `<GraphTab />`. The `data` payload
 * carries the full `GraphEdge` so the badge can render mode + carrier info
 * without hitting the data store again.
 */

import { memo } from 'react';
import {
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath,
  type EdgeProps,
  type Edge,
} from '@xyflow/react';
import { Plane, Train, Bus, Car, Ship, Footprints } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { GraphEdge, TransportMode } from '@/lib/graph';

const MODE_ICONS: Record<TransportMode, LucideIcon> = {
  flight: Plane,
  train: Train,
  bus: Bus,
  car: Car,
  ferry: Ship,
  walk: Footprints,
};

function formatDuration(
  departAt: string | null | undefined,
  arriveAt: string | null | undefined,
): string | null {
  if (!departAt || !arriveAt) return null;
  const start = new Date(departAt).getTime();
  const end = new Date(arriveAt).getTime();
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return null;
  const minutes = Math.round((end - start) / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return rem === 0 ? `${hours}h` : `${hours}h ${rem}m`;
}

/** Data payload we attach to React Flow edges. */
export type TransportEdgeData = {
  edge: GraphEdge;
} & Record<string, unknown>;

export type TransportEdgeType = Edge<TransportEdgeData, 'transport'>;

function TransportEdgeImpl({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  markerEnd,
  style,
  selected,
}: EdgeProps<TransportEdgeType>) {
  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  const edge = data?.edge;
  const mode = edge?.mode;
  const Icon = mode ? MODE_ICONS[mode] : Car;
  const duration = formatDuration(edge?.departAt, edge?.arriveAt);
  const label = mode
    ? duration
      ? `${mode} · ${duration}`
      : mode
    : duration ?? '';

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={{
          strokeWidth: selected ? 2 : 1.5,
          stroke: selected ? 'var(--primary)' : 'var(--muted-foreground)',
          ...style,
        }}
      />
      <EdgeLabelRenderer>
        <div
          style={{
            position: 'absolute',
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            pointerEvents: 'all',
          }}
          className="flex items-center gap-1 rounded-full border border-border bg-background px-2 py-0.5 text-[10px] font-medium text-foreground shadow-sm"
        >
          <Icon className="h-3 w-3" />
          {label && <span className="capitalize">{label}</span>}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

export const TransportEdge = memo(TransportEdgeImpl);
