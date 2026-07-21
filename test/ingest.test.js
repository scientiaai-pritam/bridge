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

test('downloads each output, uploads under the tool-and-input-wise key, returns results/s3_keys/thumbnail_keys', async () => {
  mockFetch.mockResolvedValue({ ok: true, headers: { get: () => 'image/png' }, arrayBuffer: () => new ArrayBuffer(4) });
  const out = await ingestOutputs({
    taskId: 'task_1',
    taskData: {
      org_id: 'o1', user_id: 'u1', type: 'upscale',
      ref_image: 'https://s3/inputs/mydesign.png',
      extra_params: { scale_factor: 4, creativity: 35 },
    },
    outputs: ['https://api/outputs/job_1.png?sig=1'],
  });
  expect(mockUploadBytes).toHaveBeenCalledTimes(1);
  const [bucket, key, _body, ct] = mockUploadBytes.mock.calls[0];
  expect(bucket).toBe('web-bucket');
  expect(ct).toBe('image/png');
  expect(key).toMatch(/^tasks\/o1\/upscale\/\d{4}\/\d{2}\/\d{2}\/u1\/task_1\/mydesign_rtp_4_35\.png$/);
  expect(out.s3_keys).toEqual([key]);
  expect(out.thumbnail_keys).toEqual([key.replace(/\.png$/, '.webp')]);
  expect(out.results[0]).toMatchObject({ s3_key: key, url_type: 'cloudfront' });
  expect(out.results[0].cloudfront_url).toBe(`https://cdn.mock/${key}`);
});

test('derives ext from content-type when URL has none', async () => {
  mockFetch.mockResolvedValue({ ok: true, headers: { get: () => 'image/webp' }, arrayBuffer: () => new ArrayBuffer(4) });
  const out = await ingestOutputs({
    taskId: 'task_2', taskData: { org_id: 'o1', user_id: 'u1', type: 'bg_remove', ref_image: 'https://s3/in/x.png' },
    outputs: ['https://api/outputs/noext'], // no extension
  });
  expect(out.s3_keys[0]).toMatch(/x_bg_removed\.webp$/);
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
    taskId: 'task_4', taskData: { org_id: 'o1', user_id: 'u1', type: 'object_layering', ref_image: 'https://s3/in/d.png' },
    outputs: ['https://a', 'https://b'],
  });
  expect(out.s3_keys[0]).toMatch(/d_layered_1\.png$/);
  expect(out.s3_keys[1]).toMatch(/d_layered_2\.png$/);
});

