/**
 * Variant-scoped node collection.
 *
 *   POST   -> create a new node in this variant. Body fields mirror the
 *             `node` schema; `parentOriginId` is resolved to a `parent_node_id`
 *             inside the same variant so cross-variant parents are impossible.
 *   GET    -> hydrated variant graph (delegates to `loadVariantGraph`).
 *
 * `variantId` accepts the literal token `mine`, which `getOrCreateVariantForUser`
 * resolves to the caller's draft variant — useful for clients that don't know
 * the id yet (initial page load).
 */
import { createHash } from 'node:crypto';

import { and, eq, max, sql } from 'drizzle-orm';
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
} from '@/db/schema';
import { loadVariantGraph } from '@/lib/graph';
import { safeBroadcastToVariant } from '@/lib/realtime';
import { getOrCreateVariantForUser } from '@/lib/variants';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

// Path parameters. `variantId` permits the literal `mine` for first-page loads
// where the client doesn't yet know the variant uuid; otherwise it must be a
// valid uuid.
const TripBookIdSchema = z.uuid();
const VariantIdParamSchema = z.union([
  z.literal('mine'),
  z.uuid(),
]);

// Length caps mirror the DB schema's varchar lengths and keep payloads small
// enough that a single rogue request can't easily DoS us via gigabyte JSON.
const TITLE_MAX = 200;
const NOTES_MAX = 2000;
const ADDRESS_MAX = 500;
const PLACE_ID_MAX = 256;

const NODE_TYPES = [
  'trip',
  'day',
  'destination',
  'transport',
  'lodging',
  'activity',
  'meal',
  'note',
] as const;

const LocationSchema = z
  .object({
    placeId: z.string().min(1).max(PLACE_ID_MAX),
    lat: z.number().finite().min(-90).max(90),
    lng: z.number().finite().min(-180).max(180),
    address: z.string().min(1).max(ADDRESS_MAX),
  })
  .strict();

// IsoDateString: accept null OR a valid ISO date string. We don't bound the
// range here since the column is `timestamp` and Postgres handles it.
const IsoDateOrNull = z
  .union([
    z.iso.datetime({ offset: true }),
    z.iso.datetime(),
    z.null(),
  ])
  .nullable();

const CreateNodeSchema = z
  .object({
    type: z.enum(NODE_TYPES),
    // parentOriginId is a stable string id (typically uuid). Capped to keep
    // payloads small. Nullable so callers can explicitly attach to root.
    parentOriginId: z.string().min(1).max(64).nullable().optional(),
    title: z
      .string()
      .min(1, 'title is required')
      .max(TITLE_MAX)
      .transform((s) => s.trim())
      .refine((s) => s.length > 0, { message: 'title is required' }),
    notes: z.string().max(NOTES_MAX).nullable().optional(),
    startAt: IsoDateOrNull.optional(),
    endAt: IsoDateOrNull.optional(),
    location: LocationSchema.nullable().optional(),
    typeData: z.record(z.string(), z.unknown()).optional(),
    sortIndex: z.number().int().finite().optional(),
    originId: z.string().min(1).max(64).optional(),
  })
  .strict();

type ParsedCreateNode = z.infer<typeof CreateNodeSchema>;

function authErrorResponse(err: unknown): NextResponse | null {
  if (err instanceof UnauthenticatedError) {
    return NextResponse.json({ error: err.message }, { status: 401 });
  }
  if (err instanceof ForbiddenError) {
    return NextResponse.json({ error: err.message }, { status: 403 });
  }
  return null;
}

function badRequest(
  details: { path: string; message: string }[],
): NextResponse {
  return NextResponse.json(
    { error: 'Invalid request', details },
    { status: 400 },
  );
}

function zodIssues(
  err: z.ZodError,
): { path: string; message: string }[] {
  return err.issues.map((i) => ({
    path: i.path.join('.'),
    message: i.message,
  }));
}

/** Resolve `mine` to the caller's variant or return the literal id. */
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

