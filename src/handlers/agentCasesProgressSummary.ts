import type { APIGatewayProxyHandlerV2WithJWTAuthorizer } from 'aws-lambda';
import { getPrisma } from '../lib/db';
import { deriveCaseStatus, TaskSummary } from '../services/statusService';

/**
 * Agent equivalent of customerCasesProgressSummary.ts. Key difference: scope
 * is by organisation (via CaseRepresentation), not by a single customer -
 * an agent sees every case their org currently represents, across all
 * customers. Also returns basic customer identifying info per case, since
 * an agent (unlike a customer looking at their own cases) needs to know
 * WHICH customer each case belongs to.
 */
export const handler: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (event) => {
  const claims = event.requestContext.authorizer.jwt.claims;
  const sub = claims.sub as string;
  if (!sub) return respond(401, { error: 'No sub claim in token' });

  const prisma = await getPrisma();
  const agent = await prisma.agent.findUnique({ where: { cognitoSub: sub } });
  if (!agent) {
    return respond(403, { error: 'Authenticated but not an agent', sub });
  }
  if (!agent.isActive) {
    return respond(403, { error: 'Agent account is inactive' });
  }

  // Org-scoping: only cases with an ACTIVE CaseRepresentation row pointing
  // at this agent's organisation. This is the actual access-control boundary
  // for FR-6/FR-7 - an agent from org A can never see org B's cases, even
  // by guessing a caseId, because this WHERE clause is what the query runs
  // against, not something checked after the fact.
  const claimCases = await prisma.claimCase.findMany({
    where: {
      representations: {
        some: {
          organisationId: agent.organisationId,
          isActive: true,
        },
      },
    },
    include: {
      customer: {
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
        },
      },
      agreement: {
        select: {
          reference: true,
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
    const taskSummaries: TaskSummary[] = [];
    for (const ws of c.workflowSteps ?? []) {
      for (const t of ws.tasks ?? []) {
        taskSummaries.push({
          status: String(t.status ?? ''),
          dueDate: t.dueDate ? new Date(t.dueDate).toISOString() : null,
        });
      }
    }

    const pendingTasks = taskSummaries.filter((t) => t.status === 'pending');
    const pendingTaskCount = pendingTasks.length;
    const nextDueDate =
      pendingTasks
        .map((t) => (t.dueDate ? new Date(t.dueDate) : null))
        .filter((d): d is Date => d !== null)
        .sort((a, b) => a.getTime() - b.getTime())[0] ?? null;

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

    const overallStatus = deriveCaseStatus(taskSummaries);

    return {
      caseId: c.id,
      referenceNumber: c.referenceNumber,
      agreementReference: c.agreement?.reference ?? null,
      customer: {
        id: c.customer.id,
        email: c.customer.email,
        firstName: c.customer.firstName,
        lastName: c.customer.lastName,
      },
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