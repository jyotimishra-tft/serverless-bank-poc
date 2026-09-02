import { PrismaClient } from '@prisma/client';
import { getDatabaseUrl } from './secrets';

let prismaInstance: PrismaClient | undefined;

export async function getPrisma(): Promise<PrismaClient> {
  if (prismaInstance) return prismaInstance;

  const url = await getDatabaseUrl();
  prismaInstance = new PrismaClient({
    datasources: { db: { url } },
  });

  return prismaInstance;
}