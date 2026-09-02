import { deriveCaseStatus } from '../src/services/statusService';

test('derives completed when no pending tasks', () => {
  const status = deriveCaseStatus([{ status: 'submitted', dueDate: null }]);
  expect(status).toBe('completed');
});

test('derives in_progress when pending tasks exist', () => {
  const status = deriveCaseStatus([{ status: 'pending', dueDate: '2099-01-01' }]);
  expect(status).toBe('in_progress');
});

test('derives action_required when a pending task is overdue', () => {
  const status = deriveCaseStatus([{ status: 'pending', dueDate: '2000-01-01' }]);
  expect(status).toBe('action_required');
});
