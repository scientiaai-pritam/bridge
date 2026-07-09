import { firestore, rtdb } from './firebase.js';

const KOLKATA = 'Asia/Kolkata';
const nowStr = () => new Date().toLocaleString('en-US', { timeZone: KOLKATA });

/**
 * Phase 1 terminal-status writer. Writes Firestore tasks/{taskId} + RTDB tasks/{userId}.
 * Phase 2 adds credit settle; Phase 3 adds s3_keys ingest. Returns the task data read.
 */
export async function writeTerminalStatus({ taskId, payload, taskData }) {
  const userId = taskData.user_id;
  const ok = payload.event === 'job.completed';

  const firestorePatch = {
    status: ok ? 'completed' : 'failed',
    api_job_id: payload.job_id,
    updated_at: nowStr(),
    ...(ok ? { completed_at: nowStr() } : { failed_at: nowStr() }),
    ...(ok ? {} : { error_message: `API-tier job ${payload.job_id} failed` }),
  };

  await firestore().doc(`tasks/${taskId}`).update(firestorePatch);

  if (userId) {
    const rtdbPatch = { status: firestorePatch.status, updated_at: nowStr() };
    if (ok) rtdbPatch.completed_at = nowStr(); else rtdbPatch.failed_at = nowStr();
    try {
      await rtdb().ref(`tasks/${userId}`).update(rtdbPatch);
    } catch (e) {
      console.error('[bridge] RTDB mirror failed (non-fatal):', e);
    }
  }
  return firestorePatch;
}

export const TERMINAL = new Set(['completed', 'failed']);
