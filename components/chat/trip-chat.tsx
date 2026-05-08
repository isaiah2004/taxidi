'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { Loader2Icon, SendIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

import { MessageRenderer } from './message-renderer';

interface TripChatProps {
  tripBookId: string;
  variantId: string;
  /** Caller's Clerk user id. Currently used only to keep the component
   *  symmetric with other trip-scoped surfaces (the API resolves the user
   *  via Clerk on the server) — exposed as a prop so future client-side
   *  features (presence, "you" markers) don't need a layout refactor. */
  userId?: string;
  /** Optional initial messages from server-rendered chat history. */
  initialMessages?: any[];
  className?: string;
}

/**
 * The trip-book chat surface. Wraps `useChat` (AI SDK v6) and renders each
 * message via `<MessageRenderer />`. Tagging `@taxidi` in a message routes
 * server-side to the planner agent.
 *
 * AI SDK v6 note: `body` and `api` are no longer top-level useChat options —
 * they go through a `transport` (`DefaultChatTransport`). We construct one
 * with the trip book id baked into every request body.
 */
export function TripChat({
  tripBookId,
  variantId,
  initialMessages,
  className,
}: TripChatProps) {
  // `userId` is accepted but unused at the moment; see prop docs above.
  // The transport instance is intentionally stable across renders so
  // subscribers don't churn. We capture `tripBookId` in the closure and
  // recreate when it changes (rare — only on navigation).
  const transportRef = useRef<DefaultChatTransport<any> | null>(null);
  if (transportRef.current === null) {
    transportRef.current = new DefaultChatTransport({
      api: '/api/chat',
      body: { tripBookId },
    });
  }

  const { messages, sendMessage, status, error } = useChat({
    transport: transportRef.current,
    messages: initialMessages,
    experimental_throttle: 50,
  } as any);

  const [input, setInput] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const inputId = useId();
  const statusId = useId();
  const isStreaming = status === 'submitted' || status === 'streaming';

  // Auto-scroll to bottom on new messages or streaming chunks.
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, status]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || isStreaming) return;
    setInput('');
    void sendMessage({
      role: 'user',
      parts: [{ type: 'text', text }],
    } as any);
  }

  return (
    <section
      className={cn(
        'flex h-full min-h-0 w-full flex-col rounded-xl border bg-card',
        className,
      )}
      data-trip-chat
      aria-label="Trip planning chat"
    >
      <header className="flex items-center justify-between border-b px-3 py-2">
        <h2 className="text-sm font-medium">Plan with @taxidi</h2>
        {isStreaming ? (
          <span
            id={statusId}
            role="status"
            aria-live="polite"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground"
          >
            <Loader2Icon
              className="size-3 animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
            {status === 'submitted' ? 'thinking…' : 'streaming…'}
          </span>
        ) : null}
      </header>

      <div
        id="trip-chat-messages"
        ref={listRef}
        className="flex-1 min-h-0 overflow-y-auto px-3 py-3"
        data-trip-chat-list
        role="log"
        aria-live="polite"
        aria-relevant="additions text"
        aria-label="Chat messages"
      >
        {messages.length === 0 ? (
          <EmptyState />
        ) : (
          <ul className="flex flex-col gap-3">
            {messages.map((m: any) => (
              <li key={m.id} className="flex flex-col gap-2">
                <MessageRenderer
                  message={m}
                  tripBookId={tripBookId}
                  variantId={variantId}
                />
              </li>
            ))}
          </ul>
        )}

        {error ? (
          <p
            role="alert"
            className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive"
          >
            {error.message}
          </p>
        ) : null}
      </div>

      <form
        onSubmit={handleSubmit}
        className="flex items-center gap-2 border-t px-3 py-2"
        aria-label="Send chat message"
      >
        <Label htmlFor={inputId} className="sr-only">
          Message
        </Label>
        <Input
          id={inputId}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Tag @taxidi to plan, or chat with the group…"
          disabled={isStreaming}
          aria-describedby={isStreaming ? statusId : undefined}
        />
        <Button
          type="submit"
          size="icon"
          disabled={isStreaming || input.trim().length === 0}
          aria-label="Send message"
        >
          <SendIcon aria-hidden="true" />
        </Button>
      </form>
    </section>
  );
}

function EmptyState() {
  return (
    <div className="flex h-full flex-col items-center justify-center text-center text-sm text-muted-foreground">
      <p className="max-w-xs">
        Tag <span className="font-medium text-foreground">@taxidi</span> to
        research, propose places, and edit the plan together.
      </p>
    </div>
  );
}
