import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
//import prisma from '../lib/db';

export const handler = async (_event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const result = await prisma.$queryRaw`SELECT version()`;
    return {
      statusCode: 200,
      body: JSON.stringify({ cases: [], dbVersion: result }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Database error', details: String(err) }),
    };
  }
};