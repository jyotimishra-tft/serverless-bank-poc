export type CaseStatus = 'action_required' | 'in_progress' | 'completed';

export interface TaskSummary {
  status: string;
  dueDate: string | null;
}

export const deriveCaseStatus = (tasks: TaskSummary[]): CaseStatus => {
  const now = new Date();
  const pending = tasks.filter((task) => task.status === 'pending');
  if (pending.some((task) => task.dueDate && new Date(task.dueDate) < now)) {
    return 'action_required';
  }
  if (pending.length > 0) {
    return 'in_progress';
  }
  return 'completed';
};
