// Self-sufficient: the suite must pass whether or not the runner exports this env var.
process.env.WEBHOOK_SIGNING_SECRET = process.env.WEBHOOK_SIGNING_SECRET || 'whsec_test';

import { jest } from '@jest/globals';

const mockGet = jest.fn();
const mockUpdate = jest.fn();
const mockSet = jest.fn();
const mockRtdbUpdate = jest.fn();

jest.unstable_mockModule('../src/firebase.js', () => ({
  firestore: () => ({ doc: () => ({ get: mockGet, update: mockUpdate }) }),
  rtdb: () => ({ ref: () => ({ update: mockRtdbUpdate, set: mockSet }) }),
}));

const mockDeductReserved = jest.fn().mockResolvedValue(undefined);
const mockReleaseReserved = jest.fn().mockResolvedValue(undefined);
const mockRecordUsage = jest.fn().mockResolvedValue(undefined);
const mockUpdateUserStats = jest.fn().mockResolvedValue(undefined);
const mockWriteTerminalStatus = jest.fn(async ({ payload }) => ({
  status: payload.event === 'job.completed' ? 'completed' : 'failed',
}));
jest.unstable_mockModule('../src/settle.js', () => ({
  writeTerminalStatus: mockWriteTerminalStatus,
  TERMINAL: new Set(['completed', 'failed']),
  deductReserved: mockDeductReserved,
  releaseReserved: mockReleaseReserved,
  recordUsage: mockRecordUsage,
  updateUserStats: mockUpdateUserStats,
}));

const mockIngestOutputs = jest.fn();
jest.unstable_mockModule('../src/ingest.js', () => ({ ingestOutputs: mockIngestOutputs }));

const { handler } = await import('../src/handler.js');
const { signForTest } = await import('../src/signing.js');

const SECRET = 'whsec_test';
const baseEvent = (payload) => {
  const body = JSON.stringify(payload);
  const ts = 1_700_000_000;
  return {
    body,
    headers: { 'x-tdai-signature': signForTest(body, SECRET, ts) },
    requestContext: { timeEpoch: ts * 1000 },
  };
};

beforeEach(() => jest.clearAllMocks());

test('returns 401 on bad signature', async () => {
  const res = await handler({ body: '{}', headers: { 'x-tdai-signature': 'bad' }, requestContext: { timeEpoch: 1_700_000_000_000 } });
  expect(res.statusCode).toBe(401);
});

test('writes completed status and returns 200 (Phase 1: no credit/S3)', async () => {
  mockGet.mockResolvedValueOnce({ exists: true, data: () => ({ status: 'processing', user_id: 'u1', org_id: 'o1', type: 'upscale', credits: 5, api_job_id: 'job_1' }) });
  const res = await handler(baseEvent({ event: 'job.completed', job_id: 'job_1', tool: 'upscale', status: 'completed', outputs: ['https://x/y.png'], request_id: 'task_1' }));
  expect(res.statusCode).toBe(200);
});

test('idempotency: already-terminal task returns 200 with no write', async () => {
  mockGet.mockResolvedValueOnce({ exists: true, data: () => ({ status: 'completed' }) });
  const res = await handler(baseEvent({ event: 'job.completed', job_id: 'job_1', tool: 'upscale', status: 'completed', outputs: [], request_id: 'task_1' }));
  expect(res.statusCode).toBe(200);
  expect(mockUpdate).not.toHaveBeenCalled();
});

test('returns 500 on missing task doc to force WebhookQueue retry', async () => {
  mockGet.mockResolvedValueOnce({ exists: false, data: () => null });
  const res = await handler(baseEvent({ event: 'job.completed', job_id: 'job_1', tool: 'upscale', status: 'completed', outputs: [], request_id: 'missing' }));
  expect(res.statusCode).toBe(500);
});

test('success path calls deductReserved({taskId, orgId, uid, amount=taskData.credits}) + updateUserStats after status write', async () => {
  mockGet.mockResolvedValueOnce({
    exists: true,
    data: () => ({ status: 'processing', user_id: 'u1', org_id: 'o1', type: 'upscale', credits: 7, api_job_id: 'job_1' }),
  });
  const res = await handler(baseEvent({
    event: 'job.completed', job_id: 'job_1', tool: 'upscale', status: 'completed',
    outputs: ['https://x/y.png'], request_id: 'task_1',
  }));
  expect(res.statusCode).toBe(200);
  expect(mockDeductReserved).toHaveBeenCalledWith({ taskId: 'task_1', orgId: 'o1', uid: 'u1', amount: 7, pool: 'credits' });
  expect(mockRecordUsage).not.toHaveBeenCalled();
  expect(mockUpdateUserStats).toHaveBeenCalledWith({
    taskId: 'task_1',
    taskData: expect.objectContaining({ type: 'upscale', credits: 7 }),
    imageCount: 0, // ingest not mocked → undefined → 0
  });
  expect(mockReleaseReserved).not.toHaveBeenCalled();
});

