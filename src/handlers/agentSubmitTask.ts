import type { APIGatewayProxyHandlerV2WithJWTAuthorizer } from 'aws-lambda';
import { getPrisma } from '../lib/db';

export const handler: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (event) => {
  try {
    const claims = event.requestContext.authorizer.jwt.claims;
    const sub = claims.sub as string;
    if (!sub) return respond(401, { error: 'NO_SUB_CLAIM', message: 'No sub claim in token' });

    const caseId = event.pathParameters?.caseId;
    const taskId = event.pathParameters?.taskId;
    if (!caseId) return respond(400, { error: 'CASE_ID_REQUIRED', message: 'caseId is required' });
    if (!taskId) return respond(400, { error: 'TASK_ID_REQUIRED', message: 'taskId is required' });

    let body: unknown;
    try {
      body = event.body ? JSON.parse(event.body) : null;
    } catch {
      return respond(400, { error: 'INVALID_JSON', message: 'Request body must be valid JSON' });
    }

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return respond(400, { error: 'INVALID_BODY', message: 'Request body must be a JSON object' });
    }

    const result = (body as { result?: unknown }).result;
    if (result === null || typeof result !== 'object' || Array.isArray(result)) {
      return respond(400, { error: 'INVALID_RESULT', message: 'result must be a JSON object' });
    }

    const prisma = await getPrisma();
    const agent = await prisma.agent.findUnique({
      where: { cognitoSub: sub },
      include: { organisation: true },
    });

    if (!agent) return respond(403, { error: 'NOT_AN_AGENT', message: 'Authenticated user is not an agent' });
    if (!agent.isActive) return respond(403, { error: 'AGENT_INACTIVE', message: 'Agent account is inactive' });
    if (agent.organisation.isBlocked) return respond(403, { error: 'ORG_BLOCKED', message: 'Organisation is blocked' });

    const task = await prisma.task.findFirst({
      where: {
        id: taskId,
        workflowStep: {
          claimCase: {
            id: caseId,
            representations: {
              some: {
                organisationId: agent.organisationId,
                isActive: true,
              },
            },
          },
        },
      },
      select: { id: true, status: true },
    });

    if (!task) return respond(404, { error: 'TASK_NOT_FOUND', message: 'Task not found or not accessible by your organisation' });
    if (task.status !== 'pending') return respond(409, { error: 'TASK_ALREADY_SUBMITTED', message: 'Task has already been submitted' });

    const updatedTask = await prisma.task.update({
      where: { id: task.id },
      data: {
        status: 'submitted',
        result,
        submittedAt: new Date(),
        submittedBy: sub,
        submittedByType: 'agent',
      },
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
    });

    return respond(200, {
      task: {
        id: updatedTask.id,
        externalId: updatedTask.externalId,
        title: updatedTask.title,
        description: updatedTask.description,
        status: updatedTask.status,
        dueDate: updatedTask.dueDate ? updatedTask.dueDate.toISOString() : null,
        result: updatedTask.result,
        submittedAt: updatedTask.submittedAt ? updatedTask.submittedAt.toISOString() : null,
        submittedBy: updatedTask.submittedBy,
        submittedByType: updatedTask.submittedByType,
        createdAt: updatedTask.createdAt.toISOString(),
        updatedAt: updatedTask.updatedAt.toISOString(),
      },
    });
  } catch (error) {
    console.error('AgentSubmitTask error:', error);
    return respond(500, { error: 'INTERNAL_SERVER_ERROR', message: 'Failed to submit task' });
  }
};

function respond(statusCode: number, body: unknown) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}