// --- §15 documented completed-cataloguing response ------------------------
// Mirrors the example in docs/ScientiaAI-Internal-API-Guide.docx §15: a completed
// cataloguing job with 2 drapes (1 colour variation), a walk video, a storyboard,
// and a zip bundle. Each output carries the documented `meta`. Verifies the bridge
// produces unique S3 keys, threads meta onto results, synthesizes the legacy UI
// field names (draped_url / video_url / storyboard_url / zip_url), and records null
// thumbnails for the non-image kinds (video, bundle).
test('§15 cataloguing multi-output: unique keys, meta threaded, legacy fields synthesized, null thumbs for video/zip', async () => {
  // Per-output content-type so extFor picks png / mp4 / zip honestly.
  mockFetch.mockImplementation(async (url) => {
    if (url.includes('video')) return { ok: true, headers: { get: () => 'video/mp4' }, arrayBuffer: () => new ArrayBuffer(4) };
    if (url.includes('bundle')) return { ok: true, headers: { get: () => 'application/zip' }, arrayBuffer: () => new ArrayBuffer(4) };
    return { ok: true, headers: { get: () => 'image/png' }, arrayBuffer: () => new ArrayBuffer(4) };
  });
  const out = await ingestOutputs({
    taskId: 'task_cat', taskData: { org_id: 'o1', user_id: 'u1', type: 'cataloguing', extra_params: {} },
    outputs: [
      { type: 'png', url: 'https://api/outputs/drape0.png?sig',  meta: { kind: 'drape',      design_url: 'https://example.com/print-a.png', color: 'original', design_index: 0, model_index: 0, color_index: 0 } },
      { type: 'png', url: 'https://api/outputs/drape1.png?sig',  meta: { kind: 'drape',      design_url: 'https://example.com/print-a.png', color: 'maroon',   design_index: 0, model_index: 0, color_index: 1 } },
      { type: 'mp4', url: 'https://api/outputs/video0.mp4?sig',  meta: { kind: 'video',      video_index: 0, design_index: 0, model_index: 0, color: 'original' } },
      { type: 'png', url: 'https://api/outputs/sb0.png?sig',     meta: { kind: 'storyboard', storyboard_index: 0, storyboard_prompt: 'A model walks...', design_index: 0, model_index: 0 } },
      { type: 'zip', url: 'https://api/outputs/bundle.zip?sig',  meta: { kind: 'bundle' } },
    ],
  });

  // 1) Every key is unique (no collision) and carries the right extension per kind.
  //    Drapes carry design_url in meta (§15) so they get the design name as base;
  //    video/storyboard/bundle meta do NOT carry a source URL, so they fall back to
  //    an index-based base — still unique and kind-labeled.
  expect(new Set(out.s3_keys).size).toBe(out.s3_keys.length);
  expect(out.s3_keys[0]).toMatch(/print-a_drape_1\.png$/);
  expect(out.s3_keys[1]).toMatch(/print-a_drape_2\.png$/);
  expect(out.s3_keys[2]).toMatch(/_video_3\.mp4$/);
  expect(out.s3_keys[3]).toMatch(/_storyboard_4\.png$/);
  expect(out.s3_keys[4]).toMatch(/_bundle\.zip$/);

  // 2) meta is threaded onto each result entry.
  expect(out.results[0].meta).toMatchObject({ kind: 'drape', color: 'original' });
  expect(out.results[2].meta).toMatchObject({ kind: 'video', video_index: 0 });

  // 3) Legacy UI field names are synthesized on the right entries (so DownloadStep /
  //    ExtrasVideo / pdfUtils read them without a rewrite).
  expect(out.results[0].draped_url).toBeDefined();
  expect(out.results[2].video_url).toBeDefined();
  expect(out.results[3].storyboard_url).toBeDefined();
  expect(out.results[4].zip_url).toBeDefined();

  // 4) Non-image kinds get a null thumbnail (no bogus .webp); images get a .webp thumb.
  expect(out.thumbnail_keys[0]).toMatch(/print-a_drape_1\.webp$/);
  expect(out.thumbnail_keys[2]).toBeNull(); // video
  expect(out.thumbnail_keys[4]).toBeNull(); // zip bundle
});

test('§15 product_photoshoot scenes + bundle: unique keys, scene_url + zip_url synthesized', async () => {
  mockFetch.mockImplementation(async (url) => {
    if (url.includes('bundle')) return { ok: true, headers: { get: () => 'application/zip' }, arrayBuffer: () => new ArrayBuffer(4) };
    return { ok: true, headers: { get: () => 'image/png' }, arrayBuffer: () => new ArrayBuffer(4) };
  });
  const out = await ingestOutputs({
    taskId: 'task_ps', taskData: { org_id: 'o1', user_id: 'u1', type: 'product_photoshoot', extra_params: {} },
    outputs: [
      { type: 'png', url: 'https://api/outputs/scene0.png?sig', meta: { kind: 'scene', product_image_url: 'https://example.com/cushion.png', scene_index: 0, background_description: 'sofa' } },
      { type: 'png', url: 'https://api/outputs/scene1.png?sig', meta: { kind: 'scene', product_image_url: 'https://example.com/cushion.png', scene_index: 1, background_description: 'plinth' } },
      { type: 'zip', url: 'https://api/outputs/bundle.zip?sig', meta: { kind: 'bundle' } },
    ],
  });
  expect(new Set(out.s3_keys).size).toBe(out.s3_keys.length);
  expect(out.s3_keys[0]).toMatch(/cushion_scene_1\.png$/);
  expect(out.s3_keys[1]).toMatch(/cushion_scene_2\.png$/);
  // bundle meta has no product_image_url → index-based base, still unique + kind-labeled.
  expect(out.s3_keys[2]).toMatch(/_bundle\.zip$/);
  expect(out.results[0].scene_url).toBeDefined();
  expect(out.results[2].zip_url).toBeDefined();
  expect(out.thumbnail_keys[2]).toBeNull();
});
