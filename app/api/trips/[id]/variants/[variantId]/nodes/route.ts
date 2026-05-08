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
import { and, eq } from 'drizzle-orm';
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
  type NodeType,
} from '@/db/schema';
import { loadVariantGraph } from '@/lib/graph';
import { safeBroadcastToVariant } from '@/lib/realtime';
import { getOrCreateVariantForUser } from '@/lib/variants';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const VALID_NODE_TYPES: ReadonlyArray<NodeType> = [
  'trip',
  'day',
  'destination',
  'transport',
  'lodging',
  'activity',
  'meal',
  'note',
];

interface CreateNodeBody {
  type?: unknown;
  parentOriginId?: unknown;
  title?: unknown;
  notes?: unknown;
  startAt?: unknown;
  endAt?: unknown;
  location?: unknown;
  typeData?: unknown;
  sortIndex?: unknown;
  originId?: unknown;
}

interface ParsedLocation {
  placeId: string;
  lat: number;
  lng: number;
  address: string;
}

interface ParsedCreateNode {
  type: NodeType;
  parentOriginId: string | null;
  title: string;
  notes: string | null;
  startAt: Date | null;
  endAt: Date | null;
  location: ParsedLocation | null;
  typeData: Record<string, unknown>;
  sortIndex: number;
  originId: string | undefined;
}

function authErrorResponse(err: unknown): NextResponse | null {
  if (err instanceof UnauthenticatedError) {
    return NextResponse.json({ error: err.message }, { status: 401 });
  }
  if (err instanceof ForbiddenError) {
    return NextResponse.json({ error: err.message }, { status: 403 });
  }
  return null;
}

function isValidNodeType(value: unknown): value is NodeType {
  return (
    typeof value === 'string' &&
    (VALID_NODE_TYPES as ReadonlyArray<string>).includes(value)
  );
}

function parseIsoDate(value: unknown, field: string): Date | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw new Error(`\`${field}\` must be an ISO date string`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`\`${field}\` is not a valid ISO date`);
  }
  return date;
}

function parseLocation(value: unknown): ParsedLocation | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object') {
    throw new Error('`location` must be an object or null');
  }
  const loc = value as Record<string, unknown>;
  const placeId = loc.placeId;
  const lat = loc.lat;
  const lng = loc.lng;
  const address = loc.address;
  if (
    typeof placeId !== 'string' ||
    typeof address !== 'string' ||
    typeof lat !== 'number' ||
    typeof lng !== 'number'
  ) {
    throw new Error(
      '`location` requires { placeId: string, lat: number, lng: number, address: string }',
    );
  }
  return { placeId, lat, lng, address };
}

function parseCreateBody(body: CreateNodeBody): ParsedCreateNode {
  if (!isValidNodeType(body.type)) {
    throw new Error(
      `\`type\` is required and must be one of: ${VALID_NODE_TYPES.join(', ')}`,
    );
  }
  if (typeof body.title !== 'string' || !body.title.trim()) {
    throw new Error('`title` is required and must be a non-empty string');
  }
  const parentOriginId =
    body.parentOriginId === null || body.parentOriginId === undefined
      ? null
      : typeof body.parentOriginId === 'string'
      ? body.parentOriginId
      : (() => {
          throw new Error('`parentOriginId` must be a string or null');
        })();

  const notes =
    body.notes === null || body.notes === undefined
      ? null
      : typeof body.notes === 'string'
      ? body.notes
      : (() => {
          throw new Error('`notes` must be a string or null');
        })();

  const sortIndex =
    body.sortIndex === undefined
      ? 0
      : typeof body.sortIndex === 'number' && Number.isFinite(body.sortIndex)
      ? Math.trunc(body.sortIndex)
      : (() => {
          throw new Error('`sortIndex` must be a finite number');
        })();

  const originId =
    body.originId === undefined
      ? undefined
      : typeof body.originId === 'string' && body.originId
      ? body.originId
      : (() => {
          throw new Error('`originId` must be a non-empty string');
        })();

  const typeData =
    body.typeData === undefined
      ? {}
      : body.typeData && typeof body.typeData === 'object'
      ? (body.typeData as Record<string, unknown>)
      : (() => {
          throw new Error('`typeData` must be an object');
        })();

  return {
    type: body.type,
    parentOriginId,
    title: body.title.trim(),
    notes,
    startAt: parseIsoDate(body.startAt, 'startAt'),
    endAt: parseIsoDate(body.endAt, 'endAt'),
    location: parseLocation(body.location),
    typeData,
    sortIndex,
    originId,
  };
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

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; variantId: string }> },
): Promise<Response> {
  const { id: tripBookId, variantId: rawVariantId } = await context.params;

  if (!tripBookId || !rawVariantId) {
    return NextResponse.json(
      { error: 'Missing trip book id or variant id' },
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

  let body: CreateNodeBody;
  try {
    body = (await request.json()) as CreateNodeBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  let parsed: ParsedCreateNode;
  try {
    parsed = parseCreateBody(body);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Invalid body' },
      { status: 422 },
    );
  }

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
      if (parsed.parentOriginId) {
        const [parentRow] = await tx
          .select({ id: nodeTable.id })
          .from(nodeTable)
          .where(
            and(
              eq(nodeTable.variantId, variantId),
              eq(nodeTable.originId, parsed.parentOriginId),
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
        type: parsed.type,
        parentNodeId,
        sortIndex: parsed.sortIndex,
        title: parsed.title,
        notes: parsed.notes,
        startAt: parsed.startAt,
        endAt: parsed.endAt,
        locationPlaceId: parsed.location?.placeId ?? null,
        locationLat: parsed.location?.lat ?? null,
        locationLng: parsed.location?.lng ?? null,
        locationAddress: parsed.location?.address ?? null,
        typeData: parsed.typeData,
        // Only override originId when the caller actually supplied one;
        // otherwise let the column default apply.
        ...(parsed.originId ? { originId: parsed.originId } : {}),
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
      parentOriginId: parsed.parentOriginId,
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

  if (!tripBookId || !rawVariantId) {
    return NextResponse.json(
      { error: 'Missing trip book id or variant id' },
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

  // Verify the variant lives under this trip-book before delegating.
  const [variantRow] = await db
    .select({ id: variantTable.id, tripBookId: variantTable.tripBookId })
    .from(variantTable)
    .where(eq(variantTable.id, variantId))
    .limit(1);

  if (!variantRow || variantRow.tripBookId !== tripBookId) {
    return NextResponse.json({ error: 'Variant not found' }, { status: 404 });
  }

  try {
    const graph = await loadVariantGraph(variantId);
    return NextResponse.json(graph);
  } catch (err) {
    console.error('[GET /api/trips/.../nodes] load failed:', err);
    return NextResponse.json(
      { error: 'Failed to load variant graph' },
      { status: 500 },
    );
  }
}
