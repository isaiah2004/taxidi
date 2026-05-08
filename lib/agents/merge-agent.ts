/**
 * Merge agent. Reconciles a member's variant against the current main
 * snapshot under the trip-book owner's free-text instructions.
 *
 * Inputs:
 *   - mainSnapshot         current `main_version.snapshot` (the owner's "ours")
 *   - variantSnapshot      the proposal's frozen variant snapshot ("theirs")
 *   - computedDiff         pre-computed `diff(main, variant)` ops
 *   - ownerInstructions    free-text guidance ("merge everything except ...")
 *
 * The agent emits a sequence of `apply_op` tool calls that — when applied to
 * `mainSnapshot` via `applyDiff` — produce the desired merged snapshot. When a
 * genuine conflict exists (both sides moved / updated / deleted the same
 * `originId` in conflicting ways), it calls `flag_conflict` instead so the
 * owner can resolve manually.
 *
 * The function does NOT commit anything. It returns the proposed snapshot,
 * the ops the agent chose, and any conflicts; the caller (the `commit`
 * endpoint) is responsible for transactional persistence after the owner
 * approves.
 *
 * Persistence: every tool call is persisted as an `agent_run_step` with a
 * deterministic idempotency key, so a retry within the same `agent_run` is a
 * no-op rather than a duplicate mutation.
 */
import { google } from '@ai-sdk/google';
import { stepCountIs, streamText, tool } from 'ai';
import { z } from 'zod';

import { applyDiff, type DiffOp } from '@/lib/diff';
import type { SerializedSnapshot } from '@/lib/graph';

import {
  finishAgentRun,
  makeIdempotencyKey,
  recordStep,
  startAgentRun,
} from './persist';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Conflict surfaced to the owner for manual resolution. */
export interface MergeConflictRow {
  originId: string;
  kind:
    | 'update_update'
    | 'delete_update'
    | 'update_delete'
    | 'move_collision'
    | 'add_add';
  reason: string;
  mainValue?: unknown;
  variantValue?: unknown;
}

export interface MergeAgentInput {
  tripBookId: string;
  proposalId: string;
  variantId: string;
  userId: string;
  mainSnapshot: SerializedSnapshot;
  variantSnapshot: SerializedSnapshot;
  computedDiff: { ops: DiffOp[] };
  ownerInstructions: string;
}

export interface MergeAgentResult {
  proposedSnapshot: SerializedSnapshot;
  opsApplied: DiffOp[];
  conflicts: MergeConflictRow[];
  agentRunId: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MODEL_ID = 'gemini-2.0-flash-exp';
const MAX_STEPS = 50;

const SYSTEM_PROMPT = `You are Taxidi's merge agent. The trip-book owner has supplied free-text instructions about how to reconcile a member's variant against the current main. You will be given:
- main snapshot (current main; the owner's side)
- variant snapshot (frozen at proposal time; the member's side)
- a computed diff (the variant minus main, as DiffOp list)
- owner instructions (the human guidance you must respect)

Your job: emit a sequence of apply_op calls that, when applied to main, produce the desired merged result respecting the owner's instructions.

Rules:
- Use apply_op for every change you want to keep.
- If the owner says to "merge everything", apply every op from the computed diff.
- If the owner says to drop / skip / discard certain changes, simply omit those ops.
- Use flag_conflict ONLY for genuine, hard-to-decide conflicts (e.g. both sides moved the same node to different parents). Do not flag every UPDATE — those are fine to apply.
- Do not invent ops that weren't in the computed diff. Reject hallucinated origin ids.
- Stop calling tools once you've emitted everything that should be applied.`;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const applyOpSchema = z.object({
  op: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('add'),
      originId: z.string(),
      payload: z.any(),
    }),
    z.object({
      kind: z.literal('update'),
      originId: z.string(),
      patch: z.record(z.string(), z.unknown()),
    }),
    z.object({
      kind: z.literal('delete'),
      originId: z.string(),
    }),
    z.object({
      kind: z.literal('move'),
      originId: z.string(),
      newParentOriginId: z.string().nullable(),
      newSortIndex: z.number().int(),
    }),
  ]),
});

