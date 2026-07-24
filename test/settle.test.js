import { jest } from '@jest/globals';

jest.unstable_mockModule('firebase-admin/firestore', () => ({
  FieldValue: {
    increment: (n) => ({ __inc: n }),
    arrayUnion: (v) => ({ __arrUnion: v }),
  },
}));

const orgState = {};
const userState = {};
const taskState = {};
const mockOrgGet = jest.fn();
const mockUserGet = jest.fn();
const mockTaskGet = jest.fn();
const mockTaskUpdate = jest.fn();
const mockRtdbSet = jest.fn();
const mockRtdbUpdate = jest.fn();

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
    update: mockTaskUpdate,
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
    rtdb: () => ({ ref: () => ({ update: mockRtdbUpdate, set: mockRtdbSet }) }),
  };
});

const { deductReserved, releaseReserved, writeTerminalStatus, recordUsage, updateUserStats } = await import('../src/settle.js');

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
    expect(Array.isArray(orgState.credit_history)).toBe(true);
    expect(orgState.credit_history.length).toBe(1);
    expect(orgState.credit_history[0].used_credits).toBe(7);
    expect(orgState.credit_history[0].remaining_credits).toBe(93);
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

describe('writeTerminalStatus', () => {
  test('with ingest merges results/s3_keys/thumbnail_keys + durations on success', async () => {
    const ingest = {
      results: [{ s3_key: 'tasks/o1/upscale/2026/07/10/u1/t/1.png', url_type: 'cloudfront', cloudfront_url: 'https://cdn/x' }],
      s3_keys: ['tasks/o1/upscale/2026/07/10/u1/t/1.png'],
      thumbnail_keys: ['tasks/o1/upscale/2026/07/10/u1/t/1.webp'],
    };
    await writeTerminalStatus({
      taskId: 'task_1',
      payload: { event: 'job.completed', job_id: 'job_1' },
      taskData: { user_id: 'u1', created_at: '07/10/2026, 10:00:00', processing_started_at: '07/10/2026, 10:01:00' },
      ingest,
    });
    expect(mockTaskUpdate).toHaveBeenCalledTimes(1);
    const patch = mockTaskUpdate.mock.calls[0][0];
    expect(patch.status).toBe('completed');
    expect(patch.results).toEqual(ingest.results);
    expect(patch.s3_keys).toEqual(ingest.s3_keys);
    expect(patch.thumbnail_keys).toEqual(ingest.thumbnail_keys);
    expect(patch.completed_at).toBeTruthy();
    expect(patch.queue_duration_ms).toBeGreaterThanOrEqual(0);
    expect(patch.processing_duration_ms).toBeGreaterThanOrEqual(0);
    expect(patch.total_duration_ms).toBeGreaterThanOrEqual(0);
  });

  test('without ingest omits results/s3_keys/thumbnail_keys on success', async () => {
    await writeTerminalStatus({
      taskId: 'task_2',
      payload: { event: 'job.completed', job_id: 'job_2' },
      taskData: { user_id: 'u1' },
    });
    expect(mockTaskUpdate).toHaveBeenCalledTimes(1);
    const patch = mockTaskUpdate.mock.calls[0][0];
    expect(patch.status).toBe('completed');
    expect(patch.completed_at).toBeTruthy();
    expect(patch).not.toHaveProperty('results');
    expect(patch).not.toHaveProperty('s3_keys');
    expect(patch).not.toHaveProperty('thumbnail_keys');
  });

  test('failure branch unchanged: no ingest fields, no durations', async () => {
    await writeTerminalStatus({
      taskId: 'task_3',
      payload: { event: 'job.failed', job_id: 'job_3' },
      taskData: { user_id: 'u1' },
      ingest: { results: [], s3_keys: [], thumbnail_keys: [] }, // must be ignored on failure
    });
    expect(mockTaskUpdate).toHaveBeenCalledTimes(1);
    const patch = mockTaskUpdate.mock.calls[0][0];
    expect(patch.status).toBe('failed');
    expect(patch.failed_at).toBeTruthy();
    expect(patch.error_message).toMatch(/failed/);
    expect(patch).not.toHaveProperty('results');
    expect(patch).not.toHaveProperty('s3_keys');
    expect(patch).not.toHaveProperty('thumbnail_keys');
    expect(patch).not.toHaveProperty('completed_at');
    expect(patch).not.toHaveProperty('queue_duration_ms');
  });

  test('all_modes partial success: forwards has_partial_failures + failed_modes to Firestore', async () => {
    await writeTerminalStatus({
      taskId: 'task_am',
      payload: {
        event: 'job.completed', job_id: 'job_am',
        has_partial_failures: true,
        failed_modes: ['inspired_pattern'],
      },
      taskData: { user_id: 'u1' },
    });
    expect(mockTaskUpdate).toHaveBeenCalledTimes(1);
    const patch = mockTaskUpdate.mock.calls[0][0];
    expect(patch.status).toBe('completed');
    expect(patch.has_partial_failures).toBe(true);
    expect(patch.failed_modes).toEqual(['inspired_pattern']);
  });

  test('all_modes full success: does NOT set has_partial_failures when false', async () => {
    await writeTerminalStatus({
      taskId: 'task_am2',
      payload: {
        event: 'job.completed', job_id: 'job_am2',
        has_partial_failures: false,
        failed_modes: [],
      },
      taskData: { user_id: 'u1' },
    });
    expect(mockTaskUpdate).toHaveBeenCalledTimes(1);
    const patch = mockTaskUpdate.mock.calls[0][0];
    expect(patch.status).toBe('completed');
    expect(patch).not.toHaveProperty('has_partial_failures');
    expect(patch).not.toHaveProperty('failed_modes');
  });

  test('does NOT mirror to RTDB tasks/{userId} (Firestore is the sole terminal write)', async () => {
    await writeTerminalStatus({
      taskId: 'task_4',
      payload: { event: 'job.completed', job_id: 'job_4' },
      taskData: { user_id: 'u1' },
    });
    expect(mockRtdbSet).not.toHaveBeenCalled();
    expect(mockRtdbUpdate).not.toHaveBeenCalled();
    expect(mockTaskUpdate).toHaveBeenCalledTimes(1);
  });
});

