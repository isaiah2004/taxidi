/**
 * Pure projections + DB-backed loaders for the Taxidi trip graph.
 *
 * The trip is stored as a hierarchy of `node` rows (Trip -> Day -> child) inside
 * a per-user `variant`, plus an append-only `main_version.snapshot` JSONB
 * canonical history. This module turns either representation into a
 * `TripGraph` shape that the UI / agents can consume:
 *
 *   - vertices  : place-like nodes (destination, lodging, activity, meal)
 *   - edges     : transport rows projected as edges from `typeData.from_origin_id`
 *                 to `typeData.to_origin_id`
 *   - days      : day grouping rows (used by the timeline UI)
 *   - tripOriginId : the originId of the single Trip-type root node, if any
 *
 * All functions in this module that operate on snapshots / row arrays are
 * intentionally pure (no DB I/O) so they can be tested in isolation. The two
 * `loadXxxGraph` helpers wrap them with a DB read.
 */
import { and, eq } from 'drizzle-orm';

import * as schema from '@/db/schema';
import { db } from '@/lib/db';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type GraphLocation = {
  placeId: string;
  lat: number;
  lng: number;
  address: string;
};

export type Vertex = {
  originId: string;
  type: 'destination' | 'lodging' | 'activity' | 'meal';
  title: string;
  notes: string | null;
  startAt: string | null; // ISO string
  endAt: string | null;
  location: GraphLocation | null;
  dayOriginId: string | null;
  typeData: Record<string, unknown>;
  version: number;
  sortIndex: number;
};

export type TransportMode =
  | 'flight'
  | 'train'
  | 'bus'
  | 'car'
  | 'ferry'
  | 'walk';

export type GraphEdge = {
  originId: string; // origin_id of the transport node
  sourceOriginId: string; // typeData.from_origin_id
  targetOriginId: string; // typeData.to_origin_id
  mode: TransportMode;
  departAt: string | null;
  arriveAt: string | null;
  carrier: string | null;
  bookingUrl: string | null;
  notes: string | null;
  version: number;
};

export type DayVertex = {
  originId: string;
  date: string | null;
  sortIndex: number;
  title: string;
};

export type TripGraph = {
  vertices: Vertex[];
  edges: GraphEdge[];
  days: DayVertex[];
  tripOriginId: string | null;
};

/**
 * The serialized node shape used inside `main_version.snapshot` JSONB. We
 * store snapshots in a parent-by-origin-id form so they remain stable when
 * variants get re-materialized with brand-new `node.id` UUIDs.
 */
export type SerializedNode = {
  originId: string;
  type: string;
  parentOriginId: string | null;
  sortIndex: number;
  title: string;
  notes: string | null;
  startAt: string | null;
  endAt: string | null;
  location: GraphLocation | null;
  typeData: Record<string, unknown>;
  version: number;
};

export type SerializedSnapshot = { nodes: SerializedNode[] };

/**
 * Drizzle row-like shape for a `node` row. Aliased to the inferred schema type
 * so callers passing rows from `db.select().from(node)` line up exactly.
 */
export type NodeRowLike = schema.Node;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const VERTEX_TYPES = new Set<Vertex['type']>([
  'destination',
  'lodging',
  'activity',
  'meal',
]);

const TRANSPORT_MODES = new Set<TransportMode>([
  'flight',
  'train',
  'bus',
  'car',
  'ferry',
  'walk',
]);

