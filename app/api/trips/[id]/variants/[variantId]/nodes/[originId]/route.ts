/**
 * Per-node mutation endpoints (variant-scoped).
 *
 *   PATCH  -> partial update with optimistic concurrency on `version`. The
 *             write goes through a `version = $expectedVersion` predicate; a
 *             zero-row update means the client raced another writer and gets
 *             a 409.
 *   DELETE -> soft delete (`deleted = true`) plus a version bump so listeners
 *             that are caching the row know it changed.
 *
 * Auth: variant owner only — owners editing the main plan still mutate their
 * *own* variant; main itself is only changed via merge.
 */
import { and, eq, sql } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import {
  ForbiddenError,
  UnauthenticatedError,
  getCurrentUserId,
  requireMembership,
} from '@/lib/auth';
import { db } from '@/lib/db';
import {
  node as nodeTable,
  variant as variantTable,
  type Node as NodeRow,
} from '@/db/schema';
import { geocodeAddress } from '@/lib/places';
import { safeBroadcastToVariant } from '@/lib/realtime';
import { getOrCreateVariantForUser } from '@/lib/variants';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const TripBookIdSchema = z.uuid();
const VariantIdParamSchema = z.union([z.literal('mine'), z.uuid()]);
// originId is a stable string id (typically a UUID, but we don't lock the
// shape since legacy nodes may use other formats). Cap length to keep abuse
// low.
const OriginIdSchema = z.string().min(1).max(64);

const TITLE_MAX = 200;
const NOTES_MAX = 2000;
const ADDRESS_MAX = 500;
const PLACE_ID_MAX = 256;

// Loose location schema for the *post-preprocess* state — placeId/lat/lng are
// required because `preprocessPatch` should have geocoded them. The earlier
// "incoming" patch is allowed to omit them; preprocess fills them in.
const LocationSchema = z
  .object({
    placeId: z.string().min(1).max(PLACE_ID_MAX),
    lat: z.number().finite().min(-90).max(90),
    lng: z.number().finite().min(-180).max(180),
    address: z.string().min(1).max(ADDRESS_MAX),
  })
  .strict();

// IsoDateString: accept null OR a valid ISO date string.
const IsoDateOrNull = z
  .union([
    z.iso.datetime({ offset: true }),
    z.iso.datetime(),
    z.null(),
  ])
  .nullable();

// Patch shape *as supplied by the client*. We don't run this through Zod
// directly for `location` because the geocoder may fill in missing fields —
// instead we treat location as a permissive partial here and validate it
// post-preprocess inside `buildColumnPatch`.
const RawPatchSchema = z
  .object({
    title: z
      .string()
      .min(1)
      .max(TITLE_MAX)
      .transform((s) => s.trim())
      .refine((s) => s.length > 0, { message: 'title is required' }),
    notes: z.string().max(NOTES_MAX).nullable(),
    startAt: IsoDateOrNull,
    endAt: IsoDateOrNull,
    // permissive on incoming — preprocess geocodes; final validation happens
    // in buildColumnPatch via LocationSchema.
    location: z.record(z.string(), z.unknown()).nullable(),
    typeData: z.record(z.string(), z.unknown()),
    sortIndex: z.number().int().finite(),
  })
  .partial()
  .strict()
  .refine((p) => Object.keys(p).length > 0, {
    message: 'patch must contain at least one field',
  });

const PatchBodySchema = z
  .object({
    patch: RawPatchSchema,
    expectedVersion: z.number().int().finite(),
  })
  .strict();

type NodePatchRow = Partial<typeof nodeTable.$inferInsert>;

function authErrorResponse(err: unknown): NextResponse | null {
  if (err instanceof UnauthenticatedError) {
    return NextResponse.json({ error: err.message }, { status: 401 });
  }
  if (err instanceof ForbiddenError) {
    return NextResponse.json({ error: err.message }, { status: 403 });
  }
  return null;
}

function zodIssues(
  err: z.ZodError,
): { path: string; message: string }[] {
  return err.issues.map((i) => ({
    path: i.path.join('.'),
    message: i.message,
  }));
}

