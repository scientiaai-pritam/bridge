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
  mockGet.mockResolvedValueOnce({ exists: true, data: () => ({ status: 'processing', user_id: 'u1', org_id: 'o1', type: 'upscale', credits: 5 }) });
  const res = await handler(baseEvent({ event: 'job.completed', job_id: 'job_1', tool: 'upscale', status: 'completed', outputs: ['https://x/y.png'], request_id: 'task_1' }));
  expect(res.statusCode).toBe(200);
  expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' }));
  expect(mockRtdbUpdate).toHaveBeenCalled();
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
