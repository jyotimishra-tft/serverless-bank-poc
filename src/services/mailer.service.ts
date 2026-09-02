import {
  SESClient,
  SendEmailCommand,
} from '@aws-sdk/client-ses';

const ses = new SESClient({
  region: process.env.AWS_REGION,
});

interface ActionRequiredEmail {
  to: string;
  referenceNumber: string;
  currentStepName: string | null;
  nextDueDate: Date | null;
}

function formatDate(date: Date | null): string {
  if (!date) {
    return 'No due date';
  }

  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(date);
}

export async function sendActionRequiredEmail({
  to,
  referenceNumber,
  currentStepName,
  nextDueDate,
}: ActionRequiredEmail) {
  const fromEmail = process.env.FROM_EMAIL;

  if (!fromEmail) {
    throw new Error('FROM_EMAIL is not configured');
  }

  const subject =
    `Action required for case ${referenceNumber}`;

  const body = [
    'Dear Customer,',
    '',
    'Action is required on your case.',
    '',
    `Reference number: ${referenceNumber}`,
    `Current step: ${currentStepName ?? 'N/A'}`,
    `Next due date: ${formatDate(nextDueDate)}`,
    '',
    'Please log in to the customer portal to review the required action.',
    '',
    'Regards,',
    'Customer Support',
  ].join('\n');

  const command = new SendEmailCommand({
    Source: fromEmail,

    Destination: {
      ToAddresses: [to],
    },

    Message: {
      Subject: {
        Data: subject,
        Charset: 'UTF-8',
      },

      Body: {
        Text: {
          Data: body,
          Charset: 'UTF-8',
        },
      },
    },
  });

  const result = await ses.send(command);

  console.log('SES email sent', {
    messageId: result.MessageId,
    to,
    from: fromEmail,
  });
  return result;
}