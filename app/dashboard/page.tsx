"use client";

import { AppSidebar } from "@/components/app-sidebar"
import { SiteHeader } from "@/components/site-header"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { SendIcon, PlaneIcon, UsersIcon } from "lucide-react"
import { useChat } from "@ai-sdk/react"
import { useState } from "react"

import { Trip } from "@/components/app-sidebar"

const INITIAL_TRIPS: Trip[] = [
  { id: "1", title: "Summer in Greece", url: "#", icon: PlaneIcon },
  { id: "2", title: "Japan 2027", url: "#", icon: PlaneIcon },
];

const SHARED_TRIPS: Trip[] = [
  { id: "3", title: "Family Reunion", url: "#", icon: UsersIcon },
];

export default function Page() {
  const [myTrips, setMyTrips] = useState<Trip[]>(INITIAL_TRIPS);
  const [sharedTrips] = useState<Trip[]>(SHARED_TRIPS);
  const [currentTripId, setCurrentTripId] = useState<string>("1");

  const currentTrip = [...myTrips, ...sharedTrips].find(t => t.id === currentTripId);

  const { messages, sendMessage } = useChat();
  const [input, setInput] = useState("");

  const handleCreateTrip = () => {
    const newTripTitle = prompt("Enter a name for your new Tripbook:");
    if (!newTripTitle) return;
    const newTrip: Trip = {
      id: Date.now().toString(),
      title: newTripTitle,
      url: "#",
      icon: PlaneIcon
    };
    setMyTrips([...myTrips, newTrip]);
    setCurrentTripId(newTrip.id);
  };


  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setInput(e.target.value);
  };

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!input.trim()) return;
    sendMessage({ role: "user", parts: [{ type: "text", text: input }], id: Date.now().toString() });
    setInput("");
  };

  return (
    <SidebarProvider
      style={
        {
          "--sidebar-width": "19rem",
        } as React.CSSProperties
      }
    >
      <AppSidebar 
        myTrips={myTrips} 
        sharedTrips={sharedTrips}
        currentTripId={currentTripId}
        onCreateTrip={handleCreateTrip}
        onSelectTrip={(trip) => setCurrentTripId(trip.id)}
      />
      <SidebarInset>
        <SiteHeader currentTripTitle={currentTrip?.title || "Trip Board"} />
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
                  Welcome to the {currentTrip?.title} chat!
                </div>
              ) : (
                messages.map((m) => (
                  <div key={m.id} className={`flex flex-col ${m.role === 'user' ? 'items-end' : 'items-start'}`}>
                    <span className="text-xs text-muted-foreground mb-1 ml-1">
                      {m.role === 'user' ? 'You' : m.role === 'assistant' ? 'Agent' : m.role}
                    </span>
                    <div className={`px-3 py-2 rounded-lg max-w-[85%] text-sm ${
                      m.role === 'user' ? 'bg-primary text-primary-foreground' : 'bg-muted'
                    }`}>
                      {m.parts ? m.parts.map((p: any) => p.type === 'text' ? p.text : '').join('') : (m as any).content}
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

