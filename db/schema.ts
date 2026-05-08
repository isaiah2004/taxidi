import { sql } from 'drizzle-orm';
import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Taxidi schema. Naming: snake_case columns, camelCase Drizzle exports.
 *
 * UUID PKs default to Postgres-native `gen_random_uuid()` (built-in via the
 * `pgcrypto`/`pg_random` functions in PG 13+; available on Cloud SQL for
 * Postgres 16). We use `sql\`gen_random_uuid()\`` rather than Drizzle's
 * `defaultRandom()` so the generated SQL is explicit in migrations.
 *
 * Soft-delete is handled per-table where the plan calls for it (e.g. `node`).
 * `created_at`/`updated_at` are stored as `timestamp with time zone` and are
 * managed by Drizzle (`defaultNow()` + `$onUpdate` for `updated_at`).
 */

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const memberRoleEnum = pgEnum('member_role', ['owner', 'member']);
export const memberStatusEnum = pgEnum('member_status', ['invited', 'active']);

export const nodeTypeEnum = pgEnum('node_type', [
  'trip',
  'day',
  'destination',
  'transport',
  'lodging',
  'activity',
  'meal',
  'note',
]);

export const chatRoleEnum = pgEnum('chat_role', [
  'user',
  'assistant',
  'tool',
  'system',
]);

export const agentRunKindEnum = pgEnum('agent_run_kind', [
  'edit',
  'merge',
  'rebase',
]);

export const agentRunStatusEnum = pgEnum('agent_run_status', [
  'queued',
  'running',
  'succeeded',
  'failed',
]);

export const variantStatusEnum = pgEnum('variant_status', [
  'draft',
  'proposed',
  'merged',
  'rejected',
  'stale',
]);

export const mergeProposalStatusEnum = pgEnum('merge_proposal_status', [
  'pending',
  'merged',
  'rejected',
  'withdrawn',
]);

export const mergeConflictKindEnum = pgEnum('merge_conflict_kind', [
  'update_update',
  'delete_update',
  'update_delete',
  'move_collision',
  'add_add',
]);

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

/**
 * One trip book = one trip. The owner's user id is the Clerk user id (text);
 * `current_main_version_id` points at the latest committed `main_version`
 * snapshot. The FK is added as a deferred reference (it's nullable + we set
 * it after creating the first `main_version`) so we don't have a chicken-
 * and-egg cycle.
 */
export const tripBook = pgTable(
  'trip_book',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    name: text('name').notNull(),
    ownerUserId: text('owner_user_id').notNull(),
    currentMainVersionId: uuid('current_main_version_id'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index('trip_book_owner_user_id_idx').on(t.ownerUserId),
    index('trip_book_current_main_version_id_idx').on(t.currentMainVersionId),
  ],
);

/**
 * Composite-PK membership table. Clerk user ids are `text`. Non-active rows
 * may carry an `invitation_token`; once accepted, `joined_at` is set.
 */
