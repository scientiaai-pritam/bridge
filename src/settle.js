import { firestore, rtdb } from './firebase.js';
import { FieldValue } from 'firebase-admin/firestore';
import { poolFields } from './pool-fields.js';

const KOLKATA = 'Asia/Kolkata';
const nowStr = () => new Date().toLocaleString('en-US', { timeZone: KOLKATA });

/**
 * Phase 1 terminal-status writer. Writes Firestore tasks/{taskId} + RTDB tasks/{userId}.
 * Phase 2 adds credit settle; Phase 3 adds s3_keys ingest. Returns the task data read.
 *
 * Phase 3: on success, merges `ingest` ({results, s3_keys, thumbnail_keys}) plus
 * `completed_at` and best-effort duration fields into the Firestore patch. The
 * `ingest` argument is null/absent on failure and on Phase-2 callers that don't
 * pass it — the success branch then omits the output arrays (backward compatible).
 */
export async function writeTerminalStatus({ taskId, payload, taskData, ingest = null }) {
  const ok = payload.event === 'job.completed';

  const completedAt = nowStr();
  const firestorePatch = {
    status: ok ? 'completed' : 'failed',
    api_job_id: payload.job_id,
    updated_at: completedAt,
    ...(ok
      ? {
          completed_at: completedAt,
          ...(ingest ? { results: ingest.results, s3_keys: ingest.s3_keys, thumbnail_keys: ingest.thumbnail_keys } : {}),
          // Pipeline tools (cataloguing, product_photoshoot) report per-output failures
          // even on a "completed" job. Surface them so the UI can list which drapes/scenes
          // failed; the job is still billed in full (partial-success policy).
          ...(Array.isArray(payload.item_errors) && payload.item_errors.length
            ? { item_errors: payload.item_errors }
            : {}),
          // all_modes outfit_extractor: fan-out across 3 models; some may fail while
          // others succeed. Forward partial-failure tracking so the UI can surface
          // which modes failed. Credit settlement is still in full (same policy as
          // item_errors).
          ...(payload.has_partial_failures
            ? { has_partial_failures: true, failed_modes: payload.failed_modes || [] }
            : {}),
        }
      : {
          failed_at: completedAt,
          error_message: `API-tier job ${payload.job_id} failed`,
        }),
  };

  // Duration fields (best-effort; null when timestamps missing — matches legacy _ms).
  if (ok) {
    const durations = computeDurationsMs(taskData, completedAt);
    Object.assign(firestorePatch, durations);
  }

  await firestore().doc(`tasks/${taskId}`).update(firestorePatch);
  console.log(`[bridge] WROTE firestore tasks/${taskId} status=${firestorePatch.status} keys=${Object.keys(firestorePatch).join(',')}`);

  // RTDB tasks/{userId} mirror removed: the web UI now subscribes to the
  // Firestore tasks/{taskId} doc directly for API-tier tasks (no RTDB pointer).
  // Credit mirrors (orgCredits / creditLimits) below are intentionally kept.
  return firestorePatch;
}

// Returns { queue_duration_ms, processing_duration_ms, total_duration_ms }, each number|null.
export function computeDurationsMs(taskData, completedAtStr) {
  const created = parseKolkataMs(taskData.created_at);
  const started = parseKolkataMs(taskData.processing_started_at);
  const done = parseKolkataMs(completedAtStr);
  const out = {};
  out.total_duration_ms = created != null && done != null ? Math.max(0, done - created) : null;
  out.queue_duration_ms = created != null && started != null ? Math.max(0, started - created) : null;
  out.processing_duration_ms = started != null && done != null ? Math.max(0, done - started) : null;
  return out;
}

// task.created_at is "MM/DD/YYYY, HH:MM:SS" (en-US Kolkata) from buildBaseTask.
export function parseKolkataMs(s) {
  if (!s) return null;
  const t = Date.parse(`${s.replace(',', '')} GMT+0530`);
  return Number.isFinite(t) ? t : null;
}

export const TERMINAL = new Set(['completed', 'failed']);

// --- IST date helpers (mirror Python firebase_utils.py get_today_date / _to_yyyy_mm_dd) ---
function getTodayDateIST() {
  return new Date().toLocaleDateString('en-CA', { timeZone: KOLKATA });
}

