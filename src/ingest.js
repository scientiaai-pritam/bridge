import { uploadBytes, presignGet, bucket, cloudfrontUrlFor } from './s3.js';
import { buildOutputStem } from './naming.js';

const KOLKATA = 'Asia/Kolkata';

function kolkataDateParts() {
  const d = new Date();
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: KOLKATA, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const [yyyy, mm, dd] = f.format(d).split('-');
  return { yyyy, mm, dd };
}

// Map a content-type or URL to a file extension.
function extFor(contentType, url) {
  const ct = (contentType || '').toLowerCase();
  if (ct.includes('png')) return 'png';
  if (ct.includes('jpeg') || ct.includes('jpg')) return 'jpg';
  if (ct.includes('webp')) return 'webp';
  if (ct.includes('gif')) return 'gif';
  if (ct.includes('tiff')) return 'tiff';
  if (ct.includes('photoshop')) return 'psd'; // object_layering/color_layering
  if (ct.includes('svg')) return 'svg';       // vectorizer
  // fall back to the URL's extension, else png
  const m = (url || '').match(/\.(png|jpe?g|webp|gif|tiff?|psd|svg)(?:\?|#|$)/i);
  if (!m) return 'png';
  const e = m[1].toLowerCase();
  return e === 'jpeg' ? 'jpg' : e;
}

function thumbKeyFor(s3Key) {
  const i = s3Key.lastIndexOf('.');
  return i > 0 ? s3Key.slice(0, i) + '.webp' : s3Key + '.webp';
}

/**
 * Download each signed output URL, upload to the web S3 bucket under the
 * tool-and-input-wise key pattern (port of s3_utils.task_type_filename_map),
 * and build results/s3_keys/thumbnail_keys in the legacy shape.
 * Throws on any download failure so the bridge can return non-2xx and let the
 * WebhookQueue retry. S3 PutObject is idempotent, so a retry re-uploads safely.
 */
export async function ingestOutputs({ taskId, taskData, outputs }) {
  const { org_id, user_id, type } = taskData;
  const { yyyy, mm, dd } = kolkataDateParts();
  const b = bucket();
  const results = [];
  const s3_keys = [];

  outputs.forEach((_u, i) => { /* presence check below */ });
  let idx = 0;
  for (const entry of outputs || []) {
    idx += 1;
    // API tier sends {type, url, expires_in} objects; accept both shapes.
    const url = typeof entry === 'string' ? entry : entry?.url;
    if (!url) throw new Error(`no url on output ${idx}`);
    const resp = await fetch(url);
    if (!resp.ok) {
      throw new Error(`download failed for output ${idx}: HTTP ${resp.status}`);
    }
    const contentType = resp.headers.get('content-type') || 'image/png';
    const ext = extFor(contentType, url);
    // Tool-and-input-wise filename (port of s3_utils.task_type_filename_map).
    const stem = buildOutputStem({
      type,
      index: idx - 1, // 0-based, matching the worker's `index`
      refImage: taskData.ref_image,
      extraParams: taskData.extra_params,
    });
    const key = `tasks/${org_id}/${type}/${yyyy}/${mm}/${dd}/${user_id}/${taskId}/${stem}.${ext}`;
    const body = Buffer.from(await resp.arrayBuffer());
    await uploadBytes(b, key, body, contentType);

    const cf = cloudfrontUrlFor(key);
    const presigned = cf ? null : await presignGet(b, key, 86400);
    results.push({
      s3_key: key,
      ...(cf ? { cloudfront_url: cf, url_type: 'cloudfront' } : { presigned_url: presigned, url_type: 'presigned_s3' }),
    });
    s3_keys.push(key);
  }

  const thumbnail_keys = s3_keys.map(thumbKeyFor);
  return { results, s3_keys, thumbnail_keys };
}
