import type { S3Handler, S3Event } from 'aws-lambda';
import { S3Client, GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { getPrisma } from '../lib/db';
import type { PrismaClient } from '@prisma/client';

const s3 = new S3Client({});

// Fixed processing order - not the order files were uploaded in. Each entry
// depends on tables earlier in this list already being imported (e.g.
// claim_cases needs agreements already in place to resolve customer_id).
const IMPORT_ORDER = [
  'organisations',
  'customers',
  'customer_addresses',
  'agreements',
  'claim_cases',
  'workflow_steps',
  'tasks',
  'case_representations',
  'invites',
] as const;

interface ImportResult {
  tableName: string;
  rowsProcessed: number;
  rowsInserted: number;
  rowsUpdated: number;
  rowsSkipped: number;
  rowsErrored: number;
  errorDetails: Array<{ row: number; error: string }>;
}

function newResult(tableName: string): ImportResult {
  return {
    tableName,
    rowsProcessed: 0,
    rowsInserted: 0,
    rowsUpdated: 0,
    rowsSkipped: 0,
    rowsErrored: 0,
    errorDetails: [],
  };
}

/**
 * Triggered by a "_batch.complete" marker file, NOT by individual CSV
 * uploads (see template.yaml's Filter - suffix is ".complete", not ".csv").
 * Upload all your CSVs into the same S3 "folder" (any order, any subset),
 * then upload the marker last to signal "this batch is ready to process".
 *
 * On trigger, this lists everything in that folder and processes whichever
 * of the 9 known CSVs are present, always in IMPORT_ORDER - so upload order
 * genuinely doesn't matter, only which files exist by the time the marker
 * lands.
 */
export const handler: S3Handler = async (event: S3Event) => {
  const prisma = await getPrisma();

  for (const record of event.Records) {
    const bucket = record.s3.bucket.name;
    const markerKey = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));
    const batchPrefix = markerKey.substring(0, markerKey.lastIndexOf('/') + 1);

    console.log(`Batch marker received: ${markerKey} - processing batch at ${batchPrefix}`);

    const listResp = await s3.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: batchPrefix })
    );
    const csvKeysByTable = new Map<string, string>();
    for (const obj of listResp.Contents ?? []) {
      if (!obj.Key || !obj.Key.toLowerCase().endsWith('.csv')) continue;
      const filename = obj.Key.split('/').pop() ?? '';
      const tableKey = filename.replace(/\.csv$/i, '').toLowerCase();
      csvKeysByTable.set(tableKey, obj.Key);
    }

    if (csvKeysByTable.size === 0) {
      console.log(`No .csv files found in ${batchPrefix} - nothing to do`);
      continue;
    }

    for (const tableKey of IMPORT_ORDER) {
      const key = csvKeysByTable.get(tableKey);
      if (!key) {
        console.log(`No ${tableKey}.csv in this batch - skipping`);
        continue;
      }
      await processOneFile(prisma, bucket, key, tableKey);
    }

    // Any CSVs present that aren't in IMPORT_ORDER at all (typo'd filename,
    // unrelated file accidentally dropped in the folder) - surface loudly
    // rather than silently ignoring.
    for (const tableKey of csvKeysByTable.keys()) {
      if (!(IMPORT_ORDER as readonly string[]).includes(tableKey)) {
        console.error(`Unrecognized file in batch, not processed: ${csvKeysByTable.get(tableKey)}`);
      }
    }
  }
};

