"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Dialog as DialogPrimitive } from "radix-ui";
import {
  CheckCircleIcon,
  GitMergeIcon,
  MapIcon,
  PlaneIcon,
  PlusIcon,
  UsersIcon,
} from "lucide-react";

import { SignInButton, SignUpButton, Show, UserButton } from "@clerk/nextjs";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";

/**
 * Public shape of a sidebar trip-book entry. Mirrors the API response from
 * `GET /api/trips`. The `hasPendingProposal` flag is owner-facing only.
 */
export interface TripSummary {
  id: string;
  name: string;
  role: "owner" | "member";
  updatedAt: string;
  hasPendingProposal: boolean;
}

/** A pending merge proposal awaiting the owner's review. */
export interface ProposalSummary {
  id: string;
  tripBookId: string;
  tripName: string;
  proposedAt: string;
}

export interface AppSidebarProps
  extends Omit<React.ComponentProps<typeof Sidebar>, "children"> {
  myTrips: TripSummary[];
  sharedTrips: TripSummary[];
  /** Owner-only — non-empty triggers the "Pending Proposals" section. */
  proposals: ProposalSummary[];
  currentTripId: string;
}

export function AppSidebar({
  myTrips,
  sharedTrips,
  proposals,
  currentTripId,
  ...props
}: AppSidebarProps) {
  const [createOpen, setCreateOpen] = React.useState(false);

  return (
    <Sidebar variant="inset" collapsible="offcanvas" {...props}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              asChild
              className="data-[slot=sidebar-menu-button]:p-1.5!"
            >
              <Link href="/dashboard">
                <MapIcon className="size-5!" />
                <span className="text-base font-semibold">Taxidi</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>My Trips</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {myTrips.length === 0 ? (
                <SidebarMenuItem>
                  <span className="px-3 py-2 text-xs text-muted-foreground">
                    No trips yet
                  </span>
                </SidebarMenuItem>
              ) : (
                myTrips.map((trip) => (
                  <SidebarMenuItem key={trip.id}>
                    <SidebarMenuButton
                      asChild
                      isActive={currentTripId === trip.id}
                    >
                      <Link href={`/trips/${trip.id}`}>
                        <PlaneIcon />
                        <span className="truncate">{trip.name}</span>
                      </Link>
                    </SidebarMenuButton>
                    {trip.hasPendingProposal ? (
                      <SidebarMenuBadge className="text-amber-500">
                        <GitMergeIcon className="size-3.5" />
                      </SidebarMenuBadge>
                    ) : null}
                  </SidebarMenuItem>
                ))
              )}
              <SidebarMenuItem>
                <SidebarMenuButton
                  onClick={() => setCreateOpen(true)}
                  className="text-muted-foreground"
                >
                  <PlusIcon />
                  <span>Create Trip Book</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {sharedTrips.length > 0 ? (
          <SidebarGroup>
            <SidebarGroupLabel>Shared with Me</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {sharedTrips.map((trip) => (
                  <SidebarMenuItem key={trip.id}>
                    <SidebarMenuButton
                      asChild
                      isActive={currentTripId === trip.id}
                    >
                      <Link href={`/trips/${trip.id}`}>
                        <UsersIcon />
                        <span className="truncate">{trip.name}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ) : null}

        {proposals.length > 0 ? (
          <SidebarGroup>
            <SidebarGroupLabel>Pending Proposals</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {proposals.map((proposal) => (
                  <SidebarMenuItem key={proposal.id}>
                    <SidebarMenuButton asChild>
                      <Link
                        href={`/trips/${proposal.tripBookId}/proposals/${proposal.id}`}
                      >
                        <CheckCircleIcon className="text-amber-500" />
                        <span className="truncate">
                          Review &quot;{proposal.tripName}&quot;
                        </span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ) : null}
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <Show when="signed-in">
              <div className="flex items-center gap-2 px-2 py-1.5">
                <UserButton
                  appearance={{
                    elements: { userButtonAvatarBox: "size-7" },
                  }}
                />
                <span className="text-sm text-muted-foreground">Account</span>
              </div>
            </Show>
            <Show when="signed-out">
              <div className="flex flex-col gap-2 px-2 py-1.5">
                <SignInButton mode="modal">
                  <Button variant="outline" size="sm" className="w-full">
                    Sign in
                  </Button>
                </SignInButton>
                <SignUpButton mode="modal">
                  <Button size="sm" className="w-full">
                    Sign up
                  </Button>
                </SignUpButton>
              </div>
            </Show>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>

      <CreateTripDialog open={createOpen} onOpenChange={setCreateOpen} />
    </Sidebar>
  );
}

/**
 * Self-contained "Create Trip Book" dialog. We use the underlying radix
 * primitives directly (no shared `ui/dialog` component yet) so this file is
 * the only thing that has to change to add the create flow.
 */
function CreateTripDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [name, setName] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Reset form whenever the dialog closes so the next open is clean.
  React.useEffect(() => {
    if (!open) {
      setName("");
      setSubmitting(false);
      setError(null);
    }
  }, [open]);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!name.trim() || submitting) return;
    setSubmitting(true);
    setError(null);

    try {
      const response = await fetch("/api/trips", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
      });
      if (!response.ok) {
        const body = (await response
          .json()
          .catch(() => ({}))) as { error?: string };
        setError(body.error ?? "Could not create trip");
        setSubmitting(false);
        return;
      }
      const created = (await response.json()) as { id: string };
      onOpenChange(false);
      router.push(`/trips/${created.id}`);
      router.refresh();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not reach the server",
      );
      setSubmitting(false);
    }
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className={cn(
            "fixed inset-0 z-50 bg-black/40 backdrop-blur-sm",
            "data-[state=open]:animate-in data-[state=closed]:animate-out",
            "data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0",
          )}
        />
        <DialogPrimitive.Content
          className={cn(
            "fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2",
            "rounded-lg border bg-background p-6 shadow-lg",
            "data-[state=open]:animate-in data-[state=closed]:animate-out",
            "data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0",
            "data-[state=open]:zoom-in-95 data-[state=closed]:zoom-out-95",
          )}
        >
          <DialogPrimitive.Title className="text-lg font-semibold">
            Create Trip Book
          </DialogPrimitive.Title>
          <DialogPrimitive.Description className="mt-1 text-sm text-muted-foreground">
            One trip book = one trip. You can invite collaborators after it&apos;s
            created.
          </DialogPrimitive.Description>
          <form onSubmit={handleSubmit} className="mt-4 flex flex-col gap-3">
            <label htmlFor="new-trip-name" className="text-sm font-medium">
              Trip name
            </label>
            <Input
              id="new-trip-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Japan 2027"
              maxLength={200}
              autoFocus
              required
            />
            {error ? (
              <p className="text-sm text-destructive">{error}</p>
            ) : null}
            <div className="mt-2 flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={submitting}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={!name.trim() || submitting}>
                {submitting ? "Creating…" : "Create"}
              </Button>
            </div>
          </form>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
