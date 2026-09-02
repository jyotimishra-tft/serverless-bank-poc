import type { APIGatewayProxyHandlerV2WithJWTAuthorizer } from 'aws-lambda';
import { getPrisma } from '../lib/db';

/**
 * Proves the JWT auth chain works end to end: API Gateway's CognitoAuthorizer
 * has already validated the token by the time this code runs - if the token
 * were invalid/expired/wrong audience, this handler would never be invoked
 * at all (API Gateway returns 401 itself, before Lambda).
 *
 * event.requestContext.authorizer.jwt.claims is populated by API Gateway
 * from the token's payload - sub is Cognito's permanent user ID, matching
 * cognitoSub on Customer/Agent rows.
 */
export const handler: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (event) => {
  const claims = event.requestContext.authorizer.jwt.claims;
  const sub = claims.sub as string;
  const email = claims.email as string | undefined;

  if (!sub) {
    // Shouldn't happen if the authorizer did its job, but fail loudly
    // rather than silently if it somehow does.
    return respond(401, { error: 'No sub claim in token' });
  }

  const prisma = await getPrisma();

  const customer = await prisma.customer.findUnique({ where: { cognitoSub: sub } });
  if (customer) {
    return respond(200, {
      role: 'customer',
      id: customer.id,
      email: customer.email,
      firstName: customer.firstName,
      lastName: customer.lastName,
    });
  }

  const agent = await prisma.agent.findUnique({
    where: { cognitoSub: sub },
    include: { organisation: { select: { id: true, name: true } } },
  });
  if (agent) {
    return respond(200, {
      role: 'agent',
      id: agent.id,
      email: agent.email,
      name: agent.name,
      organisation: agent.organisation,
    });
  }

  // Valid Cognito token, but no matching DB row - e.g. PostConfirmation
  // failed to write the row, or this identity predates that trigger.
  return respond(404, {
    error: 'Authenticated but no matching Customer or Agent record found',
    sub,
    email,
  });
};

function respond(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}