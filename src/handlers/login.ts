import type { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
} from '@aws-sdk/client-cognito-identity-provider';

const client = new CognitoIdentityProviderClient({});

interface LoginBody {
  email: string;
  password: string;
}

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  if (!event.body) {
    return respond(400, { error: 'Missing request body' });
  }

  let body: LoginBody;
  try {
    body = JSON.parse(event.body);
  } catch {
    return respond(400, { error: 'Invalid JSON body' });
  }

  const { email, password } = body;
  if (!email || !password) {
    return respond(400, { error: 'email and password are required' });
  }

  const clientId = process.env.USER_POOL_CLIENT_ID;
  if (!clientId) {
    return respond(500, { error: 'Server misconfiguration: missing USER_POOL_CLIENT_ID' });
  }

  try {
    const result = await client.send(
      new InitiateAuthCommand({
        AuthFlow: 'USER_PASSWORD_AUTH',
        ClientId: clientId,
        AuthParameters: {
          USERNAME: email,
          PASSWORD: password,
        },
      })
    );

    const tokens = result.AuthenticationResult;
    if (!tokens) {
      // Would happen for flows requiring an extra challenge (MFA, new
      // password required, etc.) - not expected with our current setup,
      // but worth a clear error instead of a silent undefined crash.
      return respond(400, {
        error: 'Login requires an additional challenge, not currently supported',
        challenge: result.ChallengeName,
      });
    }

    return respond(200, {
      idToken: tokens.IdToken,
      accessToken: tokens.AccessToken,
      refreshToken: tokens.RefreshToken,
      expiresIn: tokens.ExpiresIn,
    });
  } catch (err) {
    // Covers NotAuthorizedException (wrong password), UserNotFoundException,
    // UserNotConfirmedException, etc. - Cognito's message is client-safe.
    const message = err instanceof Error ? err.message : 'Login failed';
    return respond(401, { error: message });
  }
};

function respond(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}