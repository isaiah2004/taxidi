/**
 * Dashboard router — sends signed-in users to their most recently updated
 * trip, or to a "Create your first trip" empty state when they have none.
 *
 * Server component end-to-end: the empty-state's "Create Trip Book" form is a
 * `<form action={createTripAction}>` so we don't need a client island. The
 * action runs server-side, performs the same trip-book bootstrap as
 * `POST /api/trips`, and `redirect()`s into the new trip.
 */
import { and, desc, eq, exists } from 'drizzle-orm';
import { redirect } from 'next/navigation';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  ForbiddenError,
  UnauthenticatedError,
  getCurrentUserId,
} from '@/lib/auth';
import { db } from '@/lib/db';
import {
  mainVersion,
  membership,
  tripBook,
  variant,
} from '@/db/schema';

export const dynamic = 'force-dynamic';

/**
 * Server action: create a new trip book + initial main_version + owner
 * variant in one transaction, then redirect into the new trip's detail page.
 */
async function createTripAction(formData: FormData): Promise<void> {
  'use server';

  const rawName = formData.get('name');
  const name =
    typeof rawName === 'string' && rawName.trim().length > 0
      ? rawName.trim()
      : 'Untitled trip';

  let userId: string;
  try {
    userId = await getCurrentUserId();
  } catch (err) {
    if (err instanceof UnauthenticatedError || err instanceof ForbiddenError) {
      redirect('/sign-in');
    }
    throw err;
  }

  const created = await db.transaction(async (tx) => {
    const [tripRow] = await tx
      .insert(tripBook)
      .values({ name, ownerUserId: userId })
      .returning();

    const [versionRow] = await tx
      .insert(mainVersion)
      .values({
        tripBookId: tripRow.id,
        parentVersionId: null,
        snapshot: { nodes: [] },
        committedByUserId: userId,
        message: 'Initial trip',
      })
      .returning();

    await tx
      .update(tripBook)
      .set({ currentMainVersionId: versionRow.id })
      .where(eq(tripBook.id, tripRow.id));

    await tx.insert(membership).values({
      tripBookId: tripRow.id,
      userId,
      role: 'owner',
      status: 'active',
      joinedAt: new Date(),
    });

    await tx.insert(variant).values({
      tripBookId: tripRow.id,
      ownerUserId: userId,
      baseMainVersionId: versionRow.id,
      status: 'draft',
    });

    return tripRow;
  });

  redirect(`/trips/${created.id}`);
}

export default async function DashboardPage() {
  let userId: string;
  try {
    userId = await getCurrentUserId();
  } catch (err) {
    if (err instanceof UnauthenticatedError || err instanceof ForbiddenError) {
      redirect('/sign-in');
    }
    throw err;
  }

  // Find the most recently updated trip across owned + shared. Two indexed
  // queries + picking the newer on the server is simpler than building a
  // UNION through Drizzle.
  const [latestOwned] = await db
    .select({
      id: tripBook.id,
      updatedAt: tripBook.updatedAt,
    })
    .from(tripBook)
    .where(eq(tripBook.ownerUserId, userId))
    .orderBy(desc(tripBook.updatedAt))
    .limit(1);

  const [latestShared] = await db
    .select({
      id: tripBook.id,
      updatedAt: tripBook.updatedAt,
    })
    .from(tripBook)
    .where(
      exists(
        db
          .select({ one: membership.userId })
          .from(membership)
          .where(
            and(
              eq(membership.tripBookId, tripBook.id),
              eq(membership.userId, userId),
              eq(membership.role, 'member'),
              eq(membership.status, 'active'),
            ),
          ),
      ),
    )
    .orderBy(desc(tripBook.updatedAt))
    .limit(1);

  const candidates = [latestOwned, latestShared].filter(
    (row): row is { id: string; updatedAt: Date } => Boolean(row),
  );

  if (candidates.length > 0) {
    candidates.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    redirect(`/trips/${candidates[0].id}`);
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-muted/20 px-4">
      <div className="w-full max-w-md rounded-lg border bg-background p-8 shadow-sm">
        <h1 className="text-2xl font-semibold tracking-tight">
          Plan your first trip
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          A trip book holds one trip — give it a name to get started. You can
          rename or invite collaborators later.
        </p>
        <form action={createTripAction} className="mt-6 flex flex-col gap-3">
          <label htmlFor="trip-name" className="text-sm font-medium">
            Trip name
          </label>
          <Input
            id="trip-name"
            name="name"
            placeholder="e.g. Summer in Greece"
            required
            maxLength={200}
            autoFocus
          />
          <Button type="submit" className="mt-2 w-full">
            Create trip book
          </Button>
        </form>
      </div>
    </div>
  );
}
