import { verifyWebhook } from './signing.js';
import { firestore } from './firebase.js';
import { writeTerminalStatus, TERMINAL, deductReserved, releaseReserved } from './settle.js';

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
    console.error('[bridge] firestore read failed (transient):', taskId, e);
    return FAIL(500, '{"error":"firestore_read"}'); // retry
  }

  if (!snap.exists) return FAIL(500, '{"error":"task_not_found"}'); // retry — race with submit

  const taskData = snap.data() || {};
  if (TERMINAL.has(taskData.status)) return OK('{"ok":"already_terminal"}'); // idempotency

  const ok = payload.event === 'job.completed';
  const orgId = taskData.org_id;
  const userId = taskData.user_id;
  const amount = Math.max(0, Math.trunc(Number(taskData.credits) || 0));

  try {
    await writeTerminalStatus({ taskId, payload, taskData });
  } catch (e) {
    console.error('[bridge] write failed (transient):', e);
    return FAIL(500, '{"error":"write_failed"}'); // retry
  }

  // Settle AFTER writeTerminalStatus. Layer-1 idempotency: the terminal-status
  // gate above (TERMINAL.has(taskData.status) → 200 + exit) prevents a retried
  // webhook from reaching here. Layer-2 idempotency: deductReserved/releaseReserved
  // each no-op when tasks/{taskId}.credits_settled === true, so the reconcile
  // safety net (Task 6) can re-run them without double-deduct.
  if (orgId && amount > 0) {
    try {
      if (ok) {
        await deductReserved({ taskId, orgId, uid: userId, amount });
      } else {
        await releaseReserved({ taskId, orgId, amount });
      }
    } catch (e) {
      // Status is already terminal in Firestore; a bridge retry would hit the
      // terminal gate and settle nothing, so returning non-2xx won't help. Log,
      // accept, and let reconcile (Task 6) heal the leaked reservation.
      console.error('[bridge] credit settle failed (status already terminal; reconcile will heal):', e);
    }
  }
  return OK();
}
