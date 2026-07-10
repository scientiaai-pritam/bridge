import { jest } from '@jest/globals';

jest.unstable_mockModule('firebase-admin/firestore', () => ({
  FieldValue: { increment: (n) => ({ __inc: n }) },
}));

const orgState = {};
const userState = {};
const taskState = {};
const mockOrgGet = jest.fn();
const mockUserGet = jest.fn();
const mockTaskGet = jest.fn();

// Tag each doc ref with its path so the txn.update mock can route writes to the
// right shadow object.
jest.unstable_mockModule('../src/firebase.js', () => {
  const taggedDoc = (path) => ({
    __path: path,
    get: async () => {
      if (path.startsWith('orgs/')) return { exists: true, data: () => mockOrgGet() };
      if (path.startsWith('org_users/')) return { exists: true, data: () => mockUserGet() };
      if (path.startsWith('tasks/')) return { exists: true, data: () => mockTaskGet() };
      return { exists: false, data: () => null };
    },
  });
  return {
    firestore: () => ({
      doc: taggedDoc,
      runTransaction: jest.fn(async (fn) => fn({
        get: async (ref) => ref.get(),
        update: (ref, u) => {
          if (ref.__path.startsWith('orgs/')) Object.assign(orgState, u);
          else if (ref.__path.startsWith('org_users/')) Object.assign(userState, u);
          else if (ref.__path.startsWith('tasks/')) Object.assign(taskState, u);
        },
      })),
    }),
    rtdb: () => ({ ref: () => ({ update: jest.fn(), set: jest.fn() }) }),
  };
});

const { deductReserved, releaseReserved } = await import('../src/settle.js');

beforeEach(() => {
  jest.clearAllMocks();
  for (const k of Object.keys(orgState)) delete orgState[k];
  for (const k of Object.keys(userState)) delete userState[k];
  for (const k of Object.keys(taskState)) delete taskState[k];
});

describe('deductReserved', () => {
  test('3-doc transaction: org fields + org_users.credits_used + task.credits_settled', async () => {
    mockOrgGet.mockReturnValue({ credits: 100, reserved_credits: 7, credits_used: 50 });
    mockUserGet.mockReturnValue({ credits_used: 20 });
    mockTaskGet.mockReturnValue({ status: 'processing', credits: 7, credits_settled: false });
    await deductReserved({ taskId: 't1', orgId: 'o1', uid: 'u1', amount: 7 });
    expect(orgState.credits.__inc).toBe(-7);
    expect(orgState.reserved_credits.__inc).toBe(-7);
    expect(orgState.credits_used.__inc).toBe(7);
    expect(userState.credits_used.__inc).toBe(7);
    expect(taskState.credits_settled).toBe(true);
    expect(taskState.credits_settled_amount).toBe(7);
  });

  test('throws when reserved_credits < amount (guard)', async () => {
    mockOrgGet.mockReturnValue({ credits: 100, reserved_credits: 3, credits_used: 50 });
    mockUserGet.mockReturnValue({ credits_used: 20 });
    mockTaskGet.mockReturnValue({ credits_settled: false });
    await expect(deductReserved({ taskId: 't1', orgId: 'o1', uid: 'u1', amount: 7 })).rejects.toThrow(/insufficient/i);
  });

  test('idempotent: no-op when credits_settled already true', async () => {
    mockOrgGet.mockReturnValue({ credits: 100, reserved_credits: 7, credits_used: 50 });
    mockUserGet.mockReturnValue({ credits_used: 20 });
    mockTaskGet.mockReturnValue({ credits_settled: true });
    await deductReserved({ taskId: 't1', orgId: 'o1', uid: 'u1', amount: 7 });
    expect(Object.keys(orgState)).toHaveLength(0); // no writes
    expect(Object.keys(userState)).toHaveLength(0);
    expect(Object.keys(taskState)).toHaveLength(0);
  });
});

describe('releaseReserved', () => {
  test('2-doc transaction: reserved_credits clamped + task.credits_settled', async () => {
    mockOrgGet.mockReturnValue({ reserved_credits: 5 });
    mockTaskGet.mockReturnValue({ credits_settled: false });
    await releaseReserved({ taskId: 't1', orgId: 'o1', amount: 7 });
    expect(orgState.reserved_credits.__inc).toBe(-5); // clamped to actual reserved
    expect(taskState.credits_settled).toBe(true);
  });

  test('idempotent: no-op when credits_settled already true', async () => {
    mockOrgGet.mockReturnValue({ reserved_credits: 5 });
    mockTaskGet.mockReturnValue({ credits_settled: true });
    await releaseReserved({ taskId: 't1', orgId: 'o1', amount: 7 });
    expect(Object.keys(orgState)).toHaveLength(0);
  });
});
