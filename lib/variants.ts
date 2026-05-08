/**
 * Per-user variant management. Each member of a trip-book gets one variant
 * (UNIQUE on `(trip_book_id, owner_user_id)`); when none exists yet, this
 * module materializes the trip-book's current main snapshot into fresh
 * `node` rows preserving every `origin_id` so diffs match across variants.
 *
 * Public API:
 *   - `getOrCreateVariantForUser`  - lazy: creates the variant + nodes if missing
 *   - `getVariantForUser`          - read-only lookup
 *   - `isOwner`                    - cheap owner check on `trip_book.ownerUserId`
 *
 * Caller is responsible for membership / authn checks (see `lib/auth.ts`); we
 * never grant access here.
 */
import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';

import * as schema from '@/db/schema';
import { db } from '@/lib/db';
import type {
  GraphLocation,
  SerializedNode,
  SerializedSnapshot,
} from '@/lib/graph';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type VariantSummary = {
  id: string;
  tripBookId: string;
  ownerUserId: string;
  baseMainVersionId: string;
  status: 'draft' | 'proposed' | 'merged' | 'rejected' | 'stale';
  /** True iff this call materialized the variant; false when it pre-existed. */
  created: boolean;
};

/**
 * A row ready to insert into `node` for materialization. `id` is generated up
 * front so we can build the parent-pointer rewiring map before any DB I/O.
 */
type MaterializedNodeRow = {
  id: string;
  variantId: string;
  originId: string;
  type: schema.NodeType;
  parentNodeId: string | null;
  sortIndex: number;
  title: string;
  notes: string | null;
  startAt: Date | null;
  endAt: Date | null;
  locationPlaceId: string | null;
  locationLat: number | null;
  locationLng: number | null;
  locationAddress: string | null;
  typeData: Record<string, unknown>;
  version: number;
};

// ---------------------------------------------------------------------------
// Pure helpers (exported under `_` prefix so tests can reach them without
// promising public stability)
// ---------------------------------------------------------------------------

const NODE_TYPES: ReadonlySet<schema.NodeType> = new Set<schema.NodeType>([
  'trip',
  'day',
  'destination',
  'transport',
  'lodging',
  'activity',
  'meal',
  'note',
]);

function asNodeType(value: string): schema.NodeType {
  if (NODE_TYPES.has(value as schema.NodeType)) {
    return value as schema.NodeType;
  }
  // Falling back to 'note' is the safest no-op container: it's a leaf type
  // with no constraints. Production data should never hit this path.
  return 'note';
}

function parseDate(value: string | null): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function locationFromSerialized(
  loc: GraphLocation | null,
): Pick<
  MaterializedNodeRow,
  'locationPlaceId' | 'locationLat' | 'locationLng' | 'locationAddress'
> {
  if (!loc) {
    return {
      locationPlaceId: null,
      locationLat: null,
      locationLng: null,
      locationAddress: null,
    };
  }
  return {
    locationPlaceId: loc.placeId,
    locationLat: loc.lat,
    locationLng: loc.lng,
    locationAddress: loc.address,
  };
}

/**
 * Pure transform: given a `SerializedSnapshot` and the target `variantId`,
 * produce node rows ready to insert. Each row gets a freshly-minted `id`; the
 * `parentNodeId` pointer is resolved by chasing `parentOriginId -> originId ->
 * id` through a single map built in this function.
 *
 * Two-pass so that out-of-order parents don't break the lookup: pass one
 * mints ids and indexes them by `originId`; pass two stitches up parent ids.
 *
 * Exported with the `_` prefix so it's reachable from unit tests without
 * leaking into the documented public API.
 */