test('failure path calls releaseReserved({taskId, orgId, amount=taskData.credits})', async () => {
  mockGet.mockResolvedValueOnce({
    exists: true,
    data: () => ({ status: 'processing', user_id: 'u1', org_id: 'o1', type: 'upscale', credits: 7, api_job_id: 'job_1' }),
  });
  const res = await handler(baseEvent({
    event: 'job.failed', job_id: 'job_1', tool: 'upscale', status: 'failed',
    outputs: [], request_id: 'task_1',
  }));
  expect(res.statusCode).toBe(200);
  expect(mockReleaseReserved).toHaveBeenCalledWith({ taskId: 'task_1', orgId: 'o1', amount: 7, pool: 'credits' });
  expect(mockDeductReserved).not.toHaveBeenCalled();
});

test('already-terminal task settles nothing (idempotency — no double-settle on retry)', async () => {
  mockGet.mockResolvedValueOnce({
    exists: true,
    data: () => ({ status: 'completed', user_id: 'u1', org_id: 'o1', credits: 7 }),
  });
  const res = await handler(baseEvent({
    event: 'job.completed', job_id: 'job_1', tool: 'upscale', status: 'completed',
    outputs: [], request_id: 'task_1',
  }));
  expect(res.statusCode).toBe(200);
  expect(mockDeductReserved).not.toHaveBeenCalled();
  expect(mockReleaseReserved).not.toHaveBeenCalled();
});

test('success path ingests outputs and merges results/s3_keys/thumbnail_keys into the status patch', async () => {
  mockGet.mockResolvedValueOnce({
    exists: true,
    data: () => ({ status: 'processing', user_id: 'u1', org_id: 'o1', type: 'upscale', credits: 7, created_at: '07/10/2026, 10:00:00', api_job_id: 'job_1' }),
  });
  mockIngestOutputs.mockResolvedValueOnce({
    results: [{ s3_key: 'tasks/o1/upscale/2026/07/10/u1/t/1.png', url_type: 'cloudfront', cloudfront_url: 'https://cdn/x' }],
    s3_keys: ['tasks/o1/upscale/2026/07/10/u1/t/1.png'],
    thumbnail_keys: ['tasks/o1/upscale/2026/07/10/u1/t/1.webp'],
  });
  const res = await handler(baseEvent({
    event: 'job.completed', job_id: 'job_1', tool: 'upscale', status: 'completed',
    outputs: ['https://x/y.png'], request_id: 'task_1',
  }));
  expect(res.statusCode).toBe(200);
  expect(mockIngestOutputs).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'task_1', outputs: ['https://x/y.png'] }));
});

test('failure path does NOT call ingestOutputs', async () => {
  mockGet.mockResolvedValueOnce({
    exists: true,
    data: () => ({ status: 'processing', user_id: 'u1', org_id: 'o1', type: 'upscale', credits: 7, api_job_id: 'job_1' }),
  });
  const res = await handler(baseEvent({
    event: 'job.failed', job_id: 'job_1', tool: 'upscale', status: 'failed',
    outputs: [], request_id: 'task_1',
  }));
  expect(res.statusCode).toBe(200);
  expect(mockIngestOutputs).not.toHaveBeenCalled();
});

test('B3: empty api_job_id returns 500 to retry the writeback race', async () => {
  mockGet.mockResolvedValueOnce({ exists: true, data: () => ({ status: 'processing', user_id: 'u1', org_id: 'o1', credits: 7 }) });
  const res = await handler(baseEvent({ event: 'job.completed', job_id: 'job_1', tool: 'upscale', status: 'completed', outputs: [], request_id: 'task_1' }));
  expect(res.statusCode).toBe(500);
  expect(mockDeductReserved).not.toHaveBeenCalled();
});