const flagConflictSchema = z.object({
  originId: z.string(),
  kind: z.enum([
    'update_update',
    'delete_update',
    'update_delete',
    'move_collision',
    'add_add',
  ]),
  reason: z.string(),
  mainValue: z.any().optional(),
  variantValue: z.any().optional(),
});

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run the merge agent end-to-end. Caller is the `merge` route handler; the
 * result is returned as JSON for the owner to preview before committing.
 */
export async function runMergeAgent(
  input: MergeAgentInput,
): Promise<MergeAgentResult> {
  const agentRunId = await startAgentRun({
    tripBookId: input.tripBookId,
    variantId: input.variantId,
    kind: 'merge',
    triggeredByUserId: input.userId,
    model: MODEL_ID,
    mergeProposalId: input.proposalId,
  });

  const opsApplied: DiffOp[] = [];
  const conflicts: MergeConflictRow[] = [];
  let stepIdx = 0;

  // Tool definitions. `apply_op` accumulates ops into `opsApplied`;
  // `flag_conflict` accumulates conflicts into `conflicts`. Each tool call is
  // persisted as an agent_run_step so the run is fully traceable.
  const tools = {
    apply_op: tool({
      description:
        'Apply a single ADD / UPDATE / DELETE / MOVE op to the working main snapshot. Pick ops from the computed diff according to the owner instructions.',
      inputSchema: applyOpSchema,
      execute: async ({ op }) => {
        opsApplied.push(op as DiffOp);
        try {
          await recordStep({
            agentRunId,
            idx: stepIdx++,
            toolName: 'apply_op',
            toolInput: { op },
            toolOutput: { ok: true },
            idempotencyKey: makeIdempotencyKey('apply_op', op),
          });
        } catch (e) {
          console.error('[merge-agent] recordStep apply_op failed', e);
        }
        return { ok: true } as const;
      },
    }),
    flag_conflict: tool({
      description:
        'Flag a genuine conflict to surface to the owner for manual resolution. Use sparingly — most simple updates / moves should be applied via apply_op.',
      inputSchema: flagConflictSchema,
      execute: async (c) => {
        conflicts.push(c as MergeConflictRow);
        try {
          await recordStep({
            agentRunId,
            idx: stepIdx++,
            toolName: 'flag_conflict',
            toolInput: c,
            toolOutput: { ok: true },
            idempotencyKey: makeIdempotencyKey('flag_conflict', c),
          });
        } catch (e) {
          console.error('[merge-agent] recordStep flag_conflict failed', e);
        }
        return { ok: true } as const;
      },
    }),
  };

  // Build the prompt. We pass the diff ops verbatim so the model can pick
  // among them rather than hallucinate. `mainSnapshot` and `variantSnapshot`
  // are summarized only — the model doesn't need every node, the diff already
  // captures what changed.
  const prompt = [
    'OWNER INSTRUCTIONS:',
    input.ownerInstructions || '(none provided — apply every op)',
    '',
    'COMPUTED DIFF (the variant minus main; ops to consider):',
    JSON.stringify(input.computedDiff.ops, null, 2),
    '',
    'MAIN SNAPSHOT NODE COUNT: ' + input.mainSnapshot.nodes.length,
    'VARIANT SNAPSHOT NODE COUNT: ' + input.variantSnapshot.nodes.length,
  ].join('\n');

  let runStatus: 'succeeded' | 'failed' = 'succeeded';
  try {
    const result = streamText({
      model: google(MODEL_ID),
      system: SYSTEM_PROMPT,
      prompt,
      tools,
      stopWhen: stepCountIs(MAX_STEPS),
    });

    // Drain the stream so all tool executions complete before we return.
    // `consumeStream()` is the canonical way; it guarantees onFinish has fired.
    await result.consumeStream();
  } catch (err) {
    runStatus = 'failed';
    console.error('[merge-agent] streamText failed', err);
    // Even on model failure, we still produce a fallback: an empty op list
    // means "merge nothing" — the owner can re-run with revised instructions.
  }

  // Compose the proposed snapshot from the ops the agent chose.
  const proposedSnapshot = applyDiff(input.mainSnapshot, { ops: opsApplied });

  try {
    await finishAgentRun({
      agentRunId,
      status: runStatus,
      toolCallsSummary: {
        opsApplied: opsApplied.length,
        conflicts: conflicts.length,
      },
    });
  } catch (e) {
    console.error('[merge-agent] finishAgentRun failed', e);
  }

  return { proposedSnapshot, opsApplied, conflicts, agentRunId };
}