async function resolveVariantId(
  rawVariantId: string,
  tripBookId: string,
  userId: string,
): Promise<string> {
  if (rawVariantId === 'mine') {
    const summary = await getOrCreateVariantForUser(tripBookId, userId);
    return summary.id;
  }
  return rawVariantId;
}

/**
 * Translate the client-facing patch shape into column-level updates. We only
 * accept the documented field set (zod's `.strict()` enforces this) so a
 * client can't (e.g.) overwrite `version` directly.
 */
function buildColumnPatch(patch: Record<string, unknown>): {
  columnPatch: NodePatchRow;
  echoPatch: Record<string, unknown>;
} {
  const columnPatch: NodePatchRow = {};
  const echoPatch: Record<string, unknown> = {};

  if ('title' in patch) {
    if (typeof patch.title !== 'string' || !patch.title.trim()) {
      throw new Error('title must be a non-empty string');
    }
    columnPatch.title = patch.title.trim();
    echoPatch.title = columnPatch.title;
  }

  if ('notes' in patch) {
    if (patch.notes !== null && typeof patch.notes !== 'string') {
      throw new Error('notes must be a string or null');
    }
    columnPatch.notes = patch.notes as string | null;
    echoPatch.notes = patch.notes;
  }

  if ('startAt' in patch) {
    if (patch.startAt === null) {
      columnPatch.startAt = null;
      echoPatch.startAt = null;
    } else if (typeof patch.startAt === 'string') {
      const date = new Date(patch.startAt);
      if (Number.isNaN(date.getTime())) {
        throw new Error('startAt is not a valid ISO date');
      }
      columnPatch.startAt = date;
      echoPatch.startAt = patch.startAt;
    } else {
      throw new Error('startAt must be an ISO date string or null');
    }
  }

  if ('endAt' in patch) {
    if (patch.endAt === null) {
      columnPatch.endAt = null;
      echoPatch.endAt = null;
    } else if (typeof patch.endAt === 'string') {
      const date = new Date(patch.endAt);
      if (Number.isNaN(date.getTime())) {
        throw new Error('endAt is not a valid ISO date');
      }
      columnPatch.endAt = date;
      echoPatch.endAt = patch.endAt;
    } else {
      throw new Error('endAt must be an ISO date string or null');
    }
  }

  if ('location' in patch) {
    const loc = patch.location;
    if (loc === null) {
      columnPatch.locationPlaceId = null;
      columnPatch.locationLat = null;
      columnPatch.locationLng = null;
      columnPatch.locationAddress = null;
      echoPatch.location = null;
    } else {
      // Validate the post-preprocess location against the strict schema. If
      // preprocess couldn't geocode (or the user supplied a partial loc that
      // wasn't geocodable), this fails fast with a 422.
      const parsed = LocationSchema.safeParse(loc);
      if (!parsed.success) {
        throw new Error(
          'location requires { placeId: string, lat: number, lng: number, address: string }',
        );
      }
      columnPatch.locationPlaceId = parsed.data.placeId;
      columnPatch.locationLat = parsed.data.lat;
      columnPatch.locationLng = parsed.data.lng;
      columnPatch.locationAddress = parsed.data.address;
      echoPatch.location = parsed.data;
    }
  }

  if ('typeData' in patch) {
    if (
      patch.typeData === null ||
      typeof patch.typeData !== 'object' ||
      Array.isArray(patch.typeData)
    ) {
      throw new Error('typeData must be an object');
    }
    columnPatch.typeData = patch.typeData as Record<string, unknown>;
    echoPatch.typeData = patch.typeData;
  }

  if ('sortIndex' in patch) {
    if (
      typeof patch.sortIndex !== 'number' ||
      !Number.isFinite(patch.sortIndex)
    ) {
      throw new Error('sortIndex must be a finite number');
    }
    columnPatch.sortIndex = Math.trunc(patch.sortIndex);
    echoPatch.sortIndex = columnPatch.sortIndex;
  }

  return { columnPatch, echoPatch };
}

