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
  if (ct.includes('mp4') || ct.includes('quicktime')) return 'mp4'; // cataloguing walk videos
  if (ct.includes('webm')) return 'webm';
  if (ct.includes('zip')) return 'zip';       // cataloguing/product_photoshoot bundle
  // fall back to the URL's extension, else png
  const m = (url || '').match(/\.(png|jpe?g|webp|gif|tiff?|psd|svg|mp4|webm|zip)(?:\?|#|$)/i);
  if (!m) return 'png';
  const e = m[1].toLowerCase();
  return e === 'jpeg' ? 'jpg' : e;
}

// Kinds that are NOT still images — the thumbnail event-listener cannot poster them,
// so we record null rather than a bogus .webp key the UI would try to resolve.
// An absent kind (every single-shot tool) is treated as an image — the default case.
const NON_IMAGE_KINDS = new Set(['video', 'bundle']);
function isImageKind(kind) {
  return !kind || !NON_IMAGE_KINDS.has(kind);
}

// Resolve a result entry's display URL field for a given legacy name, in the shape
// the cataloguing UI (DownloadStep / ExtrasVideo / pdfUtils) already reads.
function legacyFieldForKind(kind) {
  switch (kind) {
    case 'drape': return 'draped_url';
    case 'storyboard': return 'storyboard_url';
    case 'video': return 'video_url';
    case 'bundle': return 'zip_url';
    case 'scene': return 'scene_url';
    case 'fix_image': return 'fixed_url';
    default: return null;
  }
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
  const thumbnail_keys = [];

  outputs.forEach((_u, i) => { /* presence check below */ });
  let idx = 0;
  for (const entry of outputs || []) {
    idx += 1;
    // API tier sends {type, url, expires_in, meta?} objects; accept both shapes.
    const url = typeof entry === 'string' ? entry : entry?.url;
    if (!url) throw new Error(`no url on output ${idx}`);
    const resp = await fetch(url);
    if (!resp.ok) {
      throw new Error(`download failed for output ${idx}: HTTP ${resp.status}`);
    }
    const contentType = resp.headers.get('content-type') || 'image/png';
    const ext = extFor(contentType, url);
    const meta = typeof entry === 'object' && entry ? entry.meta : null;
    // Tool-and-input-wise filename (port of s3_utils.task_type_filename_map).
    const stem = buildOutputStem({
      type,
      index: idx - 1, // 0-based, matching the worker's `index`
      refImage: taskData.ref_image,
      extraParams: taskData.extra_params,
      meta,
    });
    const key = `tasks/${org_id}/${type}/${yyyy}/${mm}/${dd}/${user_id}/${taskId}/${stem}.${ext}`;
    const body = Buffer.from(await resp.arrayBuffer());
    await uploadBytes(b, key, body, contentType);

    const cf = cloudfrontUrlFor(key);
    const presigned = cf ? null : await presignGet(b, key, 86400);
    const urlFields = cf
      ? { cloudfront_url: cf, url_type: 'cloudfront' }
      : { presigned_url: presigned, url_type: 'presigned_s3' };

    // Build the result entry: generic shape (s3_key + url + meta) plus the legacy
    // kind-specific field (draped_url / storyboard_url / video_url / zip_url / scene_url)
    // so the existing cataloguing UI keeps rendering without a rewrite.
    const resultEntry = { s3_key: key, ...urlFields };
    if (meta) resultEntry.meta = meta;
    const legacyField = legacyFieldForKind(meta?.kind);
    if (legacyField) resultEntry[legacyField] = urlFields.cloudfront_url || urlFields.presigned_url;
    results.push(resultEntry);

    s3_keys.push(key);
    // Videos and zips have no still-image thumbnail; record null so the web
    // thumbnailResolver skips them instead of trying to resolve a bogus .webp.
    thumbnail_keys.push(isImageKind(meta?.kind) ? thumbKeyFor(key) : null);
  }

  return { results, s3_keys, thumbnail_keys };
}