export const membership = pgTable(
  'membership',
  {
    tripBookId: uuid('trip_book_id')
      .notNull()
      .references(() => tripBook.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    role: memberRoleEnum('role').notNull(),
    status: memberStatusEnum('status').notNull(),
    invitedByUserId: text('invited_by_user_id'),
    invitationToken: text('invitation_token'),
    joinedAt: timestamp('joined_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    primaryKey({ columns: [t.tripBookId, t.userId] }),
    index('membership_user_id_idx').on(t.userId),
    index('membership_trip_book_id_idx').on(t.tripBookId),
    uniqueIndex('membership_invitation_token_uq').on(t.invitationToken),
  ],
);

/**
 * Append-only canonical history. `snapshot` is the full plan tree as JSONB.
 * The UNIQUE on `(trip_book_id, parent_version_id)` prevents two simultaneous
 * merges from forking main: only one row may claim a given parent.
 */
export const mainVersion = pgTable(
  'main_version',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tripBookId: uuid('trip_book_id')
      .notNull()
      .references(() => tripBook.id, { onDelete: 'cascade' }),
    parentVersionId: uuid('parent_version_id'),
    snapshot: jsonb('snapshot').notNull(),
    committedByUserId: text('committed_by_user_id').notNull(),
    committedAt: timestamp('committed_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    message: text('message'),
  },
  (t) => [
    index('main_version_trip_book_id_idx').on(t.tripBookId),
    index('main_version_parent_version_id_idx').on(t.parentVersionId),
    uniqueIndex('main_version_trip_book_parent_uq').on(
      t.tripBookId,
      t.parentVersionId,
    ),
  ],
);

/**
 * Per-user working copy. Owner gets one too. UNIQUE on (trip_book_id,
 * owner_user_id) enforces "one variant per user per trip book".
 */
export const variant = pgTable(
  'variant',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tripBookId: uuid('trip_book_id')
      .notNull()
      .references(() => tripBook.id, { onDelete: 'cascade' }),
    ownerUserId: text('owner_user_id').notNull(),
    baseMainVersionId: uuid('base_main_version_id')
      .notNull()
      .references(() => mainVersion.id, { onDelete: 'restrict' }),
    status: variantStatusEnum('status').notNull().default('draft'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index('variant_trip_book_id_idx').on(t.tripBookId),
    index('variant_owner_user_id_idx').on(t.ownerUserId),
    index('variant_base_main_version_id_idx').on(t.baseMainVersionId),
    uniqueIndex('variant_trip_book_owner_uq').on(t.tripBookId, t.ownerUserId),
  ],
);

/**
 * Per-variant normalized node rows. `origin_id` is a stable identity across
 * variants so diffs can key by it. `parent_node_id` is a self-reference for
 * Trip → Day → child structure. Soft-delete via `deleted bool`.
 *
 * Per-type fields (e.g. transport's `from_origin_id`/`to_origin_id`, lodging
 * check-in/out, activity duration/booking) live in `type_data` JSONB rather
 * than dozens of nullable columns.
 */
export const node = pgTable(
  'node',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    variantId: uuid('variant_id')
      .notNull()
      .references(() => variant.id, { onDelete: 'cascade' }),
    originId: uuid('origin_id').notNull(),
    type: nodeTypeEnum('type').notNull(),
    parentNodeId: uuid('parent_node_id'),
    sortIndex: integer('sort_index').notNull().default(0),
    title: text('title').notNull(),
    notes: text('notes'),
    startAt: timestamp('start_at', { withTimezone: true }),
    endAt: timestamp('end_at', { withTimezone: true }),
    locationPlaceId: text('location_place_id'),
    locationLat: doublePrecision('location_lat'),
    locationLng: doublePrecision('location_lng'),
    locationAddress: text('location_address'),
    placeRefreshedAt: timestamp('place_refreshed_at', { withTimezone: true }),
    typeData: jsonb('type_data').notNull().default(sql`'{}'::jsonb`),
    version: integer('version').notNull().default(1),
    deleted: boolean('deleted').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index('node_variant_id_idx').on(t.variantId),
    index('node_parent_node_id_idx').on(t.parentNodeId),
    index('node_origin_id_idx').on(t.originId),
    index('node_type_idx').on(t.type),
    uniqueIndex('node_variant_origin_uq').on(t.variantId, t.originId),
  ],
);

/**
 * Chat is per-trip-book (members chat together). `user_id` is null for
 * assistant/tool/system messages. `agent_run_id` ties an assistant message
 * to the run that produced it; `variant_id` attributes a message to a
 * variant edit (e.g. "Member B edited Day 2").
 */
export const chatMessage = pgTable(
  'chat_message',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tripBookId: uuid('trip_book_id')
      .notNull()
      .references(() => tripBook.id, { onDelete: 'cascade' }),
    userId: text('user_id'),
    role: chatRoleEnum('role').notNull(),
    content: text('content').notNull(),
    agentRunId: uuid('agent_run_id'),
    variantId: uuid('variant_id').references(() => variant.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('chat_message_trip_book_id_idx').on(t.tripBookId),
    index('chat_message_user_id_idx').on(t.userId),
    index('chat_message_agent_run_id_idx').on(t.agentRunId),
    index('chat_message_variant_id_idx').on(t.variantId),
    index('chat_message_trip_book_created_at_idx').on(
      t.tripBookId,
      t.createdAt,
    ),
  ],
);

/**
 * One row per agent invocation (edit | merge | rebase). `tool_calls_summary`
 * is a truncated JSON list for the UI; full call history lives in
 * `agent_run_step`.
 */
export const agentRun = pgTable(
  'agent_run',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tripBookId: uuid('trip_book_id')
      .notNull()
      .references(() => tripBook.id, { onDelete: 'cascade' }),
    variantId: uuid('variant_id').references(() => variant.id, {
      onDelete: 'set null',
    }),
    kind: agentRunKindEnum('kind').notNull(),
    triggeredByUserId: text('triggered_by_user_id').notNull(),
    mergeProposalId: uuid('merge_proposal_id'),
    status: agentRunStatusEnum('status').notNull().default('queued'),
    model: text('model').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    toolCallsSummary: jsonb('tool_calls_summary'),
    totalInputTokens: integer('total_input_tokens').notNull().default(0),
    totalOutputTokens: integer('total_output_tokens').notNull().default(0),
  },
  (t) => [
    index('agent_run_trip_book_id_idx').on(t.tripBookId),
    index('agent_run_variant_id_idx').on(t.variantId),
    index('agent_run_merge_proposal_id_idx').on(t.mergeProposalId),
    index('agent_run_triggered_by_user_id_idx').on(t.triggeredByUserId),
    index('agent_run_status_idx').on(t.status),
  ],
);

/**
 * Per-tool-call record. `idempotency_key` is unique per `agent_run_id` so a
 * tool retry replays as a no-op rather than double-mutating the variant.
 */
