import {getPrisma} from '../lib/db';

export async function findByCaseId(claimCaseId: string) {
  const prisma = await getPrisma();
  return prisma.caseNotification.findUnique({
    where: {
      claimCaseId,
    },
  });
}

export async function createNotified(claimCaseId: string) {
  const now = new Date();
 const prisma = await getPrisma();
  return prisma.caseNotification.create({
    data: {
      claimCaseId,
      lastActionRequiredAt: now,
      lastNotifiedAt: now,
    },
  });
}

export async function deleteByCaseId(claimCaseId: string) {
  const prisma = await getPrisma();
  return prisma.caseNotification.deleteMany({
    where: {
      claimCaseId,
    },
  });
}