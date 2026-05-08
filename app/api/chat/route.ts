/**
 * Chat endpoint. Two flavors of request flow through one URL:
 *
 *   1. **No `@taxidi` mention** — answer the user briefly with the model;
 *      no tools, no agent_run row.
 *   2. **`@taxidi` mentioned** — kick off the planner agent with the trip
 *      book + variant context. The planner streams tool calls (proposed
 *      cards) back to the client.
 *
 * The trip book id arrives in the request body alongside `messages`. The
 * server resolves the caller's variant via `getOrCreateVariantForUser` —
 * clients never need to know variant ids upfront.
 */
import { google } from '@ai-sdk/google';
import { convertToModelMessages, streamText, type UIMessage } from 'ai';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import {
  ForbiddenError,
  UnauthenticatedError,
  getCurrentUserId,
  requireMembership,
} from '@/lib/auth';
import { runPlanner } from '@/lib/agents/planner';
import { appendChatMessage } from '@/lib/agents/persist';
import { getOrCreateVariantForUser } from '@/lib/variants';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Allow the planner up to 5 minutes of streaming work (tool calls add up).
// Cloud Run's request timeout caps higher than this; this is a Next-level
// hint for streaming lifetime.
export const maxDuration = 300;

const MENTION_REGEX = /(^|[^A-Za-z0-9_])@taxidi\b/i;
// Fast model for the no-mention path: cheap and snappy for short replies.
const FAST_MODEL_ID = 'gemini-2.5-flash';

// Schema for the chat body. We validate the outer shape (messages array,
// tripBookId uuid) but accept the AI SDK's `UIMessage` shape as opaque since
// it ships its own runtime types and a strict schema here would drift.
const ChatBodySchema = z
  .object({
    messages: z.array(z.unknown()).max(500),
    tripBookId: z.uuid(),
  })
  .strict();

function authErrorResponse(err: unknown): Response | null {
  if (err instanceof UnauthenticatedError) {
    return NextResponse.json({ error: err.message }, { status: 401 });
  }
  if (err instanceof ForbiddenError) {
    return NextResponse.json({ error: err.message }, { status: 403 });
  }
  return null;
}

/**
 * Extract concatenated text content from a UIMessage's parts. Tool calls
 * and other non-text parts are ignored — we only check the user's prose
 * for the mention.
 */
function extractText(message: UIMessage | undefined): string {
  if (!message) return '';
  const out: string[] = [];
  for (const part of message.parts) {
    if (part.type === 'text' && typeof part.text === 'string') {
      out.push(part.text);
    }
  }
  return out.join('');
}

export async function POST(req: Request): Promise<Response> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = ChatBodySchema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => ({
      path: i.path.join('.'),
      message: i.message,
    }));
    return NextResponse.json(
      { error: 'Invalid request', details },
      { status: 400 },
    );
  }
  // We trust the AI SDK to validate the message-part shapes when it converts
  // to model messages — we just need the array shape here.
  const messages = parsed.data.messages as UIMessage[];
  const tripBookId = parsed.data.tripBookId;

  let userId: string;
  try {
    userId = await getCurrentUserId();
    await requireMembership(tripBookId, userId);
  } catch (err) {
    const resp = authErrorResponse(err);
    if (resp) return resp;
    throw err;
  }

  const lastMessage = messages[messages.length - 1];
  const lastText = extractText(lastMessage);
  const hasMention = MENTION_REGEX.test(lastText);

  // Persist the user's turn before we start streaming. This lets the
  // realtime feed surface the message to other members immediately even if
  // the assistant takes a while.
  if (lastMessage?.role === 'user' && lastText.trim().length > 0) {
    try {
      await appendChatMessage({
        tripBookId,
        userId,
        role: 'user',
        content: lastText,
      });
    } catch (e) {
      console.error('[chat] persist user message failed', e);
      // continue — the chat shouldn't fail just because we couldn't log
    }
  }

  // No mention: short, tool-less reply. Persist the assistant text via
  // onFinish for chat-history hydration.
  if (!hasMention) {
    const modelMessages = await convertToModelMessages(messages, {
      ignoreIncompleteToolCalls: true,
    });

    const result = streamText({
      model: google(FAST_MODEL_ID),
      system:
        'You are a helpful trip planning assistant. Tag @taxidi to research, propose places, and edit the trip plan. Without the tag, keep replies brief and conversational.',
      messages: modelMessages,
      onFinish: async ({ text }) => {
        if (!text) return;
        try {
          await appendChatMessage({
            tripBookId,
            userId: null,
            role: 'assistant',
            content: text,
          });
        } catch (e) {
          console.error('[chat] persist assistant message failed', e);
        }
      },
    });

    return result.toUIMessageStreamResponse();
  }

  // Mention path: dispatch the planner. It owns the agent_run row,
  // tool execution, and final UI stream.
  const variantSummary = await getOrCreateVariantForUser(tripBookId, userId);
  return runPlanner({
    tripBookId,
    variantId: variantSummary.id,
    userId,
    messages,
  });
}
