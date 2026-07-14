// DEV-ONLY local HTTP wrapper around the bridge Lambda handler.
// NOT part of the SAM/packaged Lambda — local e2e only.
//
// Run (Node 20.6+ loads .env automatically):
//   node --env-file=.env dev-server.mjs
// (or: node dev-server.mjs  with the env vars already exported)
//
// Listens on PORT (default 9001). The API tier's WebhookFn POSTs the signed
// payload here; we map the raw request into the Function-URL event shape the
// handler expects and return { statusCode, body }.
//
// IMPORTANT: the HMAC is computed over the EXACT raw body, so we pass the raw
// bytes through verbatim (no re-serialization).

import http from 'node:http';
import { handler } from './src/handler.js';

const PORT = Number(process.env.PORT) || 9001;

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({
      ok: true,
      WEBHOOK_SIGNING_SECRET_set: Boolean(process.env.WEBHOOK_SIGNING_SECRET),
      FIREBASE_PROJECT_ID_set: Boolean(process.env.FIREBASE_PROJECT_ID),
      FIREBASE_DATABASE_URL_set: Boolean(process.env.FIREBASE_DATABASE_URL),
      AWS_S3_BUCKET_set: Boolean(process.env.AWS_S3_BUCKET || process.env.STORAGE_BUCKET_NAME),
    }));
  }

  // Collect the raw body exactly as received.
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const rawBody = Buffer.concat(chunks).toString('utf8');

  // Function URL / API Gateway normalize header keys to lowercase.
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = v;

  const event = {
    body: rawBody,
    headers,
    requestContext: { timeEpoch: Date.now() },
  };

  try {
    const out = await handler(event);
    res.writeHead(out.statusCode || 200, { 'content-type': 'application/json' });
    res.end(out.body || '{}');
  } catch (e) {
    console.error('[dev-server] handler threw:', e);
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'handler_exception', message: e.message }));
  }
});

server.listen(PORT, () => {
  console.log(`[dev-server] bridge listening on http://localhost:${PORT}`);
  console.log(`[dev-server] health:  http://localhost:${PORT}/health`);
  console.log(`[dev-server] webhook: POST http://localhost:${PORT}/  (from API tier WebhookFn)`);
});
