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

const data = {
  myTrips: [
    { title: "Summer in Greece", url: "#", icon: PlaneIcon },
    { title: "Japan 2027", url: "#", icon: PlaneIcon },
  ],
  sharedTrips: [
    { title: "Family Reunion", url: "#", icon: UsersIcon },
    { title: "Eurotrip with Friends", url: "#", icon: UsersIcon },
  ],
}

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
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
              {data.myTrips.map((item) => (
                <SidebarMenuItem key={item.title}>
                  <SidebarMenuButton asChild>
                    <a href={item.url}>
                      <item.icon />
                      <span>{item.title}</span>
                    </a>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel>Shared with Me</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {data.sharedTrips.map((item) => (
                <SidebarMenuItem key={item.title}>
                  <SidebarMenuButton asChild>
                    <a href={item.url}>
                      <item.icon />
                      <span>{item.title}</span>
                    </a>
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