export function _materializePure(
  snapshot: SerializedSnapshot,
  variantId: string,
): MaterializedNodeRow[] {
  // Pass 1: build originId -> generated id map.
  const idByOriginId = new Map<string, string>();
  for (const node of snapshot.nodes) {
    if (!node.originId) continue;
    if (!idByOriginId.has(node.originId)) {
      idByOriginId.set(node.originId, randomUUID());
    }
  }

  // Pass 2: produce rows with rewired parent pointers.
  const rows: MaterializedNodeRow[] = [];
  for (const node of snapshot.nodes) {
    const id = idByOriginId.get(node.originId);
    if (!id) continue; // node missing originId - skip (snapshots must have ids)

    const parentNodeId = node.parentOriginId
      ? idByOriginId.get(node.parentOriginId) ?? null
      : null;

    rows.push({
      id,
      variantId,
      originId: node.originId,
      type: asNodeType(node.type),
      parentNodeId,
      sortIndex: node.sortIndex,
      title: node.title,
      notes: node.notes,
      startAt: parseDate(node.startAt),
      endAt: parseDate(node.endAt),
      ...locationFromSerialized(node.location),
      typeData: node.typeData,
      version: node.version,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function isOwner(
  tripBookId: string,
  userId: string,
): Promise<boolean> {
  const [tb] = await db
    .select({ ownerUserId: schema.tripBook.ownerUserId })
    .from(schema.tripBook)
    .where(eq(schema.tripBook.id, tripBookId))
    .limit(1);
  return tb?.ownerUserId === userId;
}

export async function getVariantForUser(
  tripBookId: string,
  userId: string,
): Promise<VariantSummary | null> {
  const [row] = await db
    .select()
    .from(schema.variant)
    .where(
      and(
        eq(schema.variant.tripBookId, tripBookId),
        eq(schema.variant.ownerUserId, userId),
      ),
    )
    .limit(1);
  if (!row) return null;
  return {
    id: row.id,
    tripBookId: row.tripBookId,
    ownerUserId: row.ownerUserId,
    baseMainVersionId: row.baseMainVersionId,
    status: row.status,
    created: false,
  };
}

/**
 * Returns the user's variant for this trip book. If none exists, materializes
 * the current main snapshot into node rows preserving every origin_id, in a
 * single transaction. Throws if the trip book has no committed `currentMainVersionId`
 * (the API layer should never let that happen — main is created on tripBook
 * creation).
 *
 * Does NOT promote membership; callers must call `requireMembership` first.
 */
export async function getOrCreateVariantForUser(
  tripBookId: string,
  userId: string,
): Promise<VariantSummary> {
  // Fast path: variant already exists. This is the overwhelmingly common case
  // so we run it outside any transaction (no contention, single indexed read).
  const existing = await getVariantForUser(tripBookId, userId);
  if (existing) return existing;

  return await db.transaction(async (tx) => {
    // Re-check under the transaction in case two requests raced.
    const [maybe] = await tx
      .select()
      .from(schema.variant)
      .where(
        and(
          eq(schema.variant.tripBookId, tripBookId),
          eq(schema.variant.ownerUserId, userId),
        ),
      )
      .limit(1);
    if (maybe) {
      return {
        id: maybe.id,
        tripBookId: maybe.tripBookId,
        ownerUserId: maybe.ownerUserId,
        baseMainVersionId: maybe.baseMainVersionId,
        status: maybe.status,
        created: false,
      };
    }

    const [tb] = await tx
      .select({
        currentMainVersionId: schema.tripBook.currentMainVersionId,
      })
      .from(schema.tripBook)
      .where(eq(schema.tripBook.id, tripBookId))
      .limit(1);

    if (!tb?.currentMainVersionId) {
      throw new Error(
        `tripBook ${tripBookId} has no currentMainVersionId; cannot create variant`,
      );
    }

    const [mv] = await tx
      .select({ snapshot: schema.mainVersion.snapshot })
      .from(schema.mainVersion)
      .where(eq(schema.mainVersion.id, tb.currentMainVersionId))
      .limit(1);

    if (!mv) {
      throw new Error(
        `mainVersion ${tb.currentMainVersionId} not found; tripBook pointer is dangling`,
      );
    }

    const snapshot: SerializedSnapshot =
      mv.snapshot && Array.isArray((mv.snapshot as SerializedSnapshot).nodes)
        ? (mv.snapshot as SerializedSnapshot)
        : { nodes: [] };

    const [variantRow] = await tx
      .insert(schema.variant)
      .values({
        tripBookId,
        ownerUserId: userId,
        baseMainVersionId: tb.currentMainVersionId,
        status: 'draft',
      })
      .returning();

    if (!variantRow) {
      throw new Error('Failed to insert variant row');
    }

    const rows = _materializePure(snapshot, variantRow.id);
    if (rows.length > 0) {
      // Cast to NewNode[] is safe: every required column is present in
      // MaterializedNodeRow; nullable columns are explicitly null.
      await tx.insert(schema.node).values(rows satisfies SerializedToNewNode);
    }

    return {
      id: variantRow.id,
      tripBookId: variantRow.tripBookId,
      ownerUserId: variantRow.ownerUserId,
      baseMainVersionId: variantRow.baseMainVersionId,
      status: variantRow.status,
      created: true,
    };
  });
}

// Compile-time guard: MaterializedNodeRow must be insertable into `node`.
// Drizzle's NewNode allows extra columns it'll default; the guard checks our
// shape covers every required field by attempting to assign.
type SerializedToNewNode = readonly schema.NewNode[];
