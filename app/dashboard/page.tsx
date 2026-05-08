"use client";

import { AppSidebar } from "@/components/app-sidebar"
import { SiteHeader } from "@/components/site-header"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { SendIcon } from "lucide-react"
import { useChat } from "@ai-sdk/react"

export default function Page() {
  const { messages, input, handleInputChange, handleSubmit } = useChat();

  return (
    <SidebarProvider
      style={
        {
          "--sidebar-width": "calc(var(--spacing) * 64)",
          "--header-height": "calc(var(--spacing) * 12)",
        } as React.CSSProperties
      }
    >
      <AppSidebar variant="inset" />
      <SidebarInset>
        <SiteHeader />
        <div className="flex flex-1 overflow-hidden">
          {/* Main Area: Trip Canvas */}
          <main className="flex-1 flex flex-col items-center justify-center bg-muted/20 relative">
            <div className="text-center p-8">
              <h2 className="text-2xl font-semibold mb-2">Trip Canvas</h2>
              <p className="text-muted-foreground text-sm">Plan your trip collaboratively here.</p>
            </div>
            {/* Tree breakdown visualization placeholder */}
            <div className="w-64 h-64 border-2 border-dashed border-muted-foreground/30 rounded-lg flex items-center justify-center opacity-50">
              [Canvas Placeholder]
            </div>
          </main>
          
          {/* Right Panel: Chat Window */}
          <aside className="w-80 border-l bg-background flex flex-col">
            <div className="p-4 border-b font-medium">Trip Chat</div>
            <div className="flex-1 p-4 overflow-y-auto flex flex-col gap-4">
              {messages.length === 0 ? (
                <div className="text-sm text-muted-foreground text-center my-4">
                  Chat history goes here
                </div>
              ) : (
                messages.map((m) => (
                  <div key={m.id} className={`flex flex-col ${m.role === 'user' ? 'items-end' : 'items-start'}`}>
                    <div className={`px-3 py-2 rounded-lg max-w-[85%] text-sm ${
                      m.role === 'user' ? 'bg-primary text-primary-foreground' : 'bg-muted'
                    }`}>
                      {m.content}
                    </div>
                  </div>
                ))
              )}
            </div>
            <form onSubmit={handleSubmit} className="p-4 border-t flex gap-2">
              <Input 
                type="text" 
                value={input}
                onChange={handleInputChange}
                placeholder="Type a message..." 
                className="flex-1"
              />
              <Button type="submit" size="icon" disabled={!input.trim()}>
                <SendIcon className="size-4" />
                <span className="sr-only">Send</span>
              </Button>
            </form>
          </aside>
        </div>
      </SidebarInset>
    </SidebarProvider>
  )
}

