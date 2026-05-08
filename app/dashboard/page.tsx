"use client";

import { AppSidebar, type Trip } from "@/components/app-sidebar"
import { SiteHeader } from "@/components/site-header"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { Button } from "@/components/ui/button"
import { SendIcon, PlaneIcon } from "lucide-react"
import { useChat } from "@ai-sdk/react"
import { useEffect, useRef, useState } from "react"

const LINE_HEIGHT_PX = 24;
const MAX_LINES = 7;
const MAX_INPUT_HEIGHT_PX = LINE_HEIGHT_PX * MAX_LINES;

export default function Page() {
  const [myTrips, setMyTrips] = useState<Trip[]>([]);
  const [sharedTrips] = useState<Trip[]>([]);
  const [currentTripId, setCurrentTripId] = useState<string | null>(null);

  const currentTrip = [...myTrips, ...sharedTrips].find(t => t.id === currentTripId) ?? null;

  const { messages, sendMessage, status } = useChat();
  const [input, setInput] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_INPUT_HEIGHT_PX)}px`;
  }, [input]);

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

  const submitMessage = () => {
    const text = input.trim();
    if (!text || status === "streaming" || status === "submitted") return;
    sendMessage({ text });
    setInput("");
  };

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    submitMessage();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submitMessage();
    }
  };

  return (
    <SidebarProvider
      style={
        {
          "--sidebar-width": "19rem",
          "--header-height": "60px",
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
        <SiteHeader currentTripTitle={currentTrip?.title} />
        <div className="flex flex-1 overflow-hidden">
          <main className="flex-1 bg-muted/20" />

          <aside className="w-[26rem] border-l bg-background flex flex-col">
            <div className="p-4 border-b font-medium">Trip Chat</div>
            <div className="flex-1 p-4 overflow-y-auto flex flex-col gap-4">
              {messages.length === 0 ? (
                <div className="text-sm text-muted-foreground text-center my-4">
                  Start a conversation.
                </div>
              ) : (
                messages.map((m) => (
                  <div key={m.id} className={`flex flex-col ${m.role === 'user' ? 'items-end' : 'items-start'}`}>
                    <span className="text-xs text-muted-foreground mb-1 ml-1">
                      {m.role === 'user' ? 'You' : m.role === 'assistant' ? 'Agent' : m.role}
                    </span>
                    <div className={`px-3 py-2 rounded-lg max-w-[85%] text-sm whitespace-pre-wrap ${
                      m.role === 'user' ? 'bg-primary text-primary-foreground' : 'bg-muted'
                    }`}>
                      {m.parts ? m.parts.map((p: any) => p.type === 'text' ? p.text : '').join('') : (m as any).content}
                    </div>
                  </div>
                ))
              )}
            </div>
            <form
              onSubmit={handleSubmit}
              className="m-3 flex items-end gap-2 rounded-2xl border border-input bg-background px-3 py-2 transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50"
            >
              <textarea
                ref={textareaRef}
                rows={1}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Type a message..."
                className="flex-1 resize-none border-0 bg-transparent px-0 py-1 text-sm leading-6 outline-none ring-0 placeholder:text-muted-foreground focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0"
                style={{ maxHeight: MAX_INPUT_HEIGHT_PX }}
              />
              <Button
                type="submit"
                size="icon"
                disabled={!input.trim() || status === "streaming" || status === "submitted"}
                className="size-8 shrink-0"
              >
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
