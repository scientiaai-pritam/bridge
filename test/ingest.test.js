import { jest } from '@jest/globals';

const mockUploadBytes = jest.fn().mockResolvedValue(undefined);
const mockPresignGet = jest.fn().mockResolvedValue('https://s3.mock/key?signed=1');
jest.unstable_mockModule('../src/s3.js', () => ({
  uploadBytes: mockUploadBytes,
  presignGet: mockPresignGet,
  cloudfrontUrlFor: (key) => `https://cdn.mock/${key}`,
  bucket: () => 'web-bucket',
}));

// Mock global fetch for the signed-URL download.
const mockFetch = jest.fn();
global.fetch = mockFetch;

const { ingestOutputs } = await import('../src/ingest.js');

beforeEach(() => jest.clearAllMocks());

test('downloads each output, uploads to the legacy key pattern, returns results/s3_keys/thumbnail_keys', async () => {
  mockFetch.mockResolvedValue({ ok: true, headers: { get: () => 'image/png' }, arrayBuffer: () => new ArrayBuffer(4) });
  const out = await ingestOutputs({
    taskId: 'task_1',
    taskData: { org_id: 'o1', user_id: 'u1', type: 'upscale' },
    outputs: ['https://api/outputs/job_1.png?sig=1'],
  });
  expect(mockUploadBytes).toHaveBeenCalledTimes(1);
  const [bucket, key, _body, ct] = mockUploadBytes.mock.calls[0];
  expect(bucket).toBe('web-bucket');
  expect(ct).toBe('image/png');
  expect(key).toMatch(/^tasks\/o1\/upscale\/\d{4}\/\d{2}\/\d{2}\/u1\/task_1\/1\.png$/);
  expect(out.s3_keys).toEqual([key]);
  expect(out.thumbnail_keys).toEqual([key.replace(/\.png$/, '.webp')]);
  expect(out.results[0]).toMatchObject({ s3_key: key, url_type: 'cloudfront' });
  expect(out.results[0].cloudfront_url).toBe(`https://cdn.mock/${key}`);
});

test('derives ext from content-type when URL has none', async () => {
  mockFetch.mockResolvedValue({ ok: true, headers: { get: () => 'image/webp' }, arrayBuffer: () => new ArrayBuffer(4) });
  const out = await ingestOutputs({
    taskId: 'task_2', taskData: { org_id: 'o1', user_id: 'u1', type: 'upscale' },
    outputs: ['https://api/outputs/noext'], // no extension
  });
  expect(out.s3_keys[0]).toMatch(/\.webp$/);
});

test('throws on a failed download (non-2xx) so the bridge returns non-2xx → retry', async () => {
  mockFetch.mockResolvedValue({ ok: false, status: 403, headers: { get: () => null }, arrayBuffer: () => new ArrayBuffer(0) });
  await expect(ingestOutputs({
    taskId: 'task_3', taskData: { org_id: 'o1', user_id: 'u1', type: 'upscale' }, outputs: ['https://api/x'],
  })).rejects.toThrow(/download failed/i);
  expect(mockUploadBytes).not.toHaveBeenCalled();
});

test('indexes outputs 1..n in filename order', async () => {
  mockFetch.mockResolvedValue({ ok: true, headers: { get: () => 'image/png' }, arrayBuffer: () => new ArrayBuffer(4) });
  const out = await ingestOutputs({
    taskId: 'task_4', taskData: { org_id: 'o1', user_id: 'u1', type: 'upscale' },
    outputs: ['https://a', 'https://b'],
  });
  expect(out.s3_keys[0]).toMatch(/\/1\.png$/);
  expect(out.s3_keys[1]).toMatch(/\/2\.png$/);
});
