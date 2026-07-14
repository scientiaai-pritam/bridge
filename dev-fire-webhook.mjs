// DEV-ONLY webhook faker. Replaces the API tier's Replicate run + WebhookFn
// delivery for local e2e. NOT committed/packaged — local testing only.
//
// Builds the exact payload shape the API tier's WebhookFn sends
// ({event, job_id, tool, status, outputs, request_id}), signs it with the SAME
// HMAC scheme (reusing src/signing.js signForTest, which mirrors sign_outbound),
// and POSTs it to the local bridge. The bridge's REAL signature verification
// runs against it — so this exercises the true verify+ingest+settle path.
//
// Usage (from bridge/):
//   node --env-file=.env dev-fire-webhook.mjs <taskId> [--event completed|failed] \
//        [--output https://...] [--tool upscale] [--bridge http://localhost:9001]
//
// Requires WEBHOOK_SIGNING_SECRET in env (same value the bridge uses).
// Default --output is a small public sample image the bridge can fetch+upload.

import { signForTest } from './src/signing.js';

const SECRET = process.env.WEBHOOK_SIGNING_SECRET;
if (!SECRET) {
  console.error('ERROR: WEBHOOK_SIGNING_SECRET is not set. Put it in bridge/.env (same value the bridge uses).');
  process.exit(1);
}

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

const taskId = process.argv[2];
if (!taskId) {
  console.error('Usage: node dev-fire-webhook.mjs <taskId> [--event completed|failed] [--output URL] [--tool upscale] [--bridge http://localhost:9001]');
  process.exit(1);
}

const event    = arg('event', 'completed');
const tool     = arg('tool', 'upscale');
const bridge   = arg('bridge', 'http://localhost:9001');
const jobId    = arg('job-id', `job_fake_${Date.now()}`);
const output   = arg('output', 'https://www.gstatic.com/webp/gallery/1.png'); // small public sample

const ok = event === 'job.completed' || event === 'completed';
const payload = {
  event: ok ? 'job.completed' : 'job.failed',
  job_id: jobId,
  tool,
  status: ok ? 'completed' : 'failed',
  outputs: ok ? [output] : [],
  request_id: taskId,
};
const body = JSON.stringify(payload);
const ts = Math.floor(Date.now() / 1000);
const signature = signForTest(body, SECRET, ts); // t=<ts>,v1=<hmac>

console.log('[fire-webhook] POST', `${bridge}/`);
console.log('[fire-webhook] payload:', body);
console.log('[fire-webhook] x-tdai-signature:', signature);

const res = await fetch(`${bridge}/`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-tdai-signature': signature },
  body,
});

const text = await res.text();
console.log(`[fire-webhook] <- ${res.statusCode} ${text}`);
if (res.statusCode !== 200) process.exit(2);
