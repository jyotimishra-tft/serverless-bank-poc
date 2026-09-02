-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('pending', 'submitted');

-- CreateEnum
CREATE TYPE "SubmittedByType" AS ENUM ('customer', 'agent');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('customer', 'agent', 'system');

-- CreateEnum
CREATE TYPE "ExchangeDirection" AS ENUM ('import', 'export');

-- CreateEnum
CREATE TYPE "ExchangeStatus" AS ENUM ('running', 'completed', 'completed_with_errors');

-- CreateEnum
CREATE TYPE "InviteStatus" AS ENUM ('pending', 'redeemed', 'expired');

-- CreateTable
CREATE TABLE "organisation" (
    "id" UUID NOT NULL,
    "external_id" TEXT,
    "name" TEXT NOT NULL,
    "invite_code" TEXT NOT NULL,
    "is_blocked" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organisation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent" (
    "id" UUID NOT NULL,
    "cognito_sub" TEXT NOT NULL,
    "organisation_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer" (
    "id" UUID NOT NULL,
    "external_id" TEXT,
    "cognito_sub" TEXT,
    "email" TEXT NOT NULL,
    "first_name" TEXT NOT NULL,
    "last_name" TEXT,
    "mobile_phone" TEXT,
    "comm_pref_email" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_address" (
    "id" UUID NOT NULL,
    "external_id" TEXT,
    "customer_id" UUID NOT NULL,
    "line1" TEXT NOT NULL,
    "line2" TEXT,
    "city" TEXT NOT NULL,
    "postcode" TEXT NOT NULL,
    "country" TEXT NOT NULL DEFAULT 'GB',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_address_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agreement" (
    "id" UUID NOT NULL,
    "external_id" TEXT,
    "reference" TEXT NOT NULL,
    "customer_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agreement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "claim_case" (
    "id" UUID NOT NULL,
    "external_id" TEXT,
    "reference_number" TEXT NOT NULL,
    "agreement_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "claim_case_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "case_representation" (
    "id" UUID NOT NULL,
    "external_id" TEXT,
    "claim_case_id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "case_representation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_step" (
    "id" UUID NOT NULL,
    "external_id" TEXT,
    "claim_case_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "completed_at" TIMESTAMP(3),
    "deadline" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workflow_step_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task" (
    "id" UUID NOT NULL,
    "external_id" TEXT,
    "workflow_step_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" "TaskStatus" NOT NULL DEFAULT 'pending',
    "due_date" TIMESTAMP(3),
    "result" JSONB,
    "submitted_at" TIMESTAMP(3),
    "submitted_by" TEXT,
    "submitted_by_type" "SubmittedByType",
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invite" (
    "id" UUID NOT NULL,
    "external_id" TEXT,
    "claim_case_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "status" "InviteStatus" NOT NULL DEFAULT 'pending',
    "redeemed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "invite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_event" (
    "id" UUID NOT NULL,
    "actor_type" "ActorType" NOT NULL,
    "actor_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "correlation_id" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "data_exchange_run" (
    "id" UUID NOT NULL,
    "direction" "ExchangeDirection" NOT NULL,
    "status" "ExchangeStatus" NOT NULL DEFAULT 'running',
    "s3_prefix" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "data_exchange_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "data_exchange_table_result" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "table_name" TEXT NOT NULL,
    "rows_processed" INTEGER NOT NULL DEFAULT 0,
    "rows_inserted" INTEGER NOT NULL DEFAULT 0,
    "rows_updated" INTEGER NOT NULL DEFAULT 0,
    "rows_skipped" INTEGER NOT NULL DEFAULT 0,
    "rows_errored" INTEGER NOT NULL DEFAULT 0,
    "error_details" JSONB,

    CONSTRAINT "data_exchange_table_result_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "case_notification" (
    "claim_case_id" UUID NOT NULL,
    "last_action_required_at" TIMESTAMP(3) NOT NULL,
    "last_notified_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "case_notification_pkey" PRIMARY KEY ("claim_case_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "organisation_external_id_key" ON "organisation"("external_id");

-- CreateIndex
CREATE UNIQUE INDEX "organisation_invite_code_key" ON "organisation"("invite_code");

-- CreateIndex
CREATE UNIQUE INDEX "agent_cognito_sub_key" ON "agent"("cognito_sub");

-- CreateIndex
CREATE INDEX "agent_organisation_id_idx" ON "agent"("organisation_id");

-- CreateIndex
CREATE UNIQUE INDEX "agent_organisation_id_email_key" ON "agent"("organisation_id", "email");

-- CreateIndex
CREATE UNIQUE INDEX "customer_external_id_key" ON "customer"("external_id");

-- CreateIndex
CREATE UNIQUE INDEX "customer_cognito_sub_key" ON "customer"("cognito_sub");

-- CreateIndex
CREATE UNIQUE INDEX "customer_email_key" ON "customer"("email");

-- CreateIndex
CREATE UNIQUE INDEX "customer_address_external_id_key" ON "customer_address"("external_id");

-- CreateIndex
CREATE INDEX "customer_address_customer_id_idx" ON "customer_address"("customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "agreement_external_id_key" ON "agreement"("external_id");

-- CreateIndex
CREATE UNIQUE INDEX "agreement_reference_key" ON "agreement"("reference");

-- CreateIndex
CREATE INDEX "agreement_customer_id_idx" ON "agreement"("customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "claim_case_external_id_key" ON "claim_case"("external_id");

-- CreateIndex
CREATE UNIQUE INDEX "claim_case_reference_number_key" ON "claim_case"("reference_number");

-- CreateIndex
CREATE INDEX "claim_case_customer_id_idx" ON "claim_case"("customer_id");

-- CreateIndex
CREATE INDEX "claim_case_agreement_id_idx" ON "claim_case"("agreement_id");

-- CreateIndex
CREATE UNIQUE INDEX "case_representation_external_id_key" ON "case_representation"("external_id");

-- CreateIndex
CREATE INDEX "case_representation_organisation_id_idx" ON "case_representation"("organisation_id");

-- CreateIndex
CREATE UNIQUE INDEX "case_representation_claim_case_id_organisation_id_key" ON "case_representation"("claim_case_id", "organisation_id");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_step_external_id_key" ON "workflow_step"("external_id");

-- CreateIndex
CREATE INDEX "workflow_step_claim_case_id_idx" ON "workflow_step"("claim_case_id");

-- CreateIndex
CREATE UNIQUE INDEX "task_external_id_key" ON "task"("external_id");

-- CreateIndex
CREATE INDEX "task_workflow_step_id_idx" ON "task"("workflow_step_id");

-- CreateIndex
CREATE INDEX "task_status_due_date_idx" ON "task"("status", "due_date");

-- CreateIndex
CREATE UNIQUE INDEX "invite_external_id_key" ON "invite"("external_id");

-- CreateIndex
CREATE UNIQUE INDEX "invite_code_key" ON "invite"("code");

-- CreateIndex
CREATE INDEX "invite_claim_case_id_idx" ON "invite"("claim_case_id");

-- CreateIndex
CREATE INDEX "invite_customer_id_idx" ON "invite"("customer_id");

-- CreateIndex
CREATE INDEX "audit_event_entity_type_entity_id_idx" ON "audit_event"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "audit_event_created_at_idx" ON "audit_event"("created_at");

-- CreateIndex
CREATE INDEX "data_exchange_table_result_run_id_idx" ON "data_exchange_table_result"("run_id");

-- AddForeignKey
ALTER TABLE "agent" ADD CONSTRAINT "agent_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_address" ADD CONSTRAINT "customer_address_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agreement" ADD CONSTRAINT "agreement_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim_case" ADD CONSTRAINT "claim_case_agreement_id_fkey" FOREIGN KEY ("agreement_id") REFERENCES "agreement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim_case" ADD CONSTRAINT "claim_case_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "case_representation" ADD CONSTRAINT "case_representation_claim_case_id_fkey" FOREIGN KEY ("claim_case_id") REFERENCES "claim_case"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "case_representation" ADD CONSTRAINT "case_representation_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_step" ADD CONSTRAINT "workflow_step_claim_case_id_fkey" FOREIGN KEY ("claim_case_id") REFERENCES "claim_case"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task" ADD CONSTRAINT "task_workflow_step_id_fkey" FOREIGN KEY ("workflow_step_id") REFERENCES "workflow_step"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invite" ADD CONSTRAINT "invite_claim_case_id_fkey" FOREIGN KEY ("claim_case_id") REFERENCES "claim_case"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invite" ADD CONSTRAINT "invite_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "data_exchange_table_result" ADD CONSTRAINT "data_exchange_table_result_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "data_exchange_run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "case_notification" ADD CONSTRAINT "case_notification_claim_case_id_fkey" FOREIGN KEY ("claim_case_id") REFERENCES "claim_case"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
