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
jest.unstable_mockModule('../src/settle.js', () => ({
  writeTerminalStatus: jest.fn(async ({ payload }) => ({
    status: payload.event === 'job.completed' ? 'completed' : 'failed',
  })),
  TERMINAL: new Set(['completed', 'failed']),
  deductReserved: mockDeductReserved,
  releaseReserved: mockReleaseReserved,
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

test('success path calls deductReserved({taskId, orgId, uid, amount=taskData.credits}) after status write', async () => {
  mockGet.mockResolvedValueOnce({
    exists: true,
    data: () => ({ status: 'processing', user_id: 'u1', org_id: 'o1', type: 'upscale', credits: 7, api_job_id: 'job_1' }),
  });
  const res = await handler(baseEvent({
    event: 'job.completed', job_id: 'job_1', tool: 'upscale', status: 'completed',
    outputs: ['https://x/y.png'], request_id: 'task_1',
  }));
  expect(res.statusCode).toBe(200);
  expect(mockDeductReserved).toHaveBeenCalledWith({ taskId: 'task_1', orgId: 'o1', uid: 'u1', amount: 7 });
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
  expect(mockReleaseReserved).toHaveBeenCalledWith({ taskId: 'task_1', orgId: 'o1', amount: 7 });
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