async function processOneFile(
  prisma: PrismaClient,
  bucket: string,
  key: string,
  tableKey: string
): Promise<void> {
  const run = await prisma.dataExchangeRun.create({
    data: { direction: 'import', status: 'running', s3Prefix: key },
  });

  let result: ImportResult;

  try {
    const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const body = await obj.Body!.transformToString();
    const rows = parseCsv(body);

    switch (tableKey) {
      case 'organisations':
        result = await importOrganisations(prisma, rows);
        break;
      case 'customers':
        result = await importCustomers(prisma, rows);
        break;
      case 'customer_addresses':
        result = await importCustomerAddresses(prisma, rows);
        break;
      case 'agreements':
        result = await importAgreements(prisma, rows);
        break;
      case 'claim_cases':
        result = await importClaimCases(prisma, rows);
        break;
      case 'workflow_steps':
        result = await importWorkflowSteps(prisma, rows);
        break;
      case 'tasks':
        result = await importTasks(prisma, rows);
        break;
      case 'case_representations':
        result = await importCaseRepresentations(prisma, rows);
        break;
      case 'invites':
        result = await importInvites(prisma, rows);
        break;
      default:
        result = newResult(tableKey);
    }

    await prisma.dataExchangeRun.update({
      where: { id: run.id },
      data: {
        status: result.rowsErrored > 0 ? 'completed_with_errors' : 'completed',
        completedAt: new Date(),
      },
    });
  } catch (fileErr) {
    result = newResult(tableKey);
    result.errorDetails.push({
      row: 0,
      error: fileErr instanceof Error ? fileErr.message : String(fileErr),
    });
    await prisma.dataExchangeRun.update({
      where: { id: run.id },
      data: { status: 'completed_with_errors', completedAt: new Date() },
    });
  }

  await prisma.dataExchangeTableResult.create({
    data: {
      runId: run.id,
      tableName: result.tableName,
      rowsProcessed: result.rowsProcessed,
      rowsInserted: result.rowsInserted,
      rowsUpdated: result.rowsUpdated,
      rowsSkipped: result.rowsSkipped,
      rowsErrored: result.rowsErrored,
      errorDetails: result.errorDetails.length > 0 ? result.errorDetails : undefined,
    },
  });

  console.log(
    `${key}: processed=${result.rowsProcessed} inserted=${result.rowsInserted} ` +
      `updated=${result.rowsUpdated} skipped=${result.rowsSkipped} errored=${result.rowsErrored}`
  );
}

// ============================================================================
// Per-table importers. Each resolves its own foreign keys by looking up the
// referenced row's natural key (external_id / invite_code / reference) since
// the source system doesn't know our internal UUIDs - this is what makes
// upload order matter (referenced rows must already exist).
// ============================================================================

async function importOrganisations(prisma: PrismaClient, rows: Record<string, string>[]): Promise<ImportResult> {
  const result = newResult('organisation');
  for (const row of rows) {
    result.rowsProcessed++;
    try {
      const inviteCode = req(row, 'invite_code');
      const name = req(row, 'name');
      const isBlocked = parseBool(row.is_blocked);

      const existing = await prisma.organisation.findUnique({ where: { inviteCode } });
      if (existing) {
        await prisma.organisation.update({ where: { inviteCode }, data: { name, isBlocked } });
        result.rowsUpdated++;
      } else {
        await prisma.organisation.create({ data: { inviteCode, name, isBlocked } });
        result.rowsInserted++;
      }
    } catch (e) {
      result.rowsErrored++;
      result.errorDetails.push({ row: result.rowsProcessed, error: errMsg(e) });
    }
  }
  return result;
}

async function importCustomers(prisma: PrismaClient, rows: Record<string, string>[]): Promise<ImportResult> {
  const result = newResult('customer');
  for (const row of rows) {
    result.rowsProcessed++;
    try {
      const externalId = req(row, 'external_id');
      const email = req(row, 'email');
      const firstName = req(row, 'first_name');
      const updatedAt = parseDate(req(row, 'updated_at'));

      const existing = await prisma.customer.findUnique({ where: { externalId } });
      if (existing) {
        if (existing.updatedAt >= updatedAt) {
          result.rowsSkipped++;
          continue;
        }
        await prisma.customer.update({
          where: { externalId },
          data: {
            email,
            firstName,
            lastName: row.last_name || null,
            mobilePhone: row.phone || null,
            commPrefEmail: parseBool(row.comm_pref_email),
          },
        });
        result.rowsUpdated++;
      } else {
        await prisma.customer.create({
          data: {
            externalId,
            email,
            firstName,
            lastName: row.last_name || null,
            mobilePhone: row.phone || null,
            commPrefEmail: parseBool(row.comm_pref_email),
          },
        });
        result.rowsInserted++;
      }
    } catch (e) {
      result.rowsErrored++;
      result.errorDetails.push({ row: result.rowsProcessed, error: errMsg(e) });
    }
  }
  return result;
}