/**
 * If the inbound patch has a `location` block with an `address` but is
 * missing `placeId` / `lat` / `lng`, geocode the address and merge the
 * resolved fields back in. Best-effort: if geocoding fails, the patch is
 * returned unchanged and `buildColumnPatch` will then 422 on the missing
 * fields. We never hard-fail here because the user might intentionally be
 * setting an unverified address.
 */
async function preprocessPatch(
  patch: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!('location' in patch)) return patch;
  const loc = patch.location;
  if (!loc || typeof loc !== 'object') return patch;

  const r = loc as Record<string, unknown>;
  const hasAddress =
    typeof r.address === 'string' && (r.address as string).trim().length > 0;
  const hasPlaceId = typeof r.placeId === 'string';
  const hasLat = typeof r.lat === 'number';
  const hasLng = typeof r.lng === 'number';

  if (!hasAddress || (hasPlaceId && hasLat && hasLng)) return patch;

  const geo = await geocodeAddress(r.address as string);
  if (!geo) return patch;

  return {
    ...patch,
    location: {
      placeId: hasPlaceId ? r.placeId : geo.placeId,
      lat: hasLat ? r.lat : geo.lat,
      lng: hasLng ? r.lng : geo.lng,
      address: r.address,
    },
  };
}

export async function PATCH(
  request: Request,
  context: {
    params: Promise<{ id: string; variantId: string; originId: string }>;
  },
): Promise<Response> {
  const {
    id: tripBookId,
    variantId: rawVariantId,
    originId,
  } = await context.params;

  if (
    !TripBookIdSchema.safeParse(tripBookId).success ||
    !VariantIdParamSchema.safeParse(rawVariantId).success ||
    !OriginIdSchema.safeParse(originId).success
  ) {
    return NextResponse.json({ error: 'Invalid path params' }, { status: 400 });
  }

  let userId: string;
  try {
    userId = await getCurrentUserId();
    await requireMembership(tripBookId, userId);
  } catch (err) {
    const resp = authErrorResponse(err);
    if (resp) return resp;
    throw err;
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = PatchBodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request', details: zodIssues(parsed.error) },
      { status: 400 },
    );
  }
  const expectedVersion = parsed.data.expectedVersion;

  let columnPatch: NodePatchRow;
  let echoPatch: Record<string, unknown>;
  try {
    const enriched = await preprocessPatch(
      parsed.data.patch as Record<string, unknown>,
    );
    const out = buildColumnPatch(enriched);
    columnPatch = out.columnPatch;
    echoPatch = out.echoPatch;
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Invalid patch' },
      { status: 422 },
    );
  }

  if (Object.keys(columnPatch).length === 0) {
    return NextResponse.json(
      { error: 'Patch is empty — nothing to update' },
      { status: 422 },
    );
  }

  // Whenever the location (placeId/lat/lng/address) changes, bump
  // `place_refreshed_at` so downstream consumers can decide whether the
  // cached Place metadata is stale.
  const locationChanged =
    'locationPlaceId' in columnPatch ||
    'locationLat' in columnPatch ||
    'locationLng' in columnPatch ||
    'locationAddress' in columnPatch;
  if (locationChanged) {
    columnPatch.placeRefreshedAt = new Date();
  }

  let variantId: string;
  try {
    variantId = await resolveVariantId(rawVariantId, tripBookId, userId);
  } catch (err) {
    console.error('[PATCH node] resolveVariant failed:', err);
    return NextResponse.json(
      { error: 'Failed to resolve variant' },
      { status: 500 },
    );
  }

  // Variant must belong to this trip book and be owned by the caller.
  const [variantRow] = await db
    .select({
      id: variantTable.id,
      ownerUserId: variantTable.ownerUserId,
      tripBookId: variantTable.tripBookId,
    })
    .from(variantTable)
    .where(eq(variantTable.id, variantId))
    .limit(1);

  if (!variantRow || variantRow.tripBookId !== tripBookId) {
    return NextResponse.json({ error: 'Variant not found' }, { status: 404 });
  }
  if (variantRow.ownerUserId !== userId) {
    return NextResponse.json(
      { error: 'Only the variant owner may mutate this variant' },
      { status: 403 },
    );
  }

  let updated: NodeRow | undefined;
  try {
    const rows = await db
      .update(nodeTable)
      .set({
        ...columnPatch,
        version: sql`${nodeTable.version} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(nodeTable.variantId, variantId),
          eq(nodeTable.originId, originId),
          eq(nodeTable.version, expectedVersion),
        ),
      )
      .returning();
    updated = rows[0];
  } catch (err) {
    console.error('[PATCH node] update failed:', err);
    return NextResponse.json(
      { error: 'Failed to update node' },
      { status: 500 },
    );
  }

  if (!updated) {
    // Either the row doesn't exist or `version` no longer matches. Disambiguate
    // for the client so the UI can render the right message.
    const [exists] = await db
      .select({ id: nodeTable.id, version: nodeTable.version })
      .from(nodeTable)
      .where(
        and(
          eq(nodeTable.variantId, variantId),
          eq(nodeTable.originId, originId),
        ),
      )
      .limit(1);

    if (!exists) {
      return NextResponse.json({ error: 'Node not found' }, { status: 404 });
    }
    return NextResponse.json(
      {
        error: 'Version mismatch',
        currentVersion: exists.version,
      },
      { status: 409 },
    );
  }

  await safeBroadcastToVariant(variantId, 'node.update', {
    kind: 'node.update',
    variantId,
    originId,
    patch: echoPatch,
    version: updated.version,
  });

  return NextResponse.json({
    originId: updated.originId,
    id: updated.id,
    version: updated.version,
  });
}

export async function DELETE(
  _request: Request,
  context: {
    params: Promise<{ id: string; variantId: string; originId: string }>;
  },
): Promise<Response> {
  const {
    id: tripBookId,
    variantId: rawVariantId,
    originId,
  } = await context.params;

  if (
    !TripBookIdSchema.safeParse(tripBookId).success ||
    !VariantIdParamSchema.safeParse(rawVariantId).success ||
    !OriginIdSchema.safeParse(originId).success
  ) {
    return NextResponse.json({ error: 'Invalid path params' }, { status: 400 });
  }

  let userId: string;
  try {
    userId = await getCurrentUserId();
    await requireMembership(tripBookId, userId);
  } catch (err) {
    const resp = authErrorResponse(err);
    if (resp) return resp;
    throw err;
  }

  let variantId: string;
  try {
    variantId = await resolveVariantId(rawVariantId, tripBookId, userId);
  } catch (err) {
    console.error('[DELETE node] resolveVariant failed:', err);
    return NextResponse.json(
      { error: 'Failed to resolve variant' },
      { status: 500 },
    );
  }

  const [variantRow] = await db
    .select({
      id: variantTable.id,
      ownerUserId: variantTable.ownerUserId,
      tripBookId: variantTable.tripBookId,
    })
    .from(variantTable)
    .where(eq(variantTable.id, variantId))
    .limit(1);

  if (!variantRow || variantRow.tripBookId !== tripBookId) {
    return NextResponse.json({ error: 'Variant not found' }, { status: 404 });
  }
  if (variantRow.ownerUserId !== userId) {
    return NextResponse.json(
      { error: 'Only the variant owner may mutate this variant' },
      { status: 403 },
    );
  }

  try {
    const rows = await db
      .update(nodeTable)
      .set({
        deleted: true,
        version: sql`${nodeTable.version} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(nodeTable.variantId, variantId),
          eq(nodeTable.originId, originId),
        ),
      )
      .returning({ originId: nodeTable.originId, version: nodeTable.version });

    if (rows.length === 0) {
      return NextResponse.json({ error: 'Node not found' }, { status: 404 });
    }

    await safeBroadcastToVariant(variantId, 'node.delete', {
      kind: 'node.delete',
      variantId,
      originId,
    });

    return NextResponse.json({ originId, version: rows[0].version });
  } catch (err) {
    console.error('[DELETE node] failed:', err);
    return NextResponse.json(
      { error: 'Failed to delete node' },
      { status: 500 },
    );
  }
}
