# Case Progress Tracking POC — Project Documentation

A serverless backend for a customer case progress tracking portal, built on AWS SAM, Lambda, API Gateway (HTTP API), Cognito, RDS Postgres, Prisma, and S3.

---

## 1. Architecture Overview

```
Client → Cognito (auth) → API Gateway (HTTP API) → Lambda → RDS Postgres (via Prisma)
                                                        ↓
                                              S3 (CSV import) / EventBridge (hourly notify) → SES
```

- **Auth**: Cognito User Pool + App Client. Login issues a JWT (`idToken`); API Gateway's `CognitoAuthorizer` validates it on every route except the explicitly public ones.
- **Database**: single `db.t4g.micro` RDS Postgres instance, private (no public access by default). Lambda functions reach it over VPC networking, using a self-referencing security group (anything using `DbSecurityGroup` — the DB and the Lambdas — can talk to anything else using it).
- **ORM**: Prisma, with credentials fetched from Secrets Manager at runtime (not IAM auth tokens — those expire every 15 minutes and don't work with Prisma's persistent connection pool).
- **Prisma in Lambda**: Prisma's native query engine binary doesn't survive esbuild bundling, so it's packaged as a shared Lambda Layer (`poc-prisma-layer`) instead of being bundled per-function.
- **Stack**: one merged CloudFormation stack (`poc-foundation`), single `template.yaml`.

---

## 2. Database Structure

