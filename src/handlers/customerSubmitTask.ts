import type { APIGatewayProxyHandlerV2WithJWTAuthorizer } from 'aws-lambda';
import { getPrisma } from '../lib/db';

export const handler: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (event) => {
  console.log('CustomerSubmitTask - request started');

  try {
    const claims = event.requestContext.authorizer.jwt.claims;
    const sub = claims.sub as string;

    if (!sub) {
      return respond(401, {
        error: 'NO_SUB_CLAIM',
        message: 'No sub claim in token',
      });
    }

    const caseId = event.pathParameters?.caseId;
    const taskId = event.pathParameters?.taskId;

    if (!caseId) {
      return respond(400, {
        error: 'CASE_ID_REQUIRED',
        message: 'caseId is required',
      });
    }

    if (!taskId) {
      return respond(400, {
        error: 'TASK_ID_REQUIRED',
        message: 'taskId is required',
      });
    }

    /*
     * Parse request body.
     */
    let body: unknown;

    try {
      body = event.body ? JSON.parse(event.body) : null;
    } catch {
      return respond(400, {
        error: 'INVALID_JSON',
        message: 'Request body must be valid JSON',
      });
    }

    /*
     * Expected payload:
     *
     * {
     *   "result": {
     *     "answer": "Yes",
     *     "comment": "Completed"
     *   }
     * }
     */
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body)
    ) {
      return respond(400, {
        error: 'INVALID_BODY',
        message: 'Request body must be a JSON object',
      });
    }

    const result = (body as { result?: unknown }).result;

    /*
     * result must be a JSON object.
     */
    if (
      result === null ||
      typeof result !== 'object' ||
      Array.isArray(result)
    ) {
      return respond(400, {
        error: 'INVALID_RESULT',
        message: 'result must be a JSON object',
      });
    }

    console.log('CustomerSubmitTask - sub:', sub);
    console.log('CustomerSubmitTask - caseId:', caseId);
    console.log('CustomerSubmitTask - taskId:', taskId);

    const prisma = await getPrisma();

    /*
     * Resolve Cognito user to local customer.
     */
    const customer = await prisma.customer.findUnique({
      where: {
        cognitoSub: sub,
      },
    });

    if (!customer) {
      return respond(403, {
        error: 'NOT_A_CUSTOMER',
        message: 'Authenticated user is not a customer',
      });
    }

    /*
     * Find the task through the ownership chain:
     *
     * Task
     *   -> WorkflowStep
     *      -> ClaimCase
     *         -> customerId
     *
     * This ensures the customer can only submit a task belonging
     * to their own case.
     */
    const task = await prisma.task.findFirst({
      where: {
        id: taskId,

        workflowStep: {
          claimCase: {
            id: caseId,
            customerId: customer.id,
          },
        },
      },

      select: {
        id: true,
        status: true,
      },
    });

    if (!task) {
      return respond(404, {
        error: 'TASK_NOT_FOUND',
        message: 'Task not found',
      });
    }

    /*
     * A task can only be submitted while pending.
     */
    if (task.status !== 'pending') {
      return respond(409, {
        error: 'TASK_ALREADY_SUBMITTED',
        message: 'Task has already been submitted',
      });
    }

    /*
     * Update task.
     *
     * IMPORTANT:
     * The schema field is `submittedByType`,
     * NOT submitterType or submittedByUserType.
     */
    const updatedTask = await prisma.task.update({
      where: {
        id: task.id,
      },

      data: {
        status: 'submitted',
        result: result,
        submittedAt: new Date(),
        submittedBy: sub,
        submittedByType: 'customer',
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

    console.log(
      'CustomerSubmitTask - task submitted:',
      updatedTask.id
    );

    return respond(200, {
      task: {
        id: updatedTask.id,
        externalId: updatedTask.externalId,
        title: updatedTask.title,
        description: updatedTask.description,
        status: updatedTask.status,
        dueDate: updatedTask.dueDate
          ? updatedTask.dueDate.toISOString()
          : null,
        result: updatedTask.result,
        submittedAt: updatedTask.submittedAt
          ? updatedTask.submittedAt.toISOString()
          : null,
        submittedBy: updatedTask.submittedBy,
        submittedByType: updatedTask.submittedByType,
        createdAt: updatedTask.createdAt.toISOString(),
        updatedAt: updatedTask.updatedAt.toISOString(),
      },
    });
  } catch (error) {
    console.error('CustomerSubmitTask error:', error);

    return respond(500, {
      error: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to submit task',
    });
  }
};

function respond(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  };
}