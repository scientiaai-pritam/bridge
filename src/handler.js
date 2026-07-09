import { verifyWebhook } from './signing.js';
import { firestore } from './firebase.js';
import { writeTerminalStatus, TERMINAL } from './settle.js';

const SECRET = () => process.env.WEBHOOK_SIGNING_SECRET;
const OK = (body = '{}') => ({ statusCode: 200, body });
const FAIL = (code, body) => ({ statusCode: code, body });

export async function handler(event) {
  const rawBody = typeof event.body === 'string' ? event.body : JSON.stringify(event.body || {});
  const header = event.headers?.['x-tdai-signature'] || event.headers?.['X-TDAI-Signature'] || '';
  const nowMs = event.requestContext?.timeEpoch || Date.now();

  if (!verifyWebhook(rawBody, header, SECRET(), nowMs)) return FAIL(401, '{"error":"bad_signature"}');

  let payload;
  try { payload = JSON.parse(rawBody); } catch { return FAIL(400, '{"error":"bad_json"}'); }

  const taskId = payload.request_id;
  if (!taskId) return FAIL(400, '{"error":"no_request_id"}');

  let snap;
  try {
    snap = await firestore().doc(`tasks/${taskId}`).get();
  } catch (e) {
    console.error('[bridge] firestore read failed (transient):', e);
    return FAIL(500, '{"error":"firestore_read"}'); // retry
  }

  if (!snap.exists) return FAIL(500, '{"error":"task_not_found"}'); // retry — race with submit

  const taskData = snap.data() || {};
  if (TERMINAL.has(taskData.status)) return OK('{"ok":"already_terminal"}'); // idempotency

  try {
    await writeTerminalStatus({ taskId, payload, taskData });
  } catch (e) {
    console.error('[bridge] write failed (transient):', e);
    return FAIL(500, '{"error":"write_failed"}'); // retry
  }
  return OK();
}