All tables use UUID primary keys. Column names in the actual Postgres tables are `snake_case` (mapped via Prisma's `@map`); this section uses the Prisma model names.

### Organisation
Bank/upstream-sourced. `inviteCode` is the static per-org code agents use at signup (checked in the `PreSignUp` trigger).

| Field | Type | Notes |
|---|---|---|
| id | UUID | PK |
| externalId | String? | unique, from bank import |
| name | String | |
| inviteCode | String | unique |
| isBlocked | Boolean | default false |

### Agent
Self-registers via Cognito + org invite code — **not** part of the bank CSV import. `cognitoSub` links to the Cognito identity; there's no local password.

| Field | Type | Notes |
|---|---|---|
| id | UUID | PK |
| cognitoSub | String | unique |
| organisationId | UUID | FK → Organisation |
| email | String | |
| name | String? | |
| isActive | Boolean | default true |

### Customer
**Is** part of the bank CSV import (`externalId` + `updatedAt` drive the upsert-skip-if-older rule). `cognitoSub` is nullable — attached later when a customer self-registers with a matching email.

| Field | Type | Notes |
|---|---|---|
| id | UUID | PK |
| externalId | String? | unique, bank import key |
| cognitoSub | String? | unique, nullable until self-registered |
| email | String | unique |
| firstName | String | required |
| lastName | String? | |
| mobilePhone | String? | |
| commPrefEmail | Boolean | default true |

### CustomerAddress
| Field | Type | Notes |
|---|---|---|
| id | UUID | PK |
| externalId | String? | unique |
| customerId | UUID | FK → Customer |
| line1, line2 | String | line2 optional |
| city, postcode | String | |
| country | String | default "GB" |

### Agreement
Belongs to a customer only — not directly to an organisation (org access is via `CaseRepresentation` on the case).

| Field | Type | Notes |
|---|---|---|
| id | UUID | PK |
| externalId | String? | unique |
| reference | String | unique |
| customerId | UUID | FK → Customer |

### ClaimCase
`overallStatus` and `currentStepName` are **not** columns — always derived at query time from the case's tasks (see `statusService.ts`), so they can never go stale.

| Field | Type | Notes |
|---|---|---|
| id | UUID | PK |
| externalId | String? | unique |
| referenceNumber | String | unique |
| agreementId | UUID | FK → Agreement |
| customerId | UUID | FK → Customer |

### CaseRepresentation
Makes agent org-scoping possible. This is the **actual access-control boundary** — every agent-facing query filters through this table, not through a post-fetch permission check.

| Field | Type | Notes |
|---|---|---|
| id | UUID | PK |
| claimCaseId | UUID | FK → ClaimCase |
| organisationId | UUID | FK → Organisation |
| isActive | Boolean | default true |
| | | unique on (claimCaseId, organisationId) |

### WorkflowStep
| Field | Type | Notes |
|---|---|---|
| id | UUID | PK |
| externalId | String? | unique |
| claimCaseId | UUID | FK → ClaimCase |
| name | String | |
| position | Int | order within the case |
| completedAt | DateTime? | null = not yet done |
| deadline | DateTime? | |

### Task
| Field | Type | Notes |
|---|---|---|
| id | UUID | PK |
| externalId | String? | unique |
| workflowStepId | UUID | FK → WorkflowStep |
| title | String | **required** |
| description | String? | |
| status | enum | `pending` \| `submitted` |
| dueDate | DateTime? | |
| result | Json? | arbitrary submitted payload |
| submittedAt | DateTime? | |
| submittedBy | String? | customer.id or agent.id |
| submittedByType | enum? | `customer` \| `agent` |

### Invite
Case-level: links a specific customer to a specific case. **Distinct** from `Organisation.inviteCode` (that's the static per-org agent signup code).

| Field | Type | Notes |
|---|---|---|
| id | UUID | PK |
| claimCaseId | UUID | FK → ClaimCase |
| customerId | UUID | FK → Customer |
| code | String | unique |
| status | enum | `pending` \| `redeemed` \| `expired` |
| redeemedAt | DateTime? | |

### Cross-cutting tables
- **AuditEvent** — actor/action/entity log, indexed by `(entityType, entityId)` and `createdAt`.
- **DataExchangeRun** / **DataExchangeTableResult** — tracks every CSV import batch: one `DataExchangeRun` per file processed, one `DataExchangeTableResult` per run with `rowsProcessed/Inserted/Updated/Skipped/Errored` counts and any error details.
- **CaseNotification** — one row per case currently in an action-required period (dedupes the hourly notification sweep; deleted when the case leaves that state, so a later relapse notifies again).

---

## 3. Handler Reference

### Public (no auth required)

| Handler | Trigger | Purpose |
|---|---|---|
| `health.ts` | `GET /health` | Liveness check, no DB dependency |
| `login.ts` | `POST /login` | Cognito `InitiateAuth` → returns `idToken`/`accessToken`/`refreshToken` |
| `signup.ts` | `POST /signup` | Cognito `SignUp`; passes `role`/`firstName`/`lastName`/`inviteCode` as `clientMetadata` for the triggers below |

### Cognito triggers (not HTTP routes)

| Handler | Trigger | Purpose |
|---|---|---|
| `preSignUp.ts` | Cognito PreSignUp | Gates **agent** signup behind a valid `Organisation.inviteCode`; customers pass through freely. Auto-confirms the user. |
| `postConfirmation.ts` | Cognito PostConfirmation | Creates the `Customer` (upsert by email, attaches to a bank-imported row if one exists) or `Agent` row, using Cognito's `sub` as `cognitoSub` |

### Authenticated (JWT required)

| Handler | Route | Purpose |
|---|---|---|
| `whoami.ts` | `GET /whoami` | Returns the caller's role + profile, resolved from the JWT's `sub` claim |
| `customerCasesProgressSummary.ts` | `GET /customer/progressSummary` | All of the caller's cases with derived status |
| `customerCaseDetail.ts` | `GET /customer/cases/{caseId}` | Full case detail — steps, tasks — scoped to the caller's own case (404 if not theirs) |
| `customerSubmitTask.ts` | `POST /customer/cases/{caseId}/tasks/{taskId}/submit` | Submits a task's `result` JSON; ownership verified via the task→step→case→customer chain in one query |
| `agentCasesProgressSummary.ts` | `GET /agent/progressSummary` | All cases the agent's **organisation** currently represents (via `CaseRepresentation`) |
| `agentCaseDetails.ts` | `GET /agent/cases/{caseId}` | Case detail, org-scoped instead of directly owned |
| `agentSubmitTask.ts` | `POST /agent/cases/{caseId}/tasks/{taskId}/submit` | Same as the customer version, org-scoped |

### Scheduled / event-driven

| Handler | Trigger | Purpose |
|---|---|---|
| `notifyHandler.ts` | EventBridge `rate(1 hour)` | Sweeps for cases in an action-required state, sends via SES, dedupes via `CaseNotification` |
| `csvImportHandler.ts` | S3 `ObjectCreated` on `imports/**/_batch.complete` | Batch CSV import — see Section 6 |

**Key auth detail**: use the **`idToken`**, not `accessToken`, when calling any authenticated route — `JwtConfiguration.audience` is matched against the ID token's `aud` claim; access tokens carry `client_id` instead and will be rejected.

---

## 4. Install & Run Dependencies

### Prerequisites
- **Node.js 20.x** (matches the Lambda runtime)
- **AWS SAM CLI** (`sam --version` to check)
- **AWS CLI v2**, configured with credentials that can deploy to `ap-southeast-2`
- **Docker Desktop** (needed for `sam local` and `sam build --use-container` if used)
- **PowerShell** (all helper scripts in this project are `.ps1`)
- **esbuild installed globally** as well as locally (`npm install -g esbuild`) — SAM's esbuild build method needs it on the PATH on Windows

### Install project dependencies
```powershell
npm install
```
This should pull in (confirm these are in `package.json`):
- `@prisma/client`, `prisma`
- `@aws-sdk/client-cognito-identity-provider`
- `@aws-sdk/client-secrets-manager`
- `@aws-sdk/client-s3`
- `aws-lambda`, `@types/aws-lambda` (dev)

### Prisma setup
```powershell
npx prisma generate
```
`schema.prisma`'s `generator client` block must include both binary targets:
```prisma
generator client {
  provider      = "prisma-client-js"
  binaryTargets = ["native", "rhel-openssl-3.0.x"]
}
```
`native` is for local dev/migration on Windows; `rhel-openssl-3.0.x` is what the Lambda runtime actually needs.

---

## 5. Build & Deploy

### First-time setup
1. Get your default VPC ID and at least 2 subnet IDs in `ap-southeast-2` (needed as SAM parameters).
2. Populate `samconfig.toml`'s `parameter_overrides` with `VpcId`, `SubnetIds`, `DbName`, `DbMasterUsername`, `FromEmail` (a verified SES sender address).

### Every deploy
```powershell
.\build-prisma-layer.ps1    # only needed after "npx prisma generate" changes
sam build
sam deploy
```
`build-prisma-layer.ps1` copies your locally generated Prisma client (with the Linux engine binary) into `layers/prisma-layer/nodejs/node_modules/` — this is what SAM packages as the shared `PrismaLayer`, referenced by every DB-touching function via `Layers: [!Ref PrismaLayer]`.

### One-time post-deploy database setup
1. Get the master password:
   ```powershell
   aws secretsmanager get-secret-value --secret-id poc-db-master-secret --region ap-southeast-2 --query SecretString --output text
   ```
2. Connect (temporarily enable public access on `poc-db` in the RDS console + add your IP to the security group if connecting from outside the VPC — revert both afterward).
3. Run:
   ```sql
   CREATE USER app_user;
   GRANT rds_iam TO app_user;
   ```
4. Run Prisma migrations against the real DB (`DATABASE_URL` pointed at the RDS endpoint):
   ```powershell
   npx prisma migrate deploy
   ```

### Getting stack outputs
```powershell
aws cloudformation describe-stacks --stack-name poc-foundation --region ap-southeast-2 --query "Stacks[0].Outputs" --output table
```
Key outputs: `ApiUrl`, `UserPoolId`, `UserPoolClientId`, `CsvImportBucketName`.

---

## 6. Testing the S3 CSV Import Handler

The importer processes 9 tables in a fixed dependency order — **organisations → customers → customer_addresses → agreements → claim_cases → workflow_steps → tasks → case_representations → invites** — regardless of what order the files were uploaded in. It only triggers on a **`_batch.complete`** marker file, not on the CSVs themselves, so you upload everything first and the marker last.

CSV format: **pipe-delimited (`|`)**, not comma.

### Steps

1. **Get the bucket name**:
   ```powershell
   aws cloudformation describe-stacks --stack-name poc-foundation --region ap-southeast-2 --query "Stacks[0].Outputs[?OutputKey=='CsvImportBucketName'].OutputValue" --output text
   ```

2. **Upload all CSVs into one batch folder** (any order, any subset of the 9):
   ```powershell
   aws s3 cp . s3://<bucket>/imports/batch-test-1/ --recursive --exclude "*" --include "*.csv" --region ap-southeast-2
   ```
   Or via the S3 console: create the `imports/batch-test-1/` folder, then multi-select and upload all CSVs in one action.

3. **Upload the marker file last, separately**:
   ```powershell
   New-Item -ItemType File -Name "_batch.complete"
   aws s3 cp _batch.complete s3://<bucket>/imports/batch-test-1/_batch.complete --region ap-southeast-2
   ```
   This is what actually fires the Lambda — the CSVs alone don't trigger anything.

4. **Watch it process**:
   ```powershell
   aws logs tail /aws/lambda/<CsvImportFunction-name> --since 2m --region ap-southeast-2
   ```
   Expect log lines for each of the 9 tables in order, each with `processed=/inserted=/updated=/skipped=/errored=` counts. Missing files are logged and skipped, not treated as errors.

5. **Verify results directly in the database** (more reliable than reading logs):
   ```sql
   SELECT dtr.table_name, dtr.rows_inserted, dtr.rows_updated, dtr.rows_skipped, dtr.rows_errored, dtr.error_details
   FROM data_exchange_table_result dtr
   JOIN data_exchange_run der ON der.id = dtr.run_id
   ORDER BY der.started_at DESC;
   ```

6. **Confirm idempotency**: re-run the same batch again (new folder, same files). Rows with an unchanged `updated_at` should show up as `rows_skipped`, not re-inserted or re-updated — proof the skip-if-older logic is working, not just that the import "ran without erroring."
