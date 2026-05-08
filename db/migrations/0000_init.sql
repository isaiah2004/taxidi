CREATE TYPE "public"."agent_run_kind" AS ENUM('edit', 'merge', 'rebase');--> statement-breakpoint
CREATE TYPE "public"."agent_run_status" AS ENUM('queued', 'running', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."chat_role" AS ENUM('user', 'assistant', 'tool', 'system');--> statement-breakpoint
CREATE TYPE "public"."member_role" AS ENUM('owner', 'member');--> statement-breakpoint
CREATE TYPE "public"."member_status" AS ENUM('invited', 'active');--> statement-breakpoint
CREATE TYPE "public"."merge_conflict_kind" AS ENUM('update_update', 'delete_update', 'update_delete', 'move_collision', 'add_add');--> statement-breakpoint
CREATE TYPE "public"."merge_proposal_status" AS ENUM('pending', 'merged', 'rejected', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."node_type" AS ENUM('trip', 'day', 'destination', 'transport', 'lodging', 'activity', 'meal', 'note');--> statement-breakpoint
CREATE TYPE "public"."variant_status" AS ENUM('draft', 'proposed', 'merged', 'rejected', 'stale');--> statement-breakpoint
CREATE TABLE "agent_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trip_book_id" uuid NOT NULL,
	"variant_id" uuid,
	"kind" "agent_run_kind" NOT NULL,
	"triggered_by_user_id" text NOT NULL,
	"merge_proposal_id" uuid,
	"status" "agent_run_status" DEFAULT 'queued' NOT NULL,
	"model" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"tool_calls_summary" jsonb,
	"total_input_tokens" integer DEFAULT 0 NOT NULL,
	"total_output_tokens" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_run_step" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_run_id" uuid NOT NULL,
	"idx" integer NOT NULL,
	"tool_name" text NOT NULL,
	"tool_input" jsonb NOT NULL,
	"tool_output" jsonb,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_message" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trip_book_id" uuid NOT NULL,
	"user_id" text,
	"role" "chat_role" NOT NULL,
	"content" text NOT NULL,
	"agent_run_id" uuid,
	"variant_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "main_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trip_book_id" uuid NOT NULL,
	"parent_version_id" uuid,
	"snapshot" jsonb NOT NULL,
	"committed_by_user_id" text NOT NULL,
	"committed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"message" text
);
--> statement-breakpoint
CREATE TABLE "membership" (
	"trip_book_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"role" "member_role" NOT NULL,
	"status" "member_status" NOT NULL,
	"invited_by_user_id" text,
	"invitation_token" text,
	"joined_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "membership_trip_book_id_user_id_pk" PRIMARY KEY("trip_book_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "merge_conflict" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merge_proposal_id" uuid NOT NULL,
	"origin_id" uuid NOT NULL,
	"kind" "merge_conflict_kind" NOT NULL,
	"main_value" jsonb,
	"variant_value" jsonb,
	"resolution" text,
	"resolved_value" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "merge_proposal" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trip_book_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"variant_snapshot" jsonb NOT NULL,
	"status" "merge_proposal_status" DEFAULT 'pending' NOT NULL,
	"proposed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"owner_instructions" text,
	"merge_run_id" uuid,
	"resulting_main_version_id" uuid
);
--> statement-breakpoint
CREATE TABLE "node" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"variant_id" uuid NOT NULL,
	"origin_id" uuid NOT NULL,
	"type" "node_type" NOT NULL,
	"parent_node_id" uuid,
	"sort_index" integer DEFAULT 0 NOT NULL,
	"title" text NOT NULL,
	"notes" text,
	"start_at" timestamp with time zone,
	"end_at" timestamp with time zone,
	"location_place_id" text,
	"location_lat" double precision,
	"location_lng" double precision,
	"location_address" text,
	"place_refreshed_at" timestamp with time zone,
	"type_data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trip_book" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"current_main_version_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "variant" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trip_book_id" uuid NOT NULL,
	"owner_user_id" text NOT NULL,
	"base_main_version_id" uuid NOT NULL,
	"status" "variant_status" DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_run" ADD CONSTRAINT "agent_run_trip_book_id_trip_book_id_fk" FOREIGN KEY ("trip_book_id") REFERENCES "public"."trip_book"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run" ADD CONSTRAINT "agent_run_variant_id_variant_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."variant"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_step" ADD CONSTRAINT "agent_run_step_agent_run_id_agent_run_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_message" ADD CONSTRAINT "chat_message_trip_book_id_trip_book_id_fk" FOREIGN KEY ("trip_book_id") REFERENCES "public"."trip_book"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_message" ADD CONSTRAINT "chat_message_variant_id_variant_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."variant"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "main_version" ADD CONSTRAINT "main_version_trip_book_id_trip_book_id_fk" FOREIGN KEY ("trip_book_id") REFERENCES "public"."trip_book"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership" ADD CONSTRAINT "membership_trip_book_id_trip_book_id_fk" FOREIGN KEY ("trip_book_id") REFERENCES "public"."trip_book"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merge_conflict" ADD CONSTRAINT "merge_conflict_merge_proposal_id_merge_proposal_id_fk" FOREIGN KEY ("merge_proposal_id") REFERENCES "public"."merge_proposal"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merge_proposal" ADD CONSTRAINT "merge_proposal_trip_book_id_trip_book_id_fk" FOREIGN KEY ("trip_book_id") REFERENCES "public"."trip_book"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merge_proposal" ADD CONSTRAINT "merge_proposal_variant_id_variant_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."variant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merge_proposal" ADD CONSTRAINT "merge_proposal_merge_run_id_agent_run_id_fk" FOREIGN KEY ("merge_run_id") REFERENCES "public"."agent_run"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merge_proposal" ADD CONSTRAINT "merge_proposal_resulting_main_version_id_main_version_id_fk" FOREIGN KEY ("resulting_main_version_id") REFERENCES "public"."main_version"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node" ADD CONSTRAINT "node_variant_id_variant_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."variant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variant" ADD CONSTRAINT "variant_trip_book_id_trip_book_id_fk" FOREIGN KEY ("trip_book_id") REFERENCES "public"."trip_book"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variant" ADD CONSTRAINT "variant_base_main_version_id_main_version_id_fk" FOREIGN KEY ("base_main_version_id") REFERENCES "public"."main_version"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_run_trip_book_id_idx" ON "agent_run" USING btree ("trip_book_id");--> statement-breakpoint
CREATE INDEX "agent_run_variant_id_idx" ON "agent_run" USING btree ("variant_id");--> statement-breakpoint
CREATE INDEX "agent_run_merge_proposal_id_idx" ON "agent_run" USING btree ("merge_proposal_id");--> statement-breakpoint
CREATE INDEX "agent_run_triggered_by_user_id_idx" ON "agent_run" USING btree ("triggered_by_user_id");--> statement-breakpoint
CREATE INDEX "agent_run_status_idx" ON "agent_run" USING btree ("status");--> statement-breakpoint
CREATE INDEX "agent_run_step_agent_run_id_idx" ON "agent_run_step" USING btree ("agent_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_run_step_run_idempotency_uq" ON "agent_run_step" USING btree ("agent_run_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "chat_message_trip_book_id_idx" ON "chat_message" USING btree ("trip_book_id");--> statement-breakpoint
CREATE INDEX "chat_message_user_id_idx" ON "chat_message" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "chat_message_agent_run_id_idx" ON "chat_message" USING btree ("agent_run_id");--> statement-breakpoint
CREATE INDEX "chat_message_variant_id_idx" ON "chat_message" USING btree ("variant_id");--> statement-breakpoint
CREATE INDEX "chat_message_trip_book_created_at_idx" ON "chat_message" USING btree ("trip_book_id","created_at");--> statement-breakpoint
CREATE INDEX "main_version_trip_book_id_idx" ON "main_version" USING btree ("trip_book_id");--> statement-breakpoint
CREATE INDEX "main_version_parent_version_id_idx" ON "main_version" USING btree ("parent_version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "main_version_trip_book_parent_uq" ON "main_version" USING btree ("trip_book_id","parent_version_id");--> statement-breakpoint
CREATE INDEX "membership_user_id_idx" ON "membership" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "membership_trip_book_id_idx" ON "membership" USING btree ("trip_book_id");--> statement-breakpoint
CREATE UNIQUE INDEX "membership_invitation_token_uq" ON "membership" USING btree ("invitation_token");--> statement-breakpoint
CREATE INDEX "merge_conflict_merge_proposal_id_idx" ON "merge_conflict" USING btree ("merge_proposal_id");--> statement-breakpoint
CREATE INDEX "merge_conflict_origin_id_idx" ON "merge_conflict" USING btree ("origin_id");--> statement-breakpoint
CREATE INDEX "merge_proposal_trip_book_id_idx" ON "merge_proposal" USING btree ("trip_book_id");--> statement-breakpoint
CREATE INDEX "merge_proposal_variant_id_idx" ON "merge_proposal" USING btree ("variant_id");--> statement-breakpoint
CREATE INDEX "merge_proposal_status_idx" ON "merge_proposal" USING btree ("status");--> statement-breakpoint
CREATE INDEX "merge_proposal_merge_run_id_idx" ON "merge_proposal" USING btree ("merge_run_id");--> statement-breakpoint
CREATE INDEX "merge_proposal_resulting_main_version_id_idx" ON "merge_proposal" USING btree ("resulting_main_version_id");--> statement-breakpoint
CREATE INDEX "node_variant_id_idx" ON "node" USING btree ("variant_id");--> statement-breakpoint
CREATE INDEX "node_parent_node_id_idx" ON "node" USING btree ("parent_node_id");--> statement-breakpoint
CREATE INDEX "node_origin_id_idx" ON "node" USING btree ("origin_id");--> statement-breakpoint
CREATE INDEX "node_type_idx" ON "node" USING btree ("type");--> statement-breakpoint
CREATE UNIQUE INDEX "node_variant_origin_uq" ON "node" USING btree ("variant_id","origin_id");--> statement-breakpoint
CREATE INDEX "trip_book_owner_user_id_idx" ON "trip_book" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "trip_book_current_main_version_id_idx" ON "trip_book" USING btree ("current_main_version_id");--> statement-breakpoint
CREATE INDEX "variant_trip_book_id_idx" ON "variant" USING btree ("trip_book_id");--> statement-breakpoint
CREATE INDEX "variant_owner_user_id_idx" ON "variant" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "variant_base_main_version_id_idx" ON "variant" USING btree ("base_main_version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "variant_trip_book_owner_uq" ON "variant" USING btree ("trip_book_id","owner_user_id");