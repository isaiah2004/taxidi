/**
 * Trip detail server component — three-pane shell.
 *
 * Layout:
 *   ┌────────────┬─────────────────────────────┬───────────────┐
 *   │ AppSidebar │  TripView (graph/timeline)  │  TripChat     │
 *   └────────────┴─────────────────────────────┴───────────────┘
 *
 * Server-side responsibilities:
 *   - Authenticate the caller (membership-gated; 404 redirects on miss).
 *   - Resolve the caller's variant (creating a draft if needed).
 *   - Pre-load the sidebar's data (own + shared trips, owner-only proposal
 *     badges) so the first paint already has the navigation rendered.
 *
 * `TripView` (Agent 3) and `TripChat` (Agent 4) own their own data fetching.
 */
import { and, desc, eq, exists, inArray } from 'drizzle-orm';
import { notFound, redirect } from 'next/navigation';

import { AppSidebar } from '@/components/app-sidebar';
import { SiteHeader } from '@/components/site-header';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import { TripChat } from '@/components/chat/trip-chat';
import { TripView } from '@/components/trip/trip-view';
import {
  ForbiddenError,
  UnauthenticatedError,
  getCurrentUserId,
  requireMembership,
} from '@/lib/auth';
import { db } from '@/lib/db';
import { membership, mergeProposal, tripBook } from '@/db/schema';
import { getOrCreateVariantForUser, isOwner } from '@/lib/variants';

export const dynamic = 'force-dynamic';

interface SidebarTripSummary {
  id: string;
  name: string;
  role: 'owner' | 'member';
  updatedAt: string;
  hasPendingProposal: boolean;
}

interface SidebarProposalSummary {
  id: string;
  tripBookId: string;
  tripName: string;
  proposedAt: string;
}

async function loadSidebarData(userId: string): Promise<{
  myTrips: SidebarTripSummary[];
  sharedTrips: SidebarTripSummary[];
  proposals: SidebarProposalSummary[];
}> {
  const ownedRows = await db
    .select({
      id: tripBook.id,
      name: tripBook.name,
      updatedAt: tripBook.updatedAt,
    })
    .from(tripBook)
    .where(eq(tripBook.ownerUserId, userId))
    .orderBy(desc(tripBook.updatedAt));

  const ownedIds = ownedRows.map((r) => r.id);
  const pendingByTrip = new Set<string>();
  let proposals: SidebarProposalSummary[] = [];
  if (ownedIds.length > 0) {
    const pendingRows = await db
      .select({
        id: mergeProposal.id,
        tripBookId: mergeProposal.tripBookId,
        proposedAt: mergeProposal.proposedAt,
      })
      .from(mergeProposal)
      .where(
        and(
          inArray(mergeProposal.tripBookId, ownedIds),
          eq(mergeProposal.status, 'pending'),
        ),
      )
      .orderBy(desc(mergeProposal.proposedAt));
    const tripsById = new Map(ownedRows.map((r) => [r.id, r.name] as const));
    for (const p of pendingRows) {
      pendingByTrip.add(p.tripBookId);
    }
    proposals = pendingRows.map((p) => ({
      id: p.id,
      tripBookId: p.tripBookId,
      tripName: tripsById.get(p.tripBookId) ?? 'Trip',
      proposedAt: p.proposedAt.toISOString(),
    }));
  }

  const myTrips: SidebarTripSummary[] = ownedRows.map((r) => ({
    id: r.id,
    name: r.name,
    role: 'owner' as const,
    updatedAt: r.updatedAt.toISOString(),
    hasPendingProposal: pendingByTrip.has(r.id),
  }));

  const sharedRows = await db
    .select({
      id: tripBook.id,
      name: tripBook.name,
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
    .orderBy(desc(tripBook.updatedAt));

  const sharedTrips: SidebarTripSummary[] = sharedRows.map((r) => ({
    id: r.id,
    name: r.name,
    role: 'member' as const,
    updatedAt: r.updatedAt.toISOString(),
    hasPendingProposal: false,
  }));

  return { myTrips, sharedTrips, proposals };
}

interface TripPageProps {
  params: Promise<{ id: string }>;
}

export default async function TripPage({ params }: TripPageProps) {
  const { id: tripBookId } = await params;

  let userId: string;
  try {
    userId = await getCurrentUserId();
  } catch (err) {
    if (err instanceof UnauthenticatedError) {
      redirect('/sign-in');
    }
    throw err;
  }

  try {
    await requireMembership(tripBookId, userId);
  } catch (err) {
    if (err instanceof ForbiddenError) {
      // Not a member — surface as 404 rather than 403 to avoid leaking the
      // existence of trip ids the caller doesn't own.
      notFound();
    }
    throw err;
  }

  const [tripRow] = await db
    .select()
    .from(tripBook)
    .where(eq(tripBook.id, tripBookId))
    .limit(1);

  if (!tripRow) {
    notFound();
  }

  const [callerIsOwner, myVariant, sidebar] = await Promise.all([
    isOwner(tripBookId, userId),
    getOrCreateVariantForUser(tripBookId, userId),
    loadSidebarData(userId),
  ]);
  const myVariantId = myVariant.id;

  return (
    <SidebarProvider
      style={
        {
          '--sidebar-width': '19rem',
          '--header-height': '60px',
        } as React.CSSProperties
      }
    >
      <AppSidebar
        myTrips={sidebar.myTrips}
        sharedTrips={sidebar.sharedTrips}
        proposals={sidebar.proposals}
        currentTripId={tripRow.id}
      />
      <SidebarInset>
        <SiteHeader currentTripTitle={tripRow.name} />
        <div className="flex flex-1 overflow-hidden">
          <main className="flex-1 bg-muted/20">
            <TripView
              tripBookId={tripRow.id}
              variantId={myVariantId}
              isOwner={callerIsOwner}
            />
          </main>
          <aside className="w-96 border-l bg-background flex flex-col">
            <TripChat
              tripBookId={tripRow.id}
              variantId={myVariantId}
              userId={userId}
            />
          </aside>
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