describe('recordUsage', () => {
  test('writes credit_history + credits_used but NOT credits/reserved_credits (unlimited org)', async () => {
    mockOrgGet.mockReturnValue({ credits: 999, reserved_credits: 0, credits_used: 100 });
    mockUserGet.mockReturnValue({ credits_used: 20 });
    mockTaskGet.mockReturnValue({ status: 'processing', credits: 7, credits_settled: false });
    await recordUsage({ taskId: 't1', orgId: 'o1', uid: 'u1', amount: 7 });
    // credits and reserved_credits must NOT be touched
    expect(orgState.credits).toBeUndefined();
    expect(orgState.reserved_credits).toBeUndefined();
    // credits_used and credit_history ARE written
    expect(orgState.credits_used.__inc).toBe(7);
    expect(Array.isArray(orgState.credit_history)).toBe(true);
    expect(orgState.credit_history[0].used_credits).toBe(7);
    expect(orgState.credit_history[0].remaining_credits).toBe(999); // unchanged
    expect(userState.credits_used.__inc).toBe(7);
    expect(taskState.credits_settled).toBe(true);
  });

  test('idempotent: no-op when credits_settled already true', async () => {
    mockOrgGet.mockReturnValue({ credits: 999, reserved_credits: 0, credits_used: 100 });
    mockUserGet.mockReturnValue({ credits_used: 20 });
    mockTaskGet.mockReturnValue({ credits_settled: true });
    await recordUsage({ taskId: 't1', orgId: 'o1', uid: 'u1', amount: 7 });
    expect(Object.keys(orgState)).toHaveLength(0);
    expect(Object.keys(userState)).toHaveLength(0);
    expect(Object.keys(taskState)).toHaveLength(0);
  });
});

