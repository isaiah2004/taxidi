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

/**
 * Format a positive duration in seconds as a compact human string:
 *   - 4500 -> "1h 15m"
 *   - 2700 -> "45m"
 *   - 30   -> "30s" (we keep seconds for tiny intra-city walks)
 */
function formatDurationSeconds(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return rem === 0 ? `${hours}h` : `${hours}h ${rem}m`;
}

/**
 * Format a non-negative distance in meters. Below 1km we render meters,
 * otherwise kilometers with a thousands separator and no decimals.
 */
function formatKm(meters: number): string {
  if (!Number.isFinite(meters) || meters < 0) return '';
  if (meters < 1000) return `${Math.round(meters)} m`;
  const km = Math.round(meters / 1000);
  return `${km.toLocaleString()} km`;
}

function formatDurationFromTimestamps(
  departAt: string | null | undefined,
  arriveAt: string | null | undefined,
): string | null {
  if (!departAt || !arriveAt) return null;
  const start = new Date(departAt).getTime();
  const end = new Date(arriveAt).getTime();
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return null;
  return formatDurationSeconds((end - start) / 1000);
}

/** Data payload we attach to React Flow edges. */
export type TransportEdgeData = {
  edge: GraphEdge;
  /** Optional Routes-API-derived duration in seconds (from transport typeData). */
  durationSeconds?: number;
  /** Optional Routes-API-derived distance in meters. */
  distanceMeters?: number;
  /** Optional encoded polyline string for map rendering. */
  encodedPolyline?: string | null;
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

  // Routes-API enrichment: stored either on the typed `data` payload, or — as
  // the edge graph is built today — folded into the underlying transport
  // node's `typeData`. We accept both shapes so the surface works no matter
  // which projection wired the values through.
  const edgeTypeData = (edge as unknown as { typeData?: Record<string, unknown> })
    ?.typeData;
  const rawDurationSeconds =
    typeof data?.durationSeconds === 'number'
      ? data.durationSeconds
      : typeof edgeTypeData?.durationSeconds === 'number'
        ? edgeTypeData.durationSeconds
        : typeof edgeTypeData?.duration_seconds === 'number'
          ? edgeTypeData.duration_seconds
          : null;
  const rawDistanceMeters =
    typeof data?.distanceMeters === 'number'
      ? data.distanceMeters
      : typeof edgeTypeData?.distanceMeters === 'number'
        ? edgeTypeData.distanceMeters
        : typeof edgeTypeData?.distance_meters === 'number'
          ? edgeTypeData.distance_meters
          : null;

  const durationStr =
    rawDurationSeconds !== null
      ? formatDurationSeconds(rawDurationSeconds)
      : formatDurationFromTimestamps(edge?.departAt, edge?.arriveAt);
  const distanceStr =
    rawDistanceMeters !== null ? formatKm(rawDistanceMeters) : null;

  const labelParts: string[] = [];
  if (mode) labelParts.push(mode);
  if (durationStr) labelParts.push(durationStr);
  if (distanceStr) labelParts.push(distanceStr);
  const label = labelParts.join(' · ');

  const ariaLabel = [
    `${mode ?? 'transport'} (transport)`,
    durationStr ? `lasting ${durationStr}` : null,
    distanceStr ? `for ${distanceStr}` : null,
    edge?.carrier ? `via ${edge.carrier}` : null,
  ]
    .filter(Boolean)
    .join(' ');

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
          role="button"
          aria-label={ariaLabel}
          aria-selected={selected || undefined}
          className="flex items-center gap-1 rounded-full border border-border bg-background px-2 py-0.5 text-[10px] font-medium text-foreground shadow-sm"
        >
          <Icon className="h-3 w-3" aria-hidden="true" />
          {label && <span className="capitalize">{label}</span>}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

export const TransportEdge = memo(TransportEdgeImpl);
