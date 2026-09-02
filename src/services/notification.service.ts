import {getPrisma} from '../lib/db';

import {
  deriveOverallStatus,
  deriveCurrentStepName,
  deriveNextDueDate,
} from './casestatus.service';
import { sendActionRequiredEmail } from './mailer.service';
import {
  findByCaseId,
  createNotified,
  deleteByCaseId,
} from '../repositories/caseNotification.repository';


export async function runNotificationSweep() {
 const prisma = await getPrisma();
  const cases = await prisma.claimCase.findMany({
    include: {
      customer: {
        select: {
          email: true,
          commPrefEmail: true,
        },
      },
      workflowSteps: {
        orderBy: {
          position: 'asc',
        },
        include: {
          tasks: true,
        },
      },
    },
  });

  let notified = 0;
  let skipped = 0;

  for (const claimCase of cases) {
    try {
      const tasks = claimCase.workflowSteps.flatMap((step) =>
        step.tasks.map((task) => ({
          ...task,
          stepName: step.name,
          stepPosition: step.position,
        })),
      );

      const status = deriveOverallStatus(tasks);

      /*
       * No longer action_required:
       * remove the previous notification marker.
       *
       * This allows a NEW notification if the case becomes
       * action_required again later.
       */
      if (status !== 'action_required') {
        await deleteByCaseId(claimCase.id);
        continue;
      }

      /*
       * Already notified during this action_required period.
       */
      const existingNotification = await findByCaseId(
        claimCase.id,
      );

      if (existingNotification) {
        skipped++;
        continue;
      }

      /*
       * Customer doesn't want email.
       */
      if (
        !claimCase.customer.commPrefEmail ||
        !claimCase.customer.email
      ) {
        skipped++;
        continue;
      }

      const currentStepName =
        deriveCurrentStepName(tasks);

      const nextDueDate =
        deriveNextDueDate(tasks);

      /*
       * Send email.
       */
      await sendActionRequiredEmail({
        to: claimCase.customer.email,
        referenceNumber: claimCase.referenceNumber,
        currentStepName,
        nextDueDate,
      });

      /*
       * Only mark as notified AFTER successful email.
       */
      await createNotified(claimCase.id);

      notified++;

      /*
       * Optional push.
       */
      await sendOptionalPush({
        claimCaseId: claimCase.id,
        referenceNumber: claimCase.referenceNumber,
        currentStepName,
        nextDueDate,
      });
    } catch (error) {
      console.error(
        `Notification failed for case ${claimCase.id}`,
        error,
      );

      /*
       * Don't fail the complete sweep because one case failed.
       */
    }
  }

  return {
    processed: cases.length,
    notified,
    skipped,
  };
}

async function sendOptionalPush({
  claimCaseId,
  referenceNumber,
  currentStepName,
  nextDueDate,
}: {
  claimCaseId: string;
  referenceNumber: string;
  currentStepName: string | null;
  nextDueDate: Date | null;
}) {
  const provider = process.env.PUSH_PROVIDER;

  if (!provider) {
    return;
  }

  // Add Firebase / SNS / other provider here later.
  console.log('Push provider configured', {
    provider,
    claimCaseId,
    referenceNumber,
    currentStepName,
    nextDueDate,
  });
}