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
import { MapIcon, UsersIcon, PlaneIcon } from "lucide-react"



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
    <Sidebar collapsible="offcanvas" {...props}>
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
      </SidebarContent>
      <SidebarFooter>
        {/* We can place the UserButton from Clerk here later */}
      </SidebarFooter>
    </Sidebar>
  )
}

