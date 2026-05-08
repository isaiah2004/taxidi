import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { SidebarTrigger } from "@/components/ui/sidebar"

import { UserPlusIcon } from "lucide-react"

export function SiteHeader({ currentTripTitle = "Trip Board" }: { currentTripTitle?: string }) {
  return (
    <header className="flex min-h-(--header-height) shrink-0 items-center gap-2 border-b transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:min-h-(--header-height)">
      <div className="flex w-full items-center justify-between px-4 lg:px-6">
        <div className="flex items-center gap-1 lg:gap-2">
          <SidebarTrigger className="-ml-1" />
          <Separator
            orientation="vertical"
            className="mx-2 data-[orientation=vertical]:h-4"
          />
          <h1 className="text-base font-medium">{currentTripTitle}</h1>
        </div>
        <Button variant="outline" size="sm" className="gap-2" onClick={() => alert("Share dialog would open here")}>
          <UserPlusIcon className="size-4" />
          Invite
        </Button>
      </div>
    </header>
  )
}
