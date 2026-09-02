import type { APIGatewayProxyHandlerV2WithJWTAuthorizer } from 'aws-lambda';
import { getPrisma } from '../lib/db';

export const handler: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (event) => {
  try {
    const claims = event.requestContext.authorizer.jwt.claims;
    const sub = claims.sub as string;
    if (!sub) return respond(401, { error: 'NO_SUB_CLAIM', message: 'No sub claim in token' });

    const caseId = event.pathParameters?.caseId;
    if (!caseId) return respond(400, { error: 'CASE_ID_REQUIRED', message: 'caseId is required' });

    const prisma = await getPrisma();
    const agent = await prisma.agent.findUnique({
      where: { cognitoSub: sub },
      include: { organisation: true },
    });

    if (!agent) return respond(403, { error: 'NOT_AN_AGENT', message: 'Authenticated user is not an agent' });
    if (!agent.isActive) return respond(403, { error: 'AGENT_INACTIVE', message: 'Agent account is inactive' });
    if (agent.organisation.isBlocked) return respond(403, { error: 'ORG_BLOCKED', message: 'Organisation is blocked' });

    const claimCase = await prisma.claimCase.findFirst({
      where: {
        id: caseId,
        representations: {
          some: {
            organisationId: agent.organisationId,
            isActive: true,
          },
        },
      },
      include: {
        customer: {
          select: { id: true, email: true, firstName: true, lastName: true },
        },
        agreement: { select: { reference: true } },
        workflowSteps: {
          orderBy: { position: 'asc' },
          include: {
            tasks: {
              orderBy: { createdAt: 'asc' },
              select: {
                id: true,
                externalId: true,
                title: true,
                description: true,
                status: true,
                dueDate: true,
                result: true,
                submittedAt: true,
                submittedBy: true,
                submittedByType: true,
                createdAt: true,
                updatedAt: true,
              },
            },
          },
        },
      },
    });

    if (!claimCase) return respond(404, { error: 'CASE_NOT_FOUND', message: 'Case not found or not represented by your organisation' });

    const steps = claimCase.workflowSteps.map((step) => ({
      id: step.id,
      externalId: step.externalId,
      name: step.name,
      position: step.position,
      completedAt: step.completedAt ? step.completedAt.toISOString() : null,
      deadline: step.deadline ? step.deadline.toISOString() : null,
      tasks: step.tasks.map((task) => ({
        id: task.id,
        externalId: task.externalId,
        title: task.title,
        description: task.description,
        status: task.status,
        dueDate: task.dueDate ? task.dueDate.toISOString() : null,
        result: task.result ?? null,
        submittedAt: task.submittedAt ? task.submittedAt.toISOString() : null,
        submittedBy: task.submittedBy ?? null,
        submittedByType: task.submittedByType ?? null,
        createdAt: task.createdAt.toISOString(),
        updatedAt: task.updatedAt.toISOString(),
      })),
    }));

    return respond(200, {
      case: {
        id: claimCase.id,
        externalId: claimCase.externalId,
        referenceNumber: claimCase.referenceNumber,
        agreementReference: claimCase.agreement?.reference ?? null,
        customer: {
          id: claimCase.customer.id,
          email: claimCase.customer.email,
          firstName: claimCase.customer.firstName,
          lastName: claimCase.customer.lastName,
        },
        createdAt: claimCase.createdAt.toISOString(),
        updatedAt: claimCase.updatedAt.toISOString(),
        workflowSteps: steps,
      },
    });
  } catch (error) {
    console.error('AgentCaseDetail error:', error);
    return respond(500, { error: 'INTERNAL_SERVER_ERROR', message: 'Failed to retrieve case details' });
  }
};

function respond(statusCode: number, body: unknown) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}