function toIso(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  // Already an ISO string (snapshot path) — trust the storage shape.
  return value;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function isVertexType(type: string): type is Vertex['type'] {
  return VERTEX_TYPES.has(type as Vertex['type']);
}

function asTransportMode(value: unknown): TransportMode {
  if (typeof value === 'string' && TRANSPORT_MODES.has(value as TransportMode)) {
    return value as TransportMode;
  }
  // Default: 'car' — least-presumptuous mode for unknown / missing values.
  return 'car';
}

function asNullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Build a `GraphLocation` from a row's location columns, or `null` when the
 * row has no resolved place. We require at least `placeId` plus numeric
 * lat/lng — a partially-filled location is treated as unresolved.
 */
function locationFromRow(row: NodeRowLike): GraphLocation | null {
  if (
    !row.locationPlaceId ||
    typeof row.locationLat !== 'number' ||
    typeof row.locationLng !== 'number'
  ) {
    return null;
  }
  return {
    placeId: row.locationPlaceId,
    lat: row.locationLat,
    lng: row.locationLng,
    address: row.locationAddress ?? '',
  };
}

/**
 * Build a serialized vertex from a serialized snapshot node. Caller is
 * responsible for filtering by node type (vertex vs day vs transport).
 */
function vertexFromSerialized(
  node: SerializedNode,
  dayOriginId: string | null,
): Vertex | null {
  if (!isVertexType(node.type)) return null;
  return {
    originId: node.originId,
    type: node.type,
    title: node.title,
    notes: node.notes,
    startAt: node.startAt,
    endAt: node.endAt,
    location: node.location,
    dayOriginId,
    typeData: { ...node.typeData },
    version: node.version,
    sortIndex: node.sortIndex,
  };
}

function vertexFromRow(
  row: NodeRowLike,
  dayOriginId: string | null,
): Vertex | null {
  if (!isVertexType(row.type)) return null;
  return {
    originId: row.originId,
    type: row.type,
    title: row.title,
    notes: row.notes,
    startAt: toIso(row.startAt),
    endAt: toIso(row.endAt),
    location: locationFromRow(row),
    dayOriginId,
    typeData: asRecord(row.typeData),
    version: row.version,
    sortIndex: row.sortIndex,
  };
}

function edgeFromTypeData(
  originId: string,
  typeData: Record<string, unknown>,
  version: number,
  fallback: { startAt: string | null; endAt: string | null; notes: string | null },
): GraphEdge | null {
  const sourceOriginId = asNullableString(typeData.from_origin_id);
  const targetOriginId = asNullableString(typeData.to_origin_id);
  if (!sourceOriginId || !targetOriginId) return null;

  const departAt =
    asNullableString(typeData.depart_at) ?? fallback.startAt;
  const arriveAt =
    asNullableString(typeData.arrive_at) ?? fallback.endAt;
  const carrier = asNullableString(typeData.carrier);
  const bookingUrl = asNullableString(typeData.booking_url);

  return {
    originId,
    sourceOriginId,
    targetOriginId,
    mode: asTransportMode(typeData.mode),
    departAt,
    arriveAt,
    carrier,
    bookingUrl,
    notes: fallback.notes,
    version,
  };
}

function dayFromSerialized(node: SerializedNode): DayVertex {
  const dateFromTypeData = asNullableString(node.typeData.date);
  return {
    originId: node.originId,
    date: dateFromTypeData ?? node.startAt,
    sortIndex: node.sortIndex,
    title: node.title,
  };
}

function dayFromRow(row: NodeRowLike): DayVertex {
  const td = asRecord(row.typeData);
  const dateFromTypeData = asNullableString(td.date);
  return {
    originId: row.originId,
    date: dateFromTypeData ?? toIso(row.startAt),
    sortIndex: row.sortIndex,
    title: row.title,
  };
}

// ---------------------------------------------------------------------------
// Pure projections
// ---------------------------------------------------------------------------

/**
 * Project a `SerializedSnapshot` (the JSONB stored inside `main_version`) into
 * a `TripGraph`. Pure: no DB I/O, no allocations on disk.
 */
export function snapshotToGraph(snapshot: SerializedSnapshot): TripGraph {
  const vertices: Vertex[] = [];
  const edges: GraphEdge[] = [];
  const days: DayVertex[] = [];
  let tripOriginId: string | null = null;

  // Build a lookup so vertex rows can find their parent's type / originId.
  const byOriginId = new Map<string, SerializedNode>();
  for (const n of snapshot.nodes) byOriginId.set(n.originId, n);

  for (const node of snapshot.nodes) {
    if (node.type === 'trip') {
      tripOriginId = node.originId;
      continue;
    }
    if (node.type === 'day') {
      days.push(dayFromSerialized(node));
      continue;
    }
    if (node.type === 'transport') {
      const edge = edgeFromTypeData(
        node.originId,
        node.typeData,
        node.version,
        {
          startAt: node.startAt,
          endAt: node.endAt,
          notes: node.notes,
        },
      );
      if (edge) edges.push(edge);
      continue;
    }
    // Vertex types — resolve dayOriginId by walking up to the nearest 'day'
    // ancestor (typically the immediate parent, but be defensive for nested
    // wrappers we may add later).
    let dayOriginId: string | null = null;
    let cursor = node.parentOriginId;
    while (cursor) {
      const parent = byOriginId.get(cursor);
      if (!parent) break;
      if (parent.type === 'day') {
        dayOriginId = parent.originId;
        break;
      }
      cursor = parent.parentOriginId;
    }
    const v = vertexFromSerialized(node, dayOriginId);
    if (v) vertices.push(v);
  }

  return { vertices, edges, days, tripOriginId };
}

/**
 * Project an array of Drizzle `node` rows (already filtered by `deleted=false`
 * if desired — this function will also filter them as a safety net) into a
 * `TripGraph`. Pure: no DB I/O.
 */
export function nodesToGraph(rows: NodeRowLike[]): TripGraph {
  const live = rows.filter((r) => !r.deleted);

  // Map node.id -> row, so we can resolve `parentNodeId` references. Built
  // once up front so the dayOriginId walk below is O(n) overall (each
  // ancestor is a single map lookup); per-row we never re-scan `live`.
  const byId = new Map<string, NodeRowLike>();
  for (const r of live) byId.set(r.id, r);

  const vertices: Vertex[] = [];
  const edges: GraphEdge[] = [];
  const days: DayVertex[] = [];
  let tripOriginId: string | null = null;

  for (const row of live) {
    if (row.type === 'trip') {
      tripOriginId = row.originId;
      continue;
    }
    if (row.type === 'day') {
      days.push(dayFromRow(row));
      continue;
    }
    if (row.type === 'transport') {
      const edge = edgeFromTypeData(
        row.originId,
        asRecord(row.typeData),
        row.version,
        {
          startAt: toIso(row.startAt),
          endAt: toIso(row.endAt),
          notes: row.notes,
        },
      );
      if (edge) edges.push(edge);
      continue;
    }

    // Resolve dayOriginId by walking parentNodeId chain.
    let dayOriginId: string | null = null;
    let cursor = row.parentNodeId;
    while (cursor) {
      const parent = byId.get(cursor);
      if (!parent) break;
      if (parent.type === 'day') {
        dayOriginId = parent.originId;
        break;
      }
      cursor = parent.parentNodeId;
    }
    const v = vertexFromRow(row, dayOriginId);
    if (v) vertices.push(v);
  }

  return { vertices, edges, days, tripOriginId };
}

/**
 * Convert a Drizzle `node` row to the storage-friendly serialized shape used
 * inside `main_version.snapshot`. The caller passes a `Map<nodeId, parentOriginId>`
 * so we can resolve the parent pointer without a follow-up DB lookup.
 */
export function nodeRowToSerialized(
  row: NodeRowLike,
  parentOriginIdByNodeId: Map<string, string | null>,
): SerializedNode {
  const parentOriginId = row.parentNodeId
    ? parentOriginIdByNodeId.get(row.parentNodeId) ?? null
    : null;
  return {
    originId: row.originId,
    type: row.type,
    parentOriginId,
    sortIndex: row.sortIndex,
    title: row.title,
    notes: row.notes,
    startAt: toIso(row.startAt),
    endAt: toIso(row.endAt),
    location: locationFromRow(row),
    typeData: asRecord(row.typeData),
    version: row.version,
  };
}

// ---------------------------------------------------------------------------
// DB-backed loaders
// ---------------------------------------------------------------------------

/**
 * Load all live (`deleted=false`) node rows for the given variant and project
 * them into a `TripGraph`.
 */
export async function loadVariantGraph(variantId: string): Promise<TripGraph> {
  const rows = await db
    .select()
    .from(schema.node)
    .where(
      and(eq(schema.node.variantId, variantId), eq(schema.node.deleted, false)),
    );
  return nodesToGraph(rows);
}

/**
 * Load the current main snapshot for a trip book and project it into a
 * `TripGraph`. If the trip book has no committed main version yet (or the
 * pointer is dangling), return an empty graph.
 */
export async function loadMainGraph(tripBookId: string): Promise<TripGraph> {
  const [tb] = await db
    .select({ currentMainVersionId: schema.tripBook.currentMainVersionId })
    .from(schema.tripBook)
    .where(eq(schema.tripBook.id, tripBookId))
    .limit(1);

  if (!tb?.currentMainVersionId) {
    return { vertices: [], edges: [], days: [], tripOriginId: null };
  }

  const [mv] = await db
    .select({ snapshot: schema.mainVersion.snapshot })
    .from(schema.mainVersion)
    .where(eq(schema.mainVersion.id, tb.currentMainVersionId))
    .limit(1);

  if (!mv) {
    return { vertices: [], edges: [], days: [], tripOriginId: null };
  }

  const snapshot = mv.snapshot as SerializedSnapshot;
  // Defensive: an empty / malformed snapshot is treated as "no nodes".
  if (!snapshot || !Array.isArray(snapshot.nodes)) {
    return { vertices: [], edges: [], days: [], tripOriginId: null };
  }
  return snapshotToGraph(snapshot);
}
