import type { APIGatewayProxyHandlerV2WithJWTAuthorizer } from 'aws-lambda';
import { getPrisma } from '../lib/db';
import { deriveCaseStatus, TaskSummary } from '../services/statusService';

export const handler: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (event) => {
  const claims = event.requestContext.authorizer.jwt.claims;
  const sub = claims.sub as string;
  if (!sub) return respond(401, { error: 'No sub claim in token' });

  const prisma = await getPrisma();
  const customer = await prisma.customer.findUnique({ where: { cognitoSub: sub } });
  if (!customer) {
    return respond(403, { error: 'Authenticated but not a customer', sub });
  }

  // Fetch cases with their workflow steps, tasks and agreement reference
  const claimCases = await prisma.claimCase.findMany({
    where: { customerId: customer.id },
    include: {
      agreement: {
        select: {
          reference: true, // Agreement's only reference-like field - NOT referenceNumber
        },
      },
      workflowSteps: {
        include: {
          tasks: {
            select: { status: true, dueDate: true },
          },
        },
      },
    },
    orderBy: { updatedAt: 'desc' },
  });

  const casesResult = claimCases.map((c) => {
    // flatten tasks across steps for status derivation
    const taskSummaries: TaskSummary[] = [];
    for (const ws of c.workflowSteps ?? []) {
      for (const t of ws.tasks ?? []) {
        taskSummaries.push({
          status: String(t.status ?? ''),
          dueDate: t.dueDate ? new Date(t.dueDate).toISOString() : null,
        });
      }
    }

    // pending task count and next due date
    const pendingTasks = taskSummaries.filter((t) => t.status === 'pending');
    const pendingTaskCount = pendingTasks.length;
    const nextDueDate =
      pendingTasks
        .map((t) => (t.dueDate ? new Date(t.dueDate) : null))
        .filter((d): d is Date => d !== null)
        .sort((a, b) => a.getTime() - b.getTime())[0] ?? null;

    // currentStepName: prefer first step that has any pending task, else last workflow step name
    let currentStepName: string | null = null;
    const stepWithPending = (c.workflowSteps ?? []).find((ws) =>
      (ws.tasks ?? []).some((t) => t.status === 'pending')
    );
    if (stepWithPending) {
      currentStepName = stepWithPending.name;
    } else if ((c.workflowSteps ?? []).length > 0) {
      const lastStep = c.workflowSteps.slice(-1)[0];
      currentStepName = lastStep.name ?? null;
    }

    const agreementReference = c.agreement?.reference ?? null;
    const overallStatus = deriveCaseStatus(taskSummaries);

    return {
      caseId: c.id,
      referenceNumber: c.referenceNumber, // real ClaimCase field, no cast/fallback needed
      agreementReference,
      overallStatus,
      currentStepName,
      pendingTaskCount,
      nextDueDate: nextDueDate ? nextDueDate.toISOString() : null,
      lastUpdatedAt: c.updatedAt ? new Date(c.updatedAt).toISOString() : null,
    };
  });

  return respond(200, { cases: casesResult });
};

function respond(statusCode: number, body: unknown) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}