async function importCustomerAddresses(prisma: PrismaClient, rows: Record<string, string>[]): Promise<ImportResult> {
  const result = newResult('customer_address');
  for (const row of rows) {
    result.rowsProcessed++;
    try {
      const externalId = req(row, 'external_id');
      const customerExternalId = req(row, 'customer_external_id');
      const customer = await prisma.customer.findUnique({ where: { externalId: customerExternalId } });
      if (!customer) throw new Error(`No customer with external_id "${customerExternalId}"`);

      // Note: "state" column in the CSV has no matching field in the
      // CustomerAddress schema - intentionally not stored.
      const data = {
        customerId: customer.id,
        line1: req(row, 'address_line_1'),
        line2: row.address_line_2 || null,
        city: req(row, 'city'),
        postcode: req(row, 'postal_code'),
        country: row.country || 'GB',
      };

      const existing = await prisma.customerAddress.findUnique({ where: { externalId } });
      if (existing) {
        await prisma.customerAddress.update({ where: { externalId }, data });
        result.rowsUpdated++;
      } else {
        await prisma.customerAddress.create({ data: { externalId, ...data } });
        result.rowsInserted++;
      }
    } catch (e) {
      result.rowsErrored++;
      result.errorDetails.push({ row: result.rowsProcessed, error: errMsg(e) });
    }
  }
  return result;
}

async function importAgreements(prisma: PrismaClient, rows: Record<string, string>[]): Promise<ImportResult> {
  const result = newResult('agreement');
  for (const row of rows) {
    result.rowsProcessed++;
    try {
      const externalId = req(row, 'external_id');
      const reference = req(row, 'reference');
      const customerExternalId = req(row, 'customer_external_id');
      const updatedAt = parseDate(req(row, 'updated_at'));

      const customer = await prisma.customer.findUnique({ where: { externalId: customerExternalId } });
      if (!customer) throw new Error(`No customer with external_id "${customerExternalId}"`);

      const existing = await prisma.agreement.findUnique({ where: { externalId } });
      if (existing) {
        if (existing.updatedAt >= updatedAt) {
          result.rowsSkipped++;
          continue;
        }
        await prisma.agreement.update({ where: { externalId }, data: { reference, customerId: customer.id } });
        result.rowsUpdated++;
      } else {
        await prisma.agreement.create({ data: { externalId, reference, customerId: customer.id } });
        result.rowsInserted++;
      }
    } catch (e) {
      result.rowsErrored++;
      result.errorDetails.push({ row: result.rowsProcessed, error: errMsg(e) });
    }
  }
  return result;
}

async function importClaimCases(prisma: PrismaClient, rows: Record<string, string>[]): Promise<ImportResult> {
  const result = newResult('claim_case');
  for (const row of rows) {
    result.rowsProcessed++;
    try {
      const externalId = req(row, 'external_id');
      const referenceNumber = req(row, 'reference_number');
      const agreementExternalId = req(row, 'agreement_external_id');
      const updatedAt = parseDate(req(row, 'updated_at'));

      // customerId isn't in this CSV directly - derive it from the
      // agreement, which already links to the right customer.
      const agreement = await prisma.agreement.findUnique({ where: { externalId: agreementExternalId } });
      if (!agreement) throw new Error(`No agreement with external_id "${agreementExternalId}"`);

      const existing = await prisma.claimCase.findUnique({ where: { externalId } });
      if (existing) {
        if (existing.updatedAt >= updatedAt) {
          result.rowsSkipped++;
          continue;
        }
        await prisma.claimCase.update({
          where: { externalId },
          data: { referenceNumber, agreementId: agreement.id, customerId: agreement.customerId },
        });
        result.rowsUpdated++;
      } else {
        await prisma.claimCase.create({
          data: { externalId, referenceNumber, agreementId: agreement.id, customerId: agreement.customerId },
        });
        result.rowsInserted++;
      }
    } catch (e) {
      result.rowsErrored++;
      result.errorDetails.push({ row: result.rowsProcessed, error: errMsg(e) });
    }
  }
  return result;
}