describe('cataloguing_credits pool', () => {
  test('deductReserved: writes cataloguing_credits fields, skips org_users (no per-user cataloguing limit)', async () => {
    mockOrgGet.mockReturnValue({ cataloguing_credits: 500, reserved_cataloguing_credits: 120, cataloguing_credits_used: 50 });
    mockUserGet.mockReturnValue({ credits_used: 20 }); // AI credits_used — must NOT be touched
    mockTaskGet.mockReturnValue({ status: 'processing', credits: 120, credits_settled: false });
    await deductReserved({ taskId: 't1', orgId: 'o1', uid: 'u1', amount: 120, pool: 'cataloguing_credits' });
    // cataloguing pool fields
    expect(orgState.cataloguing_credits.__inc).toBe(-120);
    expect(orgState.reserved_cataloguing_credits.__inc).toBe(-120);
    expect(orgState.cataloguing_credits_used.__inc).toBe(120);
    expect(Array.isArray(orgState.cataloguing_credit_history)).toBe(true);
    expect(orgState.cataloguing_credit_history[0].used_credits).toBe(120);
    expect(orgState.cataloguing_credit_history[0].remaining_credits).toBe(380);
    // AI pool fields must NOT be touched
    expect(orgState.credits).toBeUndefined();
    expect(orgState.reserved_credits).toBeUndefined();
    expect(orgState.credits_used).toBeUndefined();
    // org_users.credits_used must NOT be touched (no per-user cataloguing ledger)
    expect(Object.keys(userState)).toHaveLength(0);
    // task settlement marker still written
    expect(taskState.credits_settled).toBe(true);
    expect(taskState.credits_settled_amount).toBe(120);
  });

  test('releaseReserved: releases from reserved_cataloguing_credits', async () => {
    mockOrgGet.mockReturnValue({ reserved_cataloguing_credits: 100 });
    mockTaskGet.mockReturnValue({ credits_settled: false });
    await releaseReserved({ taskId: 't1', orgId: 'o1', amount: 50, pool: 'cataloguing_credits' });
    expect(orgState.reserved_cataloguing_credits.__inc).toBe(-50);
    // AI reserved must NOT be touched
    expect(orgState.reserved_credits).toBeUndefined();
    expect(taskState.credits_settled).toBe(true);
  });

  test('recordUsage: writes cataloguing_credit_history + cataloguing_credits_used but NOT cataloguing_credits or reserved_cataloguing_credits', async () => {
    mockOrgGet.mockReturnValue({ cataloguing_credits: 500, reserved_cataloguing_credits: 0, cataloguing_credits_used: 100 });
    mockUserGet.mockReturnValue({ credits_used: 20 });
    mockTaskGet.mockReturnValue({ status: 'processing', credits: 78, credits_settled: false });
    await recordUsage({ taskId: 't1', orgId: 'o1', uid: 'u1', amount: 78, pool: 'cataloguing_credits' });
    // cataloguing_credits and reserved_cataloguing_credits must NOT be touched
    expect(orgState.cataloguing_credits).toBeUndefined();
    expect(orgState.reserved_cataloguing_credits).toBeUndefined();
    // cataloguing_credits_used and cataloguing_credit_history ARE written
    expect(orgState.cataloguing_credits_used.__inc).toBe(78);
    expect(Array.isArray(orgState.cataloguing_credit_history)).toBe(true);
    expect(orgState.cataloguing_credit_history[0].used_credits).toBe(78);
    expect(orgState.cataloguing_credit_history[0].remaining_credits).toBe(500); // unchanged
    // org_users.credits_used must NOT be touched
    expect(Object.keys(userState)).toHaveLength(0);
    expect(taskState.credits_settled).toBe(true);
  });
});
