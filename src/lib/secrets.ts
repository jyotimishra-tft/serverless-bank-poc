import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const client = new SecretsManagerClient({});

// Cached per warm Lambda container - avoids a Secrets Manager call on every invocation.
let cachedDatabaseUrl: string | undefined;

export async function getDatabaseUrl(): Promise<string> {
  console.log("1. getDatabaseUrl started");

  if (cachedDatabaseUrl) {
    console.log("2. Returning cached DB URL");
    return cachedDatabaseUrl;
  }

  const { DB_HOST, DB_PORT, DB_NAME, DB_SECRET_ARN } = process.env;

  console.log("3. Environment check", {
    DB_HOST,
    DB_PORT,
    DB_NAME,
    DB_SECRET_ARN: DB_SECRET_ARN ? "SET" : "MISSING",
  });

  if (!DB_HOST || !DB_PORT || !DB_NAME || !DB_SECRET_ARN) {
    throw new Error(
      "Missing one of DB_HOST, DB_PORT, DB_NAME, DB_SECRET_ARN environment variables"
    );
  }

  console.log("4. Calling Secrets Manager");

  const result = await client.send(
    new GetSecretValueCommand({
      SecretId: DB_SECRET_ARN,
    })
  );

  console.log("5. Secrets Manager returned");

  if (!result.SecretString) {
    throw new Error(`Secret ${DB_SECRET_ARN} has no SecretString`);
  }

  const { username, password } =
    JSON.parse(result.SecretString) as {
      username: string;
      password: string;
    };

  console.log("6. Secret parsed", {
    username,
    hasPassword: !!password,
  });

  cachedDatabaseUrl = `postgresql://${username}:${encodeURIComponent(
    password
  )}@${DB_HOST}:${DB_PORT}/${DB_NAME}?sslmode=require`;

  console.log("7. Database URL constructed");

  return cachedDatabaseUrl;
}