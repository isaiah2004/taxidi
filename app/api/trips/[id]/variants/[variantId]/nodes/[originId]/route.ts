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
import { safeBroadcastToVariant } from '@/lib/realtime';
import { getOrCreateVariantForUser } from '@/lib/variants';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface PatchBody {
  patch?: unknown;
  expectedVersion?: unknown;
}

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
 * accept the documented field set and silently drop anything else so a client
 * can't (e.g.) overwrite `version` directly.
 */
function buildColumnPatch(patch: Record<string, unknown>): {
  columnPatch: NodePatchRow;
  echoPatch: Record<string, unknown>;
} {
  const columnPatch: NodePatchRow = {};
  const echoPatch: Record<string, unknown> = {};

  if ('title' in patch) {
    if (typeof patch.title !== 'string' || !patch.title.trim()) {
      throw new Error('`title` must be a non-empty string');
    }
    columnPatch.title = patch.title.trim();
    echoPatch.title = columnPatch.title;
  }

  if ('notes' in patch) {
    if (patch.notes !== null && typeof patch.notes !== 'string') {
      throw new Error('`notes` must be a string or null');
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
        throw new Error('`startAt` is not a valid ISO date');
      }
      columnPatch.startAt = date;
      echoPatch.startAt = patch.startAt;
    } else {
      throw new Error('`startAt` must be an ISO date string or null');
    }
  }

  if ('endAt' in patch) {
    if (patch.endAt === null) {
      columnPatch.endAt = null;
      echoPatch.endAt = null;
    } else if (typeof patch.endAt === 'string') {
      const date = new Date(patch.endAt);
      if (Number.isNaN(date.getTime())) {
        throw new Error('`endAt` is not a valid ISO date');
      }
      columnPatch.endAt = date;
      echoPatch.endAt = patch.endAt;
    } else {
      throw new Error('`endAt` must be an ISO date string or null');
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
    } else if (loc && typeof loc === 'object') {
      const r = loc as Record<string, unknown>;
      if (
        typeof r.placeId !== 'string' ||
        typeof r.address !== 'string' ||
        typeof r.lat !== 'number' ||
        typeof r.lng !== 'number'
      ) {
        throw new Error(
          '`location` requires { placeId: string, lat: number, lng: number, address: string }',
        );
      }
      columnPatch.locationPlaceId = r.placeId;
      columnPatch.locationLat = r.lat;
      columnPatch.locationLng = r.lng;
      columnPatch.locationAddress = r.address;
      echoPatch.location = {
        placeId: r.placeId,
        lat: r.lat,
        lng: r.lng,
        address: r.address,
      };
    } else {
      throw new Error('`location` must be an object or null');
    }
  }

  if ('typeData' in patch) {
    if (
      patch.typeData === null ||
      typeof patch.typeData !== 'object' ||
      Array.isArray(patch.typeData)
    ) {
      throw new Error('`typeData` must be an object');
    }
    columnPatch.typeData = patch.typeData as Record<string, unknown>;
    echoPatch.typeData = patch.typeData;
  }

  if ('sortIndex' in patch) {
    if (
      typeof patch.sortIndex !== 'number' ||
      !Number.isFinite(patch.sortIndex)
    ) {
      throw new Error('`sortIndex` must be a finite number');
    }
    columnPatch.sortIndex = Math.trunc(patch.sortIndex);
    echoPatch.sortIndex = columnPatch.sortIndex;
  }

  return { columnPatch, echoPatch };
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

  if (!tripBookId || !rawVariantId || !originId) {
    return NextResponse.json({ error: 'Missing path params' }, { status: 400 });
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

  let body: PatchBody;
  try {
    body = (await request.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!body.patch || typeof body.patch !== 'object') {
    return NextResponse.json(
      { error: '`patch` must be an object' },
      { status: 422 },
    );
  }
  if (
    typeof body.expectedVersion !== 'number' ||
    !Number.isInteger(body.expectedVersion)
  ) {
    return NextResponse.json(
      { error: '`expectedVersion` must be an integer' },
      { status: 422 },
    );
  }
  const expectedVersion = body.expectedVersion;

  let columnPatch: NodePatchRow;
  let echoPatch: Record<string, unknown>;
  try {
    const out = buildColumnPatch(body.patch as Record<string, unknown>);
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

  if (!tripBookId || !rawVariantId || !originId) {
    return NextResponse.json({ error: 'Missing path params' }, { status: 400 });
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
