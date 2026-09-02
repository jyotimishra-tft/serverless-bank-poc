import { TaskStatus } from '@prisma/client';

type TaskWithStep = {
  status: TaskStatus;
  dueDate: Date | null;
  stepName: string;
  stepPosition: number;
  submittedAt?: Date | null;
};

export function deriveOverallStatus(
  tasks: TaskWithStep[],
): 'action_required' | 'in_progress' | 'completed' {
  const pendingTasks = tasks.filter(
    (task) => task.status === 'pending',
  );

  if (pendingTasks.length === 0) {
    return 'completed';
  }

  const today = new Date();

  today.setHours(0, 0, 0, 0);

  const hasOverdueTask = pendingTasks.some((task) => {
    if (!task.dueDate) {
      return false;
    }

    const dueDate = new Date(task.dueDate);
    dueDate.setHours(0, 0, 0, 0);

    return dueDate < today;
  });

  if (hasOverdueTask) {
    return 'action_required';
  }

  return 'in_progress';
}

export function deriveCurrentStepName(
  tasks: TaskWithStep[],
): string | null {
  if (!tasks.length) {
    return null;
  }

  const incompleteTasks = tasks
    .filter((task) => task.status === 'pending')
    .sort((a, b) => {
      return a.stepPosition - b.stepPosition;
    });

  if (incompleteTasks.length > 0) {
    return incompleteTasks[0].stepName;
  }

  /*
   * Everything is completed.
   * Return the most recently encountered step.
   */
  return [...tasks]
    .sort((a, b) => b.stepPosition - a.stepPosition)[0]
    ?.stepName ?? null;
}

export function deriveNextDueDate(
  tasks: TaskWithStep[],
): Date | null {
  const pendingTasks = tasks
    .filter(
      (task) =>
        task.status === 'pending' &&
        task.dueDate !== null,
    )
    .sort(
      (a, b) =>
        a.dueDate!.getTime() -
        b.dueDate!.getTime(),
    );

  return pendingTasks[0]?.dueDate ?? null;
}