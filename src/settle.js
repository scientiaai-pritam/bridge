import { firestore, rtdb } from './firebase.js';
import { FieldValue } from 'firebase-admin/firestore';

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

// --- Phase 2: transactional credit settle -------------------------------
// JS reimplementation of firebase_utils.py:931-1121 but TRANSACTIONAL
// (the Python version is non-transactional read-then-write — known issue;
// this version uses runTransaction over up to 3 docs). Idempotent via the
// credits_settled flag on tasks/{taskId}, so a reconcile re-run can never
// double-deduct.

async function mirrorOrgCredits(orgId) {
  try {
    const snap = await firestore().doc(`orgs/${orgId}`).get();
    if (!snap.exists) return;
    const d = snap.data() || {};
    await rtdb().ref(`orgCredits/${orgId}`).update({
      credits: d.credits || 0,
      reserved_credits: d.reserved_credits || 0,
      available_credits: (d.credits || 0) - (d.reserved_credits || 0),
    });
  } catch (e) {
    console.error('[bridge] RTDB orgCredits mirror failed (non-fatal):', e);
  }
}

async function mirrorCreditLimits(orgId, uid) {
  if (!uid) return;
  try {
    const uSnap = await firestore().doc(`org_users/${uid}`).get();
    if (!uSnap.exists) return;
    const used = uSnap.data()?.credits_used || 0;
    const oSnap = await firestore().doc(`orgs/${orgId}`).get();
    const orgCredits = oSnap.exists ? (oSnap.data()?.credits || 0) : 0;
    await rtdb().ref(`creditLimits/${orgId}/${uid}`).update({
      creditsUsed: used,
      lastUpdated: new Date().toISOString(),
    });
    await rtdb().ref(`creditLimits/${orgId}/_orgCredits`).set(orgCredits);
  } catch (e) {
    console.error('[bridge] RTDB creditLimits mirror failed (non-fatal):', e);
  }
}

/**
 * Transactionally deduct a previously-reserved amount on success.
 * Field math on orgs/{orgId}: credits -= amt, reserved_credits -= amt, credits_used += amt.
 * Also org_users/{uid}.credits_used += amt (per-user limit accounting — I2).
 * Marks tasks/{taskId}.credits_settled = true (idempotency marker).
 */
export async function deductReserved({ taskId, orgId, uid, amount }) {
  const amt = Math.max(0, Math.trunc(Number(amount) || 0));
  if (amt === 0) return;
  const orgRef = firestore().doc(`orgs/${orgId}`);
  const taskRef = taskId ? firestore().doc(`tasks/${taskId}`) : null;
  const userRef = uid ? firestore().doc(`org_users/${uid}`) : null;

  let touched = false;
  await firestore().runTransaction(async (txn) => {
    if (taskRef) {
      const tSnap = await txn.get(taskRef);
      if (tSnap.exists && tSnap.data()?.credits_settled === true) {
        return; // idempotent: already settled
      }
    }
    const snap = await txn.get(orgRef);
    if (!snap.exists) {
      throw new Error(`deductReserved: org ${orgId} not found`);
    }
    const d = snap.data() || {};
    const reserved = d.reserved_credits || 0;
    if (reserved < amt) {
      throw new Error(`deductReserved: reserved_credits insufficient (reserved=${reserved}, required=${amt})`);
    }
    txn.update(orgRef, {
      credits: FieldValue.increment(-amt),
      reserved_credits: FieldValue.increment(-amt),
      credits_used: FieldValue.increment(amt),
    });
    if (userRef) {
      txn.update(userRef, { credits_used: FieldValue.increment(amt) });
    }
    if (taskRef) {
      txn.update(taskRef, {
        credits_settled: true,
        credits_settled_amount: amt,
        settled_at: new Date().toISOString(),
      });
    }
    touched = true;
  });

  if (touched) {
    await Promise.all([mirrorOrgCredits(orgId), mirrorCreditLimits(orgId, uid)]);
  }
}

/**
 * Transactionally release a reservation on failure.
 * orgs/{orgId}.reserved_credits -= amt (clamped at 0). Marks tasks/{taskId}.credits_settled = true.
 */
export async function releaseReserved({ taskId, orgId, amount }) {
  const requested = Math.max(0, Math.trunc(Number(amount) || 0));
  if (requested === 0) return;
  const orgRef = firestore().doc(`orgs/${orgId}`);
  const taskRef = taskId ? firestore().doc(`tasks/${taskId}`) : null;

  let touched = false;
  await firestore().runTransaction(async (txn) => {
    if (taskRef) {
      const tSnap = await txn.get(taskRef);
      if (tSnap.exists && tSnap.data()?.credits_settled === true) {
        return; // idempotent
      }
    }
    const snap = await txn.get(orgRef);
    if (!snap.exists) return;
    const reserved = snap.data()?.reserved_credits || 0;
    const toRelease = Math.min(requested, reserved); // clamp
    if (toRelease > 0) {
      txn.update(orgRef, { reserved_credits: FieldValue.increment(-toRelease) });
    }
    if (taskRef) {
      txn.update(taskRef, {
        credits_settled: true,
        credits_settled_amount: 0,
        settled_at: new Date().toISOString(),
      });
    }
    touched = true;
  });

  if (touched) await mirrorOrgCredits(orgId);
}