async function importWorkflowSteps(prisma: PrismaClient, rows: Record<string, string>[]): Promise<ImportResult> {
  const result = newResult('workflow_step');
  for (const row of rows) {
    result.rowsProcessed++;
    try {
      const caseExternalId = req(row, 'case_external_id');
      const name = req(row, 'name');
      const position = parseInt(req(row, 'sequence'), 10);
      if (isNaN(position)) throw new Error(`Invalid sequence: "${row.sequence}"`);

      const claimCase = await prisma.claimCase.findUnique({ where: { externalId: caseExternalId } });
      if (!claimCase) throw new Error(`No claim_case with external_id "${caseExternalId}"`);

      // No external_id given for this table - natural key is
      // (claimCaseId, position), used here purely to make re-uploads
      // idempotent rather than creating duplicate steps each time.
      const existing = await prisma.workflowStep.findFirst({
        where: { claimCaseId: claimCase.id, position },
      });
      if (existing) {
        if (existing.name !== name) {
          await prisma.workflowStep.update({ where: { id: existing.id }, data: { name } });
          result.rowsUpdated++;
        } else {
          result.rowsSkipped++;
        }
      } else {
        await prisma.workflowStep.create({ data: { claimCaseId: claimCase.id, name, position } });
        result.rowsInserted++;
      }
    } catch (e) {
      result.rowsErrored++;
      result.errorDetails.push({ row: result.rowsProcessed, error: errMsg(e) });
    }
  }
  return result;
}

async function importTasks(prisma: PrismaClient, rows: Record<string, string>[]): Promise<ImportResult> {
  const result = newResult('task');
  const validStatuses = new Set(['pending', 'submitted']);

  for (const row of rows) {
    result.rowsProcessed++;
    try {
      const externalId = req(row, 'external_id');
      const caseExternalId = req(row, 'case_external_id');
      const stepSequence = parseInt(req(row, 'step_sequence'), 10);
      if (isNaN(stepSequence)) throw new Error(`Invalid step_sequence: "${row.step_sequence}"`);
      const status = row.status && validStatuses.has(row.status) ? row.status : 'pending';
      const updatedAt = parseDate(req(row, 'updated_at'));

      const claimCase = await prisma.claimCase.findUnique({ where: { externalId: caseExternalId } });
      if (!claimCase) throw new Error(`No claim_case with external_id "${caseExternalId}"`);

      const workflowStep = await prisma.workflowStep.findFirst({
        where: { claimCaseId: claimCase.id, position: stepSequence },
      });
      if (!workflowStep) {
        throw new Error(`No workflow_step at sequence ${stepSequence} for case "${caseExternalId}"`);
      }

      // CSV has no title/description columns, but Task.title is required.
      // Defaulting to the step's name - not real data, just keeps rows
      // insertable. Add title/description columns to the source CSV once
      // that data is available.
      const title = workflowStep.name;

      const data = {
        workflowStepId: workflowStep.id,
        title,
        status: status as 'pending' | 'submitted',
        dueDate: row.due_date ? parseDate(row.due_date) : null,
      };

      const existing = await prisma.task.findUnique({ where: { externalId } });
      if (existing) {
        if (existing.updatedAt >= updatedAt) {
          result.rowsSkipped++;
          continue;
        }
        await prisma.task.update({ where: { externalId }, data });
        result.rowsUpdated++;
      } else {
        await prisma.task.create({ data: { externalId, ...data } });
        result.rowsInserted++;
      }
    } catch (e) {
      result.rowsErrored++;
      result.errorDetails.push({ row: result.rowsProcessed, error: errMsg(e) });
    }
  }
  return result;
}

