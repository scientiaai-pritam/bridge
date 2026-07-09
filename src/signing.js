import crypto from 'node:crypto';

const TOLERANCE_SECONDS = 300;

/** Constant-time HMAC verify mirroring designer-ai-api-tier src/common/signing.py verify_outbound. */
export function verifyWebhook(rawBody, signatureHeader, secret, nowMs) {
  if (!signatureHeader || typeof signatureHeader !== 'string') return false;
  let ts, sig;
  try {
    const parts = Object.fromEntries(
      signatureHeader.split(',').map((p) => p.split('=', 2))
    );
    ts = Number.parseInt(parts.t, 10);
    sig = parts.v1;
  } catch {
    return false;
  }
  if (!Number.isFinite(ts) || !sig) return false;
  if (Math.abs(Math.floor(nowMs / 1000) - ts) > TOLERANCE_SECONDS) return false;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${ts}.${rawBody}`)
    .digest('hex');
  // timingSafeEqual requires equal-length buffers
  const a = Buffer.from(expected);
  const b = Buffer.from(String(sig));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** Test-only signer mirroring sign_outbound. NOT used at runtime. */
export function signForTest(body, secret, ts) {
  const digest = crypto
    .createHmac('sha256', secret)
    .update(`${ts}.${body}`)
    .digest('hex');
  return `t=${ts},v1=${digest}`;
}