export const agentRunStep = pgTable(
  'agent_run_step',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    agentRunId: uuid('agent_run_id')
      .notNull()
      .references(() => agentRun.id, { onDelete: 'cascade' }),
    idx: integer('idx').notNull(),
    toolName: text('tool_name').notNull(),
    toolInput: jsonb('tool_input').notNull(),
    toolOutput: jsonb('tool_output'),
    idempotencyKey: text('idempotency_key').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('agent_run_step_agent_run_id_idx').on(t.agentRunId),
    uniqueIndex('agent_run_step_run_idempotency_uq').on(
      t.agentRunId,
      t.idempotencyKey,
    ),
  ],
);

/**
 * A variant snapshot frozen at proposal time so the merge agent runs against
 * a stable input even if the member keeps editing.
 */
export const mergeProposal = pgTable(
  'merge_proposal',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tripBookId: uuid('trip_book_id')
      .notNull()
      .references(() => tripBook.id, { onDelete: 'cascade' }),
    variantId: uuid('variant_id')
      .notNull()
      .references(() => variant.id, { onDelete: 'cascade' }),
    variantSnapshot: jsonb('variant_snapshot').notNull(),
    status: mergeProposalStatusEnum('status').notNull().default('pending'),
    proposedAt: timestamp('proposed_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    ownerInstructions: text('owner_instructions'),
    mergeRunId: uuid('merge_run_id').references(() => agentRun.id, {
      onDelete: 'set null',
    }),
    resultingMainVersionId: uuid('resulting_main_version_id').references(
      () => mainVersion.id,
      { onDelete: 'set null' },
    ),
  },
  (t) => [
    index('merge_proposal_trip_book_id_idx').on(t.tripBookId),
    index('merge_proposal_variant_id_idx').on(t.variantId),
    index('merge_proposal_status_idx').on(t.status),
    index('merge_proposal_merge_run_id_idx').on(t.mergeRunId),
    index('merge_proposal_resulting_main_version_id_idx').on(
      t.resultingMainVersionId,
    ),
  ],
);

/**
 * Conflicts surfaced during merge. `resolution` stays null until the owner
 * picks a side; `resolved_value` carries the final value when resolution is
 * `custom`.
 */
export const mergeConflict = pgTable(
  'merge_conflict',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    mergeProposalId: uuid('merge_proposal_id')
      .notNull()
      .references(() => mergeProposal.id, { onDelete: 'cascade' }),
    originId: uuid('origin_id').notNull(),
    kind: mergeConflictKindEnum('kind').notNull(),
    mainValue: jsonb('main_value'),
    variantValue: jsonb('variant_value'),
    resolution: text('resolution'),
    resolvedValue: jsonb('resolved_value'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('merge_conflict_merge_proposal_id_idx').on(t.mergeProposalId),
    index('merge_conflict_origin_id_idx').on(t.originId),
  ],
);

// ---------------------------------------------------------------------------
// Inferred types — handy for callers that don't want to redeclare row shapes.
// ---------------------------------------------------------------------------

export type TripBook = typeof tripBook.$inferSelect;
export type NewTripBook = typeof tripBook.$inferInsert;

export type Membership = typeof membership.$inferSelect;
export type NewMembership = typeof membership.$inferInsert;

export type MainVersion = typeof mainVersion.$inferSelect;
export type NewMainVersion = typeof mainVersion.$inferInsert;

export type Variant = typeof variant.$inferSelect;
export type NewVariant = typeof variant.$inferInsert;

export type Node = typeof node.$inferSelect;
export type NewNode = typeof node.$inferInsert;

export type ChatMessage = typeof chatMessage.$inferSelect;
export type NewChatMessage = typeof chatMessage.$inferInsert;

export type AgentRun = typeof agentRun.$inferSelect;
export type NewAgentRun = typeof agentRun.$inferInsert;

export type AgentRunStep = typeof agentRunStep.$inferSelect;
export type NewAgentRunStep = typeof agentRunStep.$inferInsert;

export type MergeProposal = typeof mergeProposal.$inferSelect;
export type NewMergeProposal = typeof mergeProposal.$inferInsert;

export type MergeConflict = typeof mergeConflict.$inferSelect;
export type NewMergeConflict = typeof mergeConflict.$inferInsert;

export type MemberRole = (typeof memberRoleEnum.enumValues)[number];
export type MemberStatus = (typeof memberStatusEnum.enumValues)[number];
export type NodeType = (typeof nodeTypeEnum.enumValues)[number];
export type ChatRole = (typeof chatRoleEnum.enumValues)[number];
export type AgentRunKind = (typeof agentRunKindEnum.enumValues)[number];
export type AgentRunStatus = (typeof agentRunStatusEnum.enumValues)[number];
export type VariantStatus = (typeof variantStatusEnum.enumValues)[number];
export type MergeProposalStatus =
  (typeof mergeProposalStatusEnum.enumValues)[number];
export type MergeConflictKind =
  (typeof mergeConflictKindEnum.enumValues)[number];