async function importCaseRepresentations(
  prisma: PrismaClient,
  rows: Record<string, string>[]
): Promise<ImportResult> {
  const result = newResult('case_representation');
  for (const row of rows) {
    result.rowsProcessed++;
    try {
      const caseExternalId = req(row, 'case_external_id');
      const orgInviteCode = req(row, 'organisation_invite_code');

      const claimCase = await prisma.claimCase.findUnique({ where: { externalId: caseExternalId } });
      if (!claimCase) throw new Error(`No claim_case with external_id "${caseExternalId}"`);
      const org = await prisma.organisation.findUnique({ where: { inviteCode: orgInviteCode } });
      if (!org) throw new Error(`No organisation with invite_code "${orgInviteCode}"`);

      // Schema's own unique constraint (claimCaseId, organisationId) IS the
      // natural key here - no separate lookup needed.
      const existing = await prisma.caseRepresentation.findUnique({
        where: { claimCaseId_organisationId: { claimCaseId: claimCase.id, organisationId: org.id } },
      });
      if (existing) {
        if (!existing.isActive) {
          await prisma.caseRepresentation.update({ where: { id: existing.id }, data: { isActive: true } });
          result.rowsUpdated++;
        } else {
          result.rowsSkipped++;
        }
      } else {
        await prisma.caseRepresentation.create({
          data: { claimCaseId: claimCase.id, organisationId: org.id, isActive: true },
        });
        result.rowsInserted++;
      }
    } catch (e) {
      result.rowsErrored++;
      result.errorDetails.push({ row: result.rowsProcessed, error: errMsg(e) });
    }
  }
  return result;
}

async function importInvites(prisma: PrismaClient, rows: Record<string, string>[]): Promise<ImportResult> {
  const result = newResult('invite');
  // organisation_invite_code and expires_at columns exist in the CSV but
  // have no matching field on the Invite model - intentionally unused.
  const statusMap: Record<string, 'pending' | 'redeemed' | 'expired'> = {
    accepted: 'redeemed',
    redeemed: 'redeemed',
    pending: 'pending',
    expired: 'expired',
  };

  for (const row of rows) {
    result.rowsProcessed++;
    try {
      const code = req(row, 'invite_code');
      const caseExternalId = req(row, 'case_external_id');
      const customerExternalId = req(row, 'customer_external_id');

      const claimCase = await prisma.claimCase.findUnique({ where: { externalId: caseExternalId } });
      if (!claimCase) throw new Error(`No claim_case with external_id "${caseExternalId}"`);
      const customer = await prisma.customer.findUnique({ where: { externalId: customerExternalId } });
      if (!customer) throw new Error(`No customer with external_id "${customerExternalId}"`);

      const rawStatus = (row.status || '').toLowerCase();
      const status = statusMap[rawStatus];
      if (!status) {
        result.errorDetails.push({
          row: result.rowsProcessed,
          error: `Unrecognized status "${row.status}", defaulted to "pending"`,
        });
      }

      const data = {
        claimCaseId: claimCase.id,
        customerId: customer.id,
        status: status ?? ('pending' as const),
        redeemedAt: (status ?? 'pending') === 'redeemed' ? new Date() : null,
      };

      const existing = await prisma.invite.findUnique({ where: { code } });
      if (existing) {
        await prisma.invite.update({ where: { code }, data });
        result.rowsUpdated++;
      } else {
        await prisma.invite.create({ data: { code, ...data } });
        result.rowsInserted++;
      }
    } catch (e) {
      result.rowsErrored++;
      result.errorDetails.push({ row: result.rowsProcessed, error: errMsg(e) });
    }
  }
  return result;
}

// ============================================================================
// Shared helpers
// ============================================================================

function req(row: Record<string, string>, key: string): string {
  const v = row[key];
  if (v === undefined || v === '') throw new Error(`Missing required field "${key}"`);
  return v;
}

function parseBool(v: string | undefined): boolean {
  if (v === undefined) return false;
  const s = v.trim().toLowerCase();
  return s === 't' || s === 'true' || s === '1' || s === 'yes';
}

function parseDate(v: string): Date {
  const d = new Date(v);
  if (isNaN(d.getTime())) throw new Error(`Invalid date: "${v}"`);
  return d;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Pipe-delimited CSV parser (matches the sample files' format), handles
 * quoted fields including escaped "" quotes. Not a general-purpose CSV
 * library - doesn't handle multi-line quoted fields.
 */
function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];

  const headers = splitLine(lines[0]).map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const values = splitLine(line);
    const row: Record<string, string> = {};
    headers.forEach((h, i) => {
      row[h] = (values[i] ?? '').trim();
    });
    return row;
  });
}

function splitLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === '|' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
}