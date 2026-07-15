// Output filename convention — a JS port of the worker repo's
// designer-ai-scripts/scripts/utils/s3_utils.py (`task_type_filename_map` +
// `extract_input_filename`). Keeps the web-facing S3 keys tool-and-input-wise
// named (e.g. `mydesign_rtp_4_35.png`, `mydesign_layered_1.png`,
// `mydesign_bg_removed.png`) so the API-tier path matches what the worker
// scripts have always produced.
//
// One deliberate deviation: the worker map hard-codes the extension per tool
// (`.png` for some, `.{output_format}` for others). The bridge never re-encodes
// — it stores whatever bytes the API tier produced — so the real extension is
// whatever ingest.js detects from the content-type/URL. buildOutputStem returns
// the stem WITHOUT an extension; the caller appends the detected one. This keeps
// the filename honest about the actual file type (e.g. object_layering → .psd).

// Strip the leading bucket/host and any query, take the last path segment,
// drop a trailing image extension. Mirrors `extract_input_filename`. Returns ''
// when nothing usable can be parsed (caller falls back to the 1-based index).
export function extractInputFilename(url) {
  if (!url) return '';
  let path;
  try {
    path = new URL(url).pathname;
  } catch {
    path = url; // already a path/key
  }
  const decoded = (() => { try { return decodeURIComponent(path); } catch { return path; } })();
  const name = decoded.split('/').filter(Boolean).pop() || '';
  return name.replace(/\.(jpe?g|png|tiff?|webp|gif|bmp|svg|psd)$/i, '');
}

// Build the output filename stem (no extension) for a single output of a task.
// `index` is 0-based (matches the worker's `index`, displayed as `index + 1`).
// `refImage` is taskData.ref_image; `extraParams` is taskData.extra_params.
export function buildOutputStem({ type, index = 0, refImage = '', extraParams = {} }) {
  const p = extraParams || {};
  const filename = extractInputFilename(refImage) || String(index + 1);

  const scale_factor = p.scale_factor ?? 4;
  const creativity = p.creativity ?? 35;
  const clusters = p.clusters ?? 8;
  const style = p.style ?? '';
  const selected_style = p.selected_style ?? '';
  const horizontalOffset = p.horizontalOffset ?? 1;
  const verticalOffset = p.verticalOffset ?? 1;
  const horizontal_gap = p.horizontal_gap ?? 8;
  const vertical_gap = p.vertical_gap ?? 8;
  const top_gap = p.top_gap;
  const left_gap = p.left_gap;
  const bottom_gap = p.bottom_gap;
  const right_gap = p.right_gap;

  switch (type) {
    case 'upscale':
      return `${filename}_rtp_${scale_factor}_${creativity}`;
    case 'object_layering':
    case 'color_layering':
      return `${filename}_layered_${index + 1}`;
    case 'design_generation':
      return `${filename}_design_creation_${creativity}`;
    case 'repeat_set':
      return p.isExpanded
        ? `${filename}_repeat_set_Extend`
        : `${filename}_repeat_set_${horizontalOffset}H_${verticalOffset}V`;
    case 'color_transfer':
      return `${filename}_color_transfer_${clusters}`;
    case 'style_transfer':
      return `${filename}_style_transfer_${style}_${creativity}`;
    case 'bg_remove':
      return `${filename}_bg_removed`;
    case 'edge_detection':
      return `${filename}_edge_detection`;
    case 'watermark_removal':
      return `${filename}_watermark_removed`;
    case 'anti_blur':
      return `${filename}_deblurred`;
    case 'outfit_extractor':
      return `${filename}_dress_to_design`;
    case 'cataloguing':
      return `${filename}_cataloguing`;
    case 'design_creation':
      if (p.isImageBlendMode) return `${filename}_design_generation_Blend`;
      if (p.inpaint_mode) return `${filename}_design_generation_Inpaint`;
      return `${filename}_design_generation_Style_modification`;
    case 'incolor':
      return `${filename}_sketch_to_design_${selected_style}`;
    case 'design_extension':
      return (top_gap != null && left_gap != null && bottom_gap != null && right_gap != null)
        ? `${filename}_design_extension_T${top_gap}_L${left_gap}_B${bottom_gap}_R${right_gap}`
        : `${filename}_design_extension_${horizontal_gap}H_${vertical_gap}V`;
    case 'vectorizer':
      return `${filename}_vectorizer`;
    case 'three_d_effect':
      return `${filename}_3d_effect`;
    case 'design_generation_v2':
      return `${filename}_design_creation_v2`;
    case 'design_generation_basic':
      return `${filename}_design_generation_basic`;
    case 'image_enhance':
      return `${filename}_super_scaler_${p.mode ?? 'mode_1'}_${p.detail_enhancement ?? 'neutral'}_${p.processing_size ?? 'original_size'}`;
    case 'color_matching':
      return `${filename}_color_matched_${index + 1}`;
    default:
      // Matches the worker's map.get(task_type, f"{index + 1}.{ext}") fallback.
      return String(index + 1);
  }
}
