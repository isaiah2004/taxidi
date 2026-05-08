/**
 * Persistence helpers for agent runs.
 *
 * Every agent invocation gets exactly one `agent_run` row plus N `agent_run_step`
 * rows — one per tool call. The unique `(agent_run_id, idempotency_key)` index
 * makes step inserts idempotent: a retried tool call replays as a no-op rather
 * than double-mutating the variant.
 *
 * Idempotency keys are derived from `(toolName, toolInput)` via SHA-256 so they
 * are stable across process restarts and don't need to be carried by the agent
 * runtime.
 *
 * Chat-message persistence lives here too because the agent needs to write
 * assistant / tool turns alongside the run record.
 */
import { createHash } from 'node:crypto';

import { sql } from 'drizzle-orm';

import * as schema from '@/db/schema';
import { db } from '@/lib/db';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StartAgentRunInput {
  tripBookId: string;
  variantId: string | null;
  kind: 'edit' | 'merge' | 'rebase';
  triggeredByUserId: string;
  model: string;
  mergeProposalId?: string;
}

export interface RecordStepInput {
  agentRunId: string;
  idx: number;
  toolName: string;
  toolInput: unknown;
  toolOutput?: unknown;
  idempotencyKey: string;
}

export interface FinishAgentRunInput {
  agentRunId: string;
  status: 'succeeded' | 'failed';
  totalInputTokens?: number;
  totalOutputTokens?: number;
  toolCallsSummary?: unknown;
}

export interface AppendChatMessageInput {
  tripBookId: string;
  userId: string | null;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  agentRunId?: string | null;
  variantId?: string | null;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Derive a deterministic idempotency key from a tool call. SHA-256 of
 * `toolName + JSON.stringify(input)` so that semantically identical retries
 * produce the same key. Caveat: order-sensitive over object keys — callers
 * that pass JS objects with non-deterministic key ordering should pre-canonicalize.
 */
export function makeIdempotencyKey(toolName: string, input: unknown): string {
  return createHash('sha256')
    .update(toolName + JSON.stringify(input))
    .digest('hex');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Insert an `agent_run` row in `running` status. The DB default is `queued`,
 * but we set `running` here because agents call this synchronously at the
 * start of work — there's no separate scheduler stage today.
 */
export async function startAgentRun(input: StartAgentRunInput): Promise<string> {
  const [row] = await db
    .insert(schema.agentRun)
    .values({
      tripBookId: input.tripBookId,
      variantId: input.variantId,
      kind: input.kind,
      triggeredByUserId: input.triggeredByUserId,
      model: input.model,
      mergeProposalId: input.mergeProposalId ?? null,
      status: 'running',
    })
    .returning({ id: schema.agentRun.id });

  if (!row) {
    throw new Error('startAgentRun: insert returned no row');
  }
  return row.id;
}

/**
 * Insert an `agent_run_step`. The unique index on
 * `(agent_run_id, idempotency_key)` lets us use `ON CONFLICT DO NOTHING` so a
 * replayed tool call resolves as a no-op instead of throwing.
 */
export async function recordStep(input: RecordStepInput): Promise<void> {
  await db
    .insert(schema.agentRunStep)
    .values({
      agentRunId: input.agentRunId,
      idx: input.idx,
      toolName: input.toolName,
      toolInput: input.toolInput,
      toolOutput: input.toolOutput ?? null,
      idempotencyKey: input.idempotencyKey,
    })
    .onConflictDoNothing({
      target: [
        schema.agentRunStep.agentRunId,
        schema.agentRunStep.idempotencyKey,
      ],
    });
}

/**
 * Mark an agent run as terminated. Sets `finished_at = now()` and folds in
 * token totals / tool-call summary if provided. Does not touch step rows.
 */
export async function finishAgentRun(input: FinishAgentRunInput): Promise<void> {
  await db
    .update(schema.agentRun)
    .set({
      status: input.status,
      finishedAt: sql`now()`,
      // Only overwrite the existing default of 0 when the caller provided a
      // value — leaves running totals (if any) intact.
      ...(input.totalInputTokens !== undefined
        ? { totalInputTokens: input.totalInputTokens }
        : {}),
      ...(input.totalOutputTokens !== undefined
        ? { totalOutputTokens: input.totalOutputTokens }
        : {}),
      ...(input.toolCallsSummary !== undefined
        ? { toolCallsSummary: input.toolCallsSummary }
        : {}),
    })
    .where(sql`${schema.agentRun.id} = ${input.agentRunId}`);
}

/**
 * Append a chat message. `userId` is null for assistant / tool / system roles.
 * `agentRunId` ties an assistant message to the run that produced it;
 * `variantId` attributes the message to a specific variant edit.
 */
export async function appendChatMessage(
  input: AppendChatMessageInput,
): Promise<{ id: string }> {
  const [row] = await db
    .insert(schema.chatMessage)
    .values({
      tripBookId: input.tripBookId,
      userId: input.userId,
      role: input.role,
      content: input.content,
      agentRunId: input.agentRunId ?? null,
      variantId: input.variantId ?? null,
    })
    .returning({ id: schema.chatMessage.id });

  if (!row) {
    throw new Error('appendChatMessage: insert returned no row');
  }
  return { id: row.id };
}