function parseDateOrNull(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; variantId: string }> },
): Promise<Response> {
  const { id: tripBookId, variantId: rawVariantId } = await context.params;

  // Validate path params before any DB call.
  const tripParse = TripBookIdSchema.safeParse(tripBookId);
  const variantParse = VariantIdParamSchema.safeParse(rawVariantId);
  if (!tripParse.success || !variantParse.success) {
    return NextResponse.json(
      { error: 'Invalid trip book id or variant id' },
      { status: 400 },
    );
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

  const parsed = CreateNodeSchema.safeParse(raw);
  if (!parsed.success) {
    return badRequest(zodIssues(parsed.error));
  }
  const body: ParsedCreateNode = parsed.data;

  let variantId: string;
  try {
    variantId = await resolveVariantId(rawVariantId, tripBookId, userId);
  } catch (err) {
    console.error('[POST /api/trips/.../nodes] resolveVariant failed:', err);
    return NextResponse.json(
      { error: 'Failed to resolve variant' },
      { status: 500 },
    );
  }

  // Verify the variant belongs to the trip book and is owned by the caller.
  // This is the variant-owner gate — non-owners are denied even if they're
  // members of the trip book.
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
    const result = await db.transaction(async (tx) => {
      // 1. If a parent originId was provided, look up its row in this variant.
      let parentNodeId: string | null = null;
      if (body.parentOriginId) {
        const [parentRow] = await tx
          .select({ id: nodeTable.id })
          .from(nodeTable)
          .where(
            and(
              eq(nodeTable.variantId, variantId),
              eq(nodeTable.originId, body.parentOriginId),
            ),
          )
          .limit(1);
        if (!parentRow) {
          throw Object.assign(new Error('Parent node not found in variant'), {
            status: 422,
          });
        }
        parentNodeId = parentRow.id;
      }

      // 2. Insert the node row. `id` and `originId` default to gen_random_uuid()
      //    server-side when not supplied — Postgres handles the actual UUID
      //    generation so client-supplied origin ids stay optional.
      const insertValues = {
        variantId,
        type: body.type,
        parentNodeId,
        sortIndex:
          typeof body.sortIndex === 'number' ? Math.trunc(body.sortIndex) : 0,
        title: body.title,
        notes: body.notes ?? null,
        startAt: parseDateOrNull(body.startAt ?? null),
        endAt: parseDateOrNull(body.endAt ?? null),
        locationPlaceId: body.location?.placeId ?? null,
        locationLat: body.location?.lat ?? null,
        locationLng: body.location?.lng ?? null,
        locationAddress: body.location?.address ?? null,
        typeData: body.typeData ?? {},
        // Only override originId when the caller actually supplied one;
        // otherwise let the column default apply.
        ...(body.originId ? { originId: body.originId } : {}),
      } as typeof nodeTable.$inferInsert;

      const [inserted] = await tx
        .insert(nodeTable)
        .values(insertValues)
        .returning();

      return inserted;
    });

    // Best-effort realtime notification — don't fail the request if Pusher
    // isn't configured (tests, local dev without env).
    await safeBroadcastToVariant(variantId, 'node.add', {
      kind: 'node.add',
      variantId,
      nodeId: result.id,
      originId: result.originId,
      parentOriginId: body.parentOriginId ?? null,
    });

    return NextResponse.json(
      { originId: result.originId, id: result.id, version: result.version },
      { status: 201 },
    );
  } catch (err) {
    if (
      err &&
      typeof err === 'object' &&
      'status' in err &&
      typeof (err as { status: unknown }).status === 'number'
    ) {
      const status = (err as { status: number }).status;
      const message = err instanceof Error ? err.message : 'Bad request';
      return NextResponse.json({ error: message }, { status });
    }
    console.error('[POST /api/trips/.../nodes] insert failed:', err);
    return NextResponse.json(
      { error: 'Failed to create node' },
      { status: 500 },
    );
  }
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string; variantId: string }> },
): Promise<Response> {
  const { id: tripBookId, variantId: rawVariantId } = await context.params;

  const tripParse = TripBookIdSchema.safeParse(tripBookId);
  const variantParse = VariantIdParamSchema.safeParse(rawVariantId);
  if (!tripParse.success || !variantParse.success) {
    return NextResponse.json(
      { error: 'Invalid trip book id or variant id' },
      { status: 400 },
    );
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
    console.error('[GET /api/trips/.../nodes] resolveVariant failed:', err);
    return NextResponse.json(
      { error: 'Failed to resolve variant' },
      { status: 500 },
    );
  }

  // Verify the variant lives under this trip-book before delegating. Reading
  // is allowed for any active member of the trip-book (collaborator preview).
  const [variantRow] = await db
    .select({ id: variantTable.id, tripBookId: variantTable.tripBookId })
    .from(variantTable)
    .where(eq(variantTable.id, variantId))
    .limit(1);

  if (!variantRow || variantRow.tripBookId !== tripBookId) {
    return NextResponse.json({ error: 'Variant not found' }, { status: 404 });
  }

  try {
    // Compute a cheap ETag from the max(updated_at) over the variant's live
    // node rows plus the row count, so deletes also bump the tag. This is
    // strictly an optimisation: the response body is still computed and sent
    // (we don't currently shortcut on If-None-Match), but the headers let
    // the browser skip re-rendering identical payloads on rapid tab switches.
    const [aggregate] = await db
      .select({
        maxUpdatedAt: max(nodeTable.updatedAt),
        count: sql<number>`count(*)::int`,
      })
      .from(nodeTable)
      .where(
        and(
          eq(nodeTable.variantId, variantId),
          eq(nodeTable.deleted, false),
        ),
      );

    const maxUpdated =
      aggregate?.maxUpdatedAt instanceof Date
        ? aggregate.maxUpdatedAt.toISOString()
        : aggregate?.maxUpdatedAt
          ? String(aggregate.maxUpdatedAt)
          : '0';
    const count = Number(aggregate?.count ?? 0);
    const etag = `W/"${createHash('sha1')
      .update(`${variantId}:${maxUpdated}:${count}`)
      .digest('hex')
      .slice(0, 16)}"`;

    const graph = await loadVariantGraph(variantId);
    return NextResponse.json(graph, {
      headers: {
        // Always re-validate; this prevents a rapid back/forward navigation
        // from showing a stale graph but still lets the browser short-circuit
        // identical payloads on tab focus when paired with our ETag.
        'Cache-Control': 'private, max-age=0, must-revalidate',
        ETag: etag,
      },
    });
  } catch (err) {
    console.error('[GET /api/trips/.../nodes] load failed:', err);
    return NextResponse.json(
      { error: 'Failed to load variant graph' },
      { status: 500 },
    );
  }
}
