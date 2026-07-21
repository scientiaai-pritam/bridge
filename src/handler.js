import { verifyWebhook } from './signing.js';
import { firestore } from './firebase.js';
import { writeTerminalStatus, TERMINAL, deductReserved, releaseReserved, recordUsage, updateUserStats } from './settle.js';
import { ingestOutputs } from './ingest.js';

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

  // B3: retry on empty api_job_id (writeback race); drop+log on job_id mismatch (replay/forge).
  if (!taskData.api_job_id) return FAIL(500, '{"error":"api_job_id_pending"}');
  if (payload.job_id !== taskData.api_job_id) {
    console.warn(`[bridge] job/task mismatch ${payload.job_id} != ${taskData.api_job_id} for tasks/${taskId}`);
    return OK('{"ok":"job_task_mismatch_ignored"}');
  }

  const ok = payload.event === 'job.completed';
  const orgId = taskData.org_id;
  const userId = taskData.user_id;
  // Which credit ledger to settle against. Pipeline tools (cataloguing,
  // product_photoshoot) may bill cataloguing_credits; everything else bills AI credits.
  // Primary source: credit_pool (set by submit-api-tier for every task since the field was
  // introduced). Fallback: extra_params.credit_type for tasks created during the transition
  // window before credit_pool was written to the doc (mirrors the SQS worker's pool selection).
  // Default: AI credits.
  const pool = (taskData.credit_pool === 'cataloguing_credits'
    || taskData.extra_params?.credit_type === 'cataloguing_credits')
    ? 'cataloguing_credits' : 'credits';
  // settle_amount is the authoritative ledger amount (0 for unlimited orgs — nothing
  // was reserved). credits is the catalog cost, used for tracking (credit_history, user_stats).
  // Fall back to credits for tasks created before settle_amount was introduced.
  const settleAmount = Math.max(0, Math.trunc(Number(taskData.settle_amount ?? taskData.credits) || 0));
  const trackingAmount = Math.max(0, Math.trunc(Number(taskData.credits) || 0));

  // Phase 3: ingest outputs BEFORE writeTerminalStatus so a crash during ingest
  // leaves the task non-terminal (→ webhook retries). S3 PutObject is idempotent,
  // so a retry re-uploads safely. On failure (job.failed), skip ingest entirely.
  let ingest = null;
  if (ok && Array.isArray(payload.outputs) && payload.outputs.length) {
    try {
      ingest = await ingestOutputs({ taskId, taskData, outputs: payload.outputs });
    } catch (e) {
      console.error('[bridge] ingest failed (transient):', taskId, e);
      return FAIL(500, '{"error":"ingest_failed"}'); // retry — outputs not yet copied
    }
  }

  try {
    await writeTerminalStatus({ taskId, payload, taskData, ingest });
  } catch (e) {
    console.error('[bridge] write failed (transient):', taskId, e);
    return FAIL(500, '{"error":"write_failed"}'); // retry
  }

  // Settle AFTER writeTerminalStatus. Layer-1 idempotency: the terminal-status
  // gate above (TERMINAL.has(taskData.status) → 200 + exit) prevents a retried
  // webhook from reaching here. Layer-2 idempotency: deductReserved/releaseReserved
  // each no-op when tasks/{taskId}.credits_settled === true, so the reconcile
  // safety net (Task 6) can re-run them without double-deduct.
  if (orgId && (settleAmount > 0 || trackingAmount > 0)) {
    try {
      if (ok) {
        if (settleAmount > 0) {
          // Normal org: deduct from the reservation made at submit.
          // credit_history is written inside the transaction.
          await deductReserved({ taskId, orgId, uid: userId, amount: settleAmount, pool });
        } else if (trackingAmount > 0) {
          // Unlimited org: nothing was reserved, but track usage (credit_history + credits_used).
          await recordUsage({ taskId, orgId, uid: userId, amount: trackingAmount, pool });
        }
        // user_stats counters for every successful non-zero-cost task (both lanes above).
        if (trackingAmount > 0) {
          const imageCount = ingest ? (ingest.results ? ingest.results.length : 0) : 0;
          try {
            await updateUserStats({ taskId, taskData, imageCount });
          } catch (e) {
            console.error('[bridge] user_stats update failed (non-fatal):', e);
          }
        }
      } else {
        // Workflow steps skip releaseReserved — the workflow refund handles unused credits.
        if (!taskData.workflow_run_id) {
          await releaseReserved({ taskId, orgId, amount: settleAmount, pool });
        }
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
