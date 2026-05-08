"use client"

import * as React from "react"

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarGroupContent,
} from "@/components/ui/sidebar"
import { MapIcon, PlaneIcon } from "lucide-react"
import { SignInButton, SignUpButton, Show, UserButton } from "@clerk/nextjs"
import { Button } from "@/components/ui/button"



export type Trip = { id: string; title: string; url: string; icon: any };

export interface AppSidebarProps extends React.ComponentProps<typeof Sidebar> {
  myTrips: Trip[];
  sharedTrips: Trip[];
  onCreateTrip: () => void;
  onSelectTrip: (trip: Trip) => void;
  currentTripId: string | null;
}

export function AppSidebar({ myTrips, sharedTrips, onCreateTrip, onSelectTrip, currentTripId, ...props }: AppSidebarProps) {
  return (
    <Sidebar variant="inset" collapsible="offcanvas" {...props}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild className="data-[slot=sidebar-menu-button]:p-1.5!">
              <a href="#">
                <MapIcon className="size-5!" />
                <span className="text-base font-semibold">Taxidi</span>
              </a>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>My Trips</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {myTrips.map((item) => (
                <SidebarMenuItem key={item.id}>
                  <SidebarMenuButton
                    isActive={currentTripId === item.id}
                    onClick={() => onSelectTrip(item)}
                  >
                    <item.icon />
                    <span>{item.title}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
              <SidebarMenuItem>
                <SidebarMenuButton onClick={onCreateTrip} className="text-muted-foreground">
                  <PlaneIcon />
                  <span>+ Create Tripbook</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        {sharedTrips.length > 0 && (
          <SidebarGroup>
            <SidebarGroupLabel>Shared with Me</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {sharedTrips.map((item) => (
                  <SidebarMenuItem key={item.id}>
                    <SidebarMenuButton
                      isActive={currentTripId === item.id}
                      onClick={() => onSelectTrip(item)}
                    >
                      <item.icon />
                      <span>{item.title}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <Show when="signed-in">
              <div className="flex items-center gap-2 px-2 py-1.5">
                <UserButton
                  appearance={{ elements: { userButtonAvatarBox: "size-7" } }}
                />
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
    </Sidebar>
  )
}