test('B3: payload.job_id != taskData.api_job_id is dropped (200) and settles nothing', async () => {
  mockGet.mockResolvedValueOnce({ exists: true, data: () => ({ status: 'processing', user_id: 'u1', org_id: 'o1', credits: 7, api_job_id: 'job_real' }) });
  const res = await handler(baseEvent({ event: 'job.completed', job_id: 'job_attacker', tool: 'upscale', status: 'completed', outputs: ['https://x/y.png'], request_id: 'task_1' }));
  expect(res.statusCode).toBe(200);
  expect(res.body).toContain('job_task_mismatch_ignored');
  expect(mockDeductReserved).not.toHaveBeenCalled();
  expect(mockUpdate).not.toHaveBeenCalled();
});

test('settle_amount used when present, credits used for tracking (both lanes)', async () => {
  mockGet.mockResolvedValueOnce({
    exists: true,
    data: () => ({ status: 'processing', user_id: 'u1', org_id: 'o1', type: 'upscale', credits: 7, settle_amount: 5, api_job_id: 'job_1' }),
  });
  const res = await handler(baseEvent({
    event: 'job.completed', job_id: 'job_1', tool: 'upscale', status: 'completed',
    outputs: ['https://x/y.png'], request_id: 'task_1',
  }));
  expect(res.statusCode).toBe(200);
  // Ledger: settle_amount=5
  expect(mockDeductReserved).toHaveBeenCalledWith({ taskId: 'task_1', orgId: 'o1', uid: 'u1', amount: 5, pool: 'credits' });
  // Tracking: credits=7 (passed via taskData to updateUserStats)
  expect(mockUpdateUserStats).toHaveBeenCalledWith({
    taskId: 'task_1',
    taskData: expect.objectContaining({ credits: 7, settle_amount: 5 }),
    imageCount: 0, // ingest not mocked → undefined → 0
  });
});

test('unlimited org: settle_amount=0, credits>0 → recordUsage + updateUserStats, no deductReserved', async () => {
  mockGet.mockResolvedValueOnce({
    exists: true,
    data: () => ({ status: 'processing', user_id: 'u1', org_id: 'o1', type: 'upscale', credits: 5, settle_amount: 0, api_job_id: 'job_1' }),
  });
  const res = await handler(baseEvent({
    event: 'job.completed', job_id: 'job_1', tool: 'upscale', status: 'completed',
    outputs: ['https://x/y.png'], request_id: 'task_1',
  }));
  expect(res.statusCode).toBe(200);
  expect(mockDeductReserved).not.toHaveBeenCalled();
  expect(mockRecordUsage).toHaveBeenCalledWith({ taskId: 'task_1', orgId: 'o1', uid: 'u1', amount: 5, pool: 'credits' });
  expect(mockUpdateUserStats).toHaveBeenCalled();
});

test('fallback: missing settle_amount uses credits for ledger amount', async () => {
  mockGet.mockResolvedValueOnce({
    exists: true,
    data: () => ({ status: 'processing', user_id: 'u1', org_id: 'o1', type: 'upscale', credits: 7, api_job_id: 'job_1' }),
  });
  const res = await handler(baseEvent({
    event: 'job.completed', job_id: 'job_1', tool: 'upscale', status: 'completed',
    outputs: [], request_id: 'task_1',
  }));
  expect(res.statusCode).toBe(200);
  expect(mockDeductReserved).toHaveBeenCalledWith({ taskId: 'task_1', orgId: 'o1', uid: 'u1', amount: 7, pool: 'credits' });
  expect(mockRecordUsage).not.toHaveBeenCalled();
});

test('updateUserStats failure does not fail the webhook response', async () => {
  mockUpdateUserStats.mockRejectedValueOnce(new Error('stats write failed'));
  mockGet.mockResolvedValueOnce({
    exists: true,
    data: () => ({ status: 'processing', user_id: 'u1', org_id: 'o1', type: 'upscale', credits: 7, api_job_id: 'job_1' }),
  });
  const res = await handler(baseEvent({
    event: 'job.completed', job_id: 'job_1', tool: 'upscale', status: 'completed',
    outputs: ['https://x/y.png'], request_id: 'task_1',
  }));
  expect(res.statusCode).toBe(200);
  expect(mockDeductReserved).toHaveBeenCalled();
});

test('failure path does NOT call updateUserStats', async () => {
  mockGet.mockResolvedValueOnce({
    exists: true,
    data: () => ({ status: 'processing', user_id: 'u1', org_id: 'o1', type: 'upscale', credits: 7, api_job_id: 'job_1' }),
  });
  const res = await handler(baseEvent({
    event: 'job.failed', job_id: 'job_1', tool: 'upscale', status: 'failed',
    outputs: [], request_id: 'task_1',
  }));
  expect(res.statusCode).toBe(200);
  expect(mockReleaseReserved).toHaveBeenCalledWith({ taskId: 'task_1', orgId: 'o1', amount: 7, pool: 'credits' });
  expect(mockUpdateUserStats).not.toHaveBeenCalled();
  expect(mockRecordUsage).not.toHaveBeenCalled();
});