function toYYYYMMDD(value) {
  let dt = null;
  if (!value) {
    dt = new Date();
  } else if (typeof value === 'string') {
    const parsed = new Date(value.replace('Z', '+00:00'));
    if (!isNaN(parsed.getTime())) {
      dt = parsed;
    } else {
      const m = value.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
      if (m) dt = new Date(`${m[3]}-${m[1]}-${m[2]}T00:00:00+05:30`);
    }
  }
  if (!dt || isNaN(dt.getTime())) dt = new Date();
  return dt.toLocaleDateString('en-CA', { timeZone: KOLKATA });
}

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
    const ai = poolFields('credits');
    const cat = poolFields('cataloguing_credits');
    const aiBal = d[ai.balance] || 0;
    const aiRes = d[ai.reserved] || 0;
    const catBal = d[cat.balance] || 0;
    const catRes = d[cat.reserved] || 0;
    await rtdb().ref(`orgCredits/${orgId}`).update({
      [ai.balance]: aiBal,
      [ai.reserved]: aiRes,
      available_credits: aiBal - aiRes,
      [cat.balance]: catBal,
      [cat.reserved]: catRes,
      available_cataloguing_credits: catBal - catRes,
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
 * Transactionally deduct a previously-reserved amount on success, from the given pool.
 * Field math on orgs/{orgId}: <balance> -= amt, <reserved> -= amt, <used> += amt.
 * AI pool also bumps org_users/{uid}.credits_used (per-user limit accounting — I2);
 * cataloguing pool has no per-user ledger today, so the user update is skipped.
 * Marks tasks/{taskId}.credits_settled = true (idempotency marker).
 *
 * @param {string} [pool='credits']  'credits' | 'cataloguing_credits'
 */
export async function deductReserved({ taskId, orgId, uid, amount, pool = 'credits' }) {
  const amt = Math.max(0, Math.trunc(Number(amount) || 0));
  if (amt === 0) return;
  const f = poolFields(pool);
  const orgRef = firestore().doc(`orgs/${orgId}`);
  const taskRef = taskId ? firestore().doc(`tasks/${taskId}`) : null;
  const userRef = uid && f.perUserUsed ? firestore().doc(`org_users/${uid}`) : null;

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
    const reserved = d[f.reserved] || 0;
    if (reserved < amt) {
      throw new Error(`deductReserved: ${f.reserved} insufficient (reserved=${reserved}, required=${amt})`);
    }
    // credit_history — mirror Python deduct_credits (firebase_utils.py:999-1021)
    const today = getTodayDateIST();
    const currentCredits = d[f.balance] || 0;
    const creditHistory = Array.isArray(d[f.history]) ? d[f.history] : [];
    let todayEntry = creditHistory.find(e => e.date === today);
    if (!todayEntry) {
      todayEntry = {
        date: today,
        starting_credits: currentCredits,
        used_credits: 0,
        remaining_credits: currentCredits,
      };
      creditHistory.push(todayEntry);
    }
    todayEntry.used_credits += amt;
    todayEntry.remaining_credits = currentCredits - amt;

    txn.update(orgRef, {
      [f.balance]: FieldValue.increment(-amt),
      [f.reserved]: FieldValue.increment(-amt),
      [f.used]: FieldValue.increment(amt),
      [f.history]: creditHistory,
    });
    if (userRef) {
      txn.update(userRef, { [f.perUserUsed]: FieldValue.increment(amt) });
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
 * Tracking-only entry for unlimited-plan orgs. Writes <history> +
 * <used> but does NOT touch <balance> or <reserved> (nothing was
 * reserved for unlimited orgs). Called from handler when settle_amount=0
 * but credits>0.
 *
 * @param {string} [pool='credits']  'credits' | 'cataloguing_credits'
 */
export async function recordUsage({ taskId, orgId, uid, amount, pool = 'credits' }) {
  const amt = Math.max(0, Math.trunc(Number(amount) || 0));
  if (amt === 0) return;
  const f = poolFields(pool);
  const orgRef = firestore().doc(`orgs/${orgId}`);
  const taskRef = taskId ? firestore().doc(`tasks/${taskId}`) : null;
  const userRef = uid && f.perUserUsed ? firestore().doc(`org_users/${uid}`) : null;

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
    const d = snap.data() || {};

    const today = getTodayDateIST();
    const currentCredits = d[f.balance] || 0;
    const creditHistory = Array.isArray(d[f.history]) ? d[f.history] : [];
    let todayEntry = creditHistory.find(e => e.date === today);
    if (!todayEntry) {
      todayEntry = {
        date: today,
        starting_credits: currentCredits,
        used_credits: 0,
        remaining_credits: currentCredits,
      };
      creditHistory.push(todayEntry);
    }
    todayEntry.used_credits += amt;
    todayEntry.remaining_credits = currentCredits; // balance unchanged for unlimited

    const orgUpdate = {
      [f.used]: FieldValue.increment(amt),
      [f.history]: creditHistory,
    };
    txn.update(orgRef, orgUpdate);
    if (userRef) {
      txn.update(userRef, { [f.perUserUsed]: FieldValue.increment(amt) });
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
 * Update user_stats/{userId} on task completion. Mirrors the Python
 * update_user_stats_on_task_completion (firebase_utils.py:374-430)
 * field-for-field. Idempotent via processed_tasks.{date} check.
 */
export async function updateUserStats({ taskId, taskData, imageCount = 1 }) {
  const userId = taskData.user_id;
  const orgId = taskData.org_id;
  const taskType = (taskData.type || '').trim().toLowerCase();
  if (!userId || !taskType || !taskId) return;

  const opField = `${taskType}_op`;
  const creditsField = `${taskType}_credits`;
  const dateKey = toYYYYMMDD(taskData.created_at);
  const imgCount = Math.max(0, Math.trunc(Number(imageCount) || 0)) || 1;

  let creditsUsed = Math.max(0, Math.trunc(Number(taskData.credits) || 0));
  const extraParams = taskData.extra_params || {};
  if (extraParams.is_freeupscale || extraParams.is_free_upscale) {
    creditsUsed = 0;
  }

  const statsRef = firestore().doc(`user_stats/${userId}`);

  await firestore().runTransaction(async (txn) => {
    const snap = await txn.get(statsRef);
    const existing = snap.exists ? snap.data() : {};
    const processedByDate = existing.processed_tasks || {};
    const processedForDay = processedByDate[dateKey] || [];

    if (processedForDay.includes(taskId)) {
      return; // idempotent
    }

    txn.set(statsRef, { org_id: orgId }, { merge: true });

    const updates = {
      [`processed_tasks.${dateKey}`]: FieldValue.arrayUnion(taskId),
      last_task_id: taskId,
      last_task_time: taskData.created_at || new Date().toISOString(),
      'operations.total': FieldValue.increment(1),
      [`operations.date.${dateKey}.total`]: FieldValue.increment(1),
      [`operations.date.${dateKey}.${opField}`]: FieldValue.increment(1),
      'images_created.total': FieldValue.increment(imgCount),
      [`images_created.date.${dateKey}.total`]: FieldValue.increment(imgCount),
      [`images_created.date.${dateKey}.${taskType}`]: FieldValue.increment(imgCount),
    };

    if (creditsUsed > 0) {
      updates['credits_used.total'] = FieldValue.increment(creditsUsed);
      updates[`credits_used.${creditsField}`] = FieldValue.increment(creditsUsed);
      updates[`credits_used.date.${dateKey}.total`] = FieldValue.increment(creditsUsed);
      updates[`credits_used.date.${dateKey}.${creditsField}`] = FieldValue.increment(creditsUsed);
    }

    txn.update(statsRef, updates);
  });
}

/**
 * Transactionally release a reservation on failure, in the given pool.
 * orgs/{orgId}.<reserved> -= amt (clamped at 0). Marks tasks/{taskId}.credits_settled = true.
 *
 * @param {string} [pool='credits']  'credits' | 'cataloguing_credits'
 */
export async function releaseReserved({ taskId, orgId, amount, pool = 'credits' }) {
  const requested = Math.max(0, Math.trunc(Number(amount) || 0));
  if (requested === 0) return;
  const f = poolFields(pool);
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
    const reserved = snap.data()?.[f.reserved] || 0;
    const toRelease = Math.min(requested, reserved); // clamp
    if (toRelease > 0) {
      txn.update(orgRef, { [f.reserved]: FieldValue.increment(-toRelease) });
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
