import type { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import {
  CognitoIdentityProviderClient,
  SignUpCommand,
} from '@aws-sdk/client-cognito-identity-provider';

const client = new CognitoIdentityProviderClient({});

interface SignupBody {
  email: string;
  password: string;
  role: 'agent' | 'customer';
  firstName: string;
  lastName?: string;
  inviteCode?: string; // required for agents, ignored for customers
}

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  if (!event.body) {
    return respond(400, { error: 'Missing request body' });
  }

  let body: SignupBody;
  try {
    body = JSON.parse(event.body);
  } catch {
    return respond(400, { error: 'Invalid JSON body' });
  }

  const { email, password, role, firstName, lastName, inviteCode } = body;

  if (!email || !password || !role || !firstName) {
    return respond(400, { error: 'email, password, role, and firstName are required' });
  }
  if (role !== 'agent' && role !== 'customer') {
    return respond(400, { error: "role must be 'agent' or 'customer'" });
  }
  if (role === 'agent' && !inviteCode) {
    return respond(400, { error: 'inviteCode is required for agent signup' });
  }

  const clientId = process.env.USER_POOL_CLIENT_ID;
  if (!clientId) {
    return respond(500, { error: 'Server misconfiguration: missing USER_POOL_CLIENT_ID' });
  }

  try {
    const result = await client.send(
      new SignUpCommand({
        ClientId: clientId,
        Username: email,
        Password: password,
        UserAttributes: [{ Name: 'email', Value: email }],
        // This is what PreSignUp and PostConfirmation read via
        // event.request.clientMetadata - PostConfirmation uses firstName/
        // lastName to actually create the Customer/Agent row.
        ClientMetadata: {
          role,
          firstName,
          ...(lastName ? { lastName } : {}),
          ...(inviteCode ? { inviteCode } : {}),
        },
      })
    );

    return respond(201, {
      userSub: result.UserSub,
      confirmed: result.UserConfirmed,
    });
  } catch (err) {
    // PreSignUp rejections (bad invite code, etc.) surface here as
    // Cognito errors - pass the message through so the client sees why.
    const message = err instanceof Error ? err.message : 'Signup failed';
    return respond(400, { error: message });
  }
};

function respond(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}