test('workflow step success: settle_amount > 0 → deductReserved + updateUserStats', async () => {
  mockGet.mockResolvedValueOnce({
    exists: true,
    data: () => ({ status: 'processing', user_id: 'u1', org_id: 'o1', type: 'upscale', credits: 5, settle_amount: 5, workflow_run_id: 'wf_run_1', workflow_step_id: 'step_1', api_job_id: 'job_1' }),
  });
  const res = await handler(baseEvent({
    event: 'job.completed', job_id: 'job_1', tool: 'upscale', status: 'completed',
    outputs: ['https://x/y.png'], request_id: 'task_1',
  }));
  expect(res.statusCode).toBe(200);
  expect(mockDeductReserved).toHaveBeenCalledWith({ taskId: 'task_1', orgId: 'o1', uid: 'u1', amount: 5, pool: 'credits' });
  expect(mockRecordUsage).not.toHaveBeenCalled();
  expect(mockUpdateUserStats).toHaveBeenCalledWith({
    taskId: 'task_1',
    taskData: expect.objectContaining({ workflow_run_id: 'wf_run_1', workflow_step_id: 'step_1' }),
    imageCount: 0,
  });
});

test('workflow step failure: skips releaseReserved (workflow refund handles it)', async () => {
  mockGet.mockResolvedValueOnce({
    exists: true,
    data: () => ({ status: 'processing', user_id: 'u1', org_id: 'o1', type: 'upscale', credits: 5, settle_amount: 5, workflow_run_id: 'wf_run_1', api_job_id: 'job_1' }),
  });
  const res = await handler(baseEvent({
    event: 'job.failed', job_id: 'job_1', tool: 'upscale', status: 'failed',
    outputs: [], request_id: 'task_1',
  }));
  expect(res.statusCode).toBe(200);
  expect(mockReleaseReserved).not.toHaveBeenCalled();
  expect(mockDeductReserved).not.toHaveBeenCalled();
  expect(mockUpdateUserStats).not.toHaveBeenCalled();
});

test('cataloguing pool: credit_pool on the task routes settle to cataloguing_credits', async () => {
  mockGet.mockResolvedValueOnce({
    exists: true,
    data: () => ({ status: 'processing', user_id: 'u1', org_id: 'o1', type: 'cataloguing', credits: 120, settle_amount: 120, credit_pool: 'cataloguing_credits', api_job_id: 'job_1' }),
  });
  const res = await handler(baseEvent({
    event: 'job.completed', job_id: 'job_1', tool: 'cataloguing', status: 'completed',
    outputs: ['https://x/drape.png'], request_id: 'task_1',
  }));
  expect(res.statusCode).toBe(200);
  expect(mockDeductReserved).toHaveBeenCalledWith({ taskId: 'task_1', orgId: 'o1', uid: 'u1', amount: 120, pool: 'cataloguing_credits' });
});

test('item_errors on a completed job are surfaced to writeTerminalStatus (partial success)', async () => {
  mockGet.mockResolvedValueOnce({
    exists: true,
    data: () => ({ status: 'processing', user_id: 'u1', org_id: 'o1', type: 'cataloguing', credits: 120, settle_amount: 120, credit_pool: 'cataloguing_credits', api_job_id: 'job_1' }),
  });
  const res = await handler(baseEvent({
    event: 'job.completed', job_id: 'job_1', tool: 'cataloguing', status: 'completed',
    outputs: [{ type: 'png', url: 'https://x/drape.png', meta: { kind: 'drape' } }],
    item_errors: [{ kind: 'drape', design_index: 1, color: 'teal', error: 'provider returned no image' }],
    request_id: 'task_1',
  }));
  expect(res.statusCode).toBe(200);
  // item_errors forwarded to writeTerminalStatus so it lands on tasks/{taskId}.
  expect(mockWriteTerminalStatus).toHaveBeenCalledWith(expect.objectContaining({
    payload: expect.objectContaining({
      item_errors: [{ kind: 'drape', design_index: 1, color: 'teal', error: 'provider returned no image' }],
    }),
  }));
  // Still settles the full reserved amount (partial-success billing policy).
  expect(mockDeductReserved).toHaveBeenCalledWith({ taskId: 'task_1', orgId: 'o1', uid: 'u1', amount: 120, pool: 'cataloguing_credits' });
});
