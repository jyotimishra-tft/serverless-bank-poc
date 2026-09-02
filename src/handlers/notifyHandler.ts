import { runNotificationSweep } from '../services/notification.service';

export const handler = async () => {
  console.log('Notification sweep started');

  const result = await runNotificationSweep();

  console.log('Notification sweep completed', result);

  return {
    statusCode: 200,
    body: JSON.stringify(result),
  };
};