import { buildOutputStem, extractInputFilename } from '../src/naming.js';

test('extractInputFilename strips host + extension, decodes', () => {
  expect(extractInputFilename('https://s3/inputs/My Design.png?v=1')).toBe('My Design');
  expect(extractInputFilename('https://s3/in/photo.jpeg')).toBe('photo');
  expect(extractInputFilename('inputs/foo.TIFF')).toBe('foo');
  expect(extractInputFilename('')).toBe('');
  expect(extractInputFilename(undefined)).toBe('');
});

const REF = 'https://s3/inputs/desk.png';

test('upscale embeds scale + creativity', () => {
  expect(buildOutputStem({ type: 'upscale', refImage: REF, extraParams: { scale_factor: 4, creativity: 35 } }))
    .toBe('desk_rtp_4_35');
});

test('upscale falls back to defaults when params missing', () => {
  expect(buildOutputStem({ type: 'upscale', refImage: REF })).toBe('desk_rtp_4_35');
});

test('object_layering + color_layering use layered index', () => {
  expect(buildOutputStem({ type: 'object_layering', refImage: REF, index: 0 })).toBe('desk_layered_1');
  expect(buildOutputStem({ type: 'color_layering', refImage: REF, index: 2 })).toBe('desk_layered_3');
});

test('bg_remove / anti_blur / watermark_removal fixed suffixes', () => {
  expect(buildOutputStem({ type: 'bg_remove', refImage: REF })).toBe('desk_bg_removed');
  expect(buildOutputStem({ type: 'anti_blur', refImage: REF })).toBe('desk_deblurred');
  expect(buildOutputStem({ type: 'watermark_removal', refImage: REF })).toBe('desk_watermark_removed');
});

test('repeat_set expand vs offset branch', () => {
  expect(buildOutputStem({ type: 'repeat_set', refImage: REF, extraParams: { isExpanded: true } }))
    .toBe('desk_repeat_set_Extend');
  expect(buildOutputStem({ type: 'repeat_set', refImage: REF, extraParams: { horizontalOffset: 3, verticalOffset: 5 } }))
    .toBe('desk_repeat_set_3H_5V');
});

test('design_creation picks blend / inpaint / style branch', () => {
  expect(buildOutputStem({ type: 'design_creation', refImage: REF, extraParams: { isImageBlendMode: true } }))
    .toBe('desk_design_generation_Blend');
  expect(buildOutputStem({ type: 'design_creation', refImage: REF, extraParams: { inpaint_mode: true } }))
    .toBe('desk_design_generation_Inpaint');
  expect(buildOutputStem({ type: 'design_creation', refImage: REF }))
    .toBe('desk_design_generation_Style_modification');
});

test('design_extension uses TLBR when all gaps present, else HV', () => {
  expect(buildOutputStem({ type: 'design_extension', refImage: REF, extraParams: { top_gap: 1, left_gap: 2, bottom_gap: 3, right_gap: 4 } }))
    .toBe('desk_design_extension_T1_L2_B3_R4');
  expect(buildOutputStem({ type: 'design_extension', refImage: REF, extraParams: { horizontal_gap: 8, vertical_gap: 8 } }))
    .toBe('desk_design_extension_8H_8V');
});

test('unknown type falls back to 1-based index', () => {
  expect(buildOutputStem({ type: 'something_new', refImage: REF, index: 0 })).toBe('1');
  expect(buildOutputStem({ type: 'something_new', refImage: REF, index: 2 })).toBe('3');
});

test('missing ref_image falls back to index base, then applies tool suffix', () => {
  // matches worker: filename = str(index+1) when no input url, suffix still applied
  expect(buildOutputStem({ type: 'upscale', index: 0 })).toBe('1_rtp_4_35');
  expect(buildOutputStem({ type: 'color_matching', index: 1 })).toBe('2_color_matched_2');
});

// --- pipeline tools + multi-output uniqueness ---------------------------

test('cataloguing builds kind-aware stems from meta.design_url', () => {
  const meta = (kind, extra = {}) => ({ kind, design_url: 'https://s3/inputs/printA.png', ...extra });
  expect(buildOutputStem({ type: 'cataloguing', index: 0, meta: meta('drape') })).toBe('printA_drape_1');
  expect(buildOutputStem({ type: 'cataloguing', index: 3, meta: meta('video') })).toBe('printA_video_4');
  expect(buildOutputStem({ type: 'cataloguing', index: 6, meta: meta('storyboard') })).toBe('printA_storyboard_7');
  expect(buildOutputStem({ type: 'cataloguing', index: 7, meta: meta('bundle') })).toBe('printA_bundle');
});

test('cataloguing outputs never collide on the same S3 key stem', () => {
  // Simulate a flat outputs list: 2 drapes + 1 video + 1 storyboard + 1 bundle.
  const metas = [
    { kind: 'drape', design_url: 'https://s3/inputs/a.png' },
    { kind: 'drape', design_url: 'https://s3/inputs/a.png' },
    { kind: 'video', design_url: 'https://s3/inputs/a.png' },
    { kind: 'storyboard', design_url: 'https://s3/inputs/a.png' },
    { kind: 'bundle', design_url: 'https://s3/inputs/a.png' },
  ];
  const stems = metas.map((m, i) => buildOutputStem({ type: 'cataloguing', index: i, meta: m }));
  expect(new Set(stems).size).toBe(stems.length); // all unique
});

test('cataloguing without meta falls back to indexed cataloguing stem', () => {
  expect(buildOutputStem({ type: 'cataloguing', index: 0 })).toBe('1_cataloguing_1');
  expect(buildOutputStem({ type: 'cataloguing', index: 2 })).toBe('3_cataloguing_3');
});

test('product_photoshoot scene + bundle stems from meta.product_image_url', () => {
  const product = 'https://s3/inputs/cushion.png';
  expect(buildOutputStem({ type: 'product_photoshoot', index: 0, meta: { kind: 'scene', product_image_url: product } })).toBe('cushion_scene_1');
  expect(buildOutputStem({ type: 'product_photoshoot', index: 4, meta: { kind: 'bundle', product_image_url: product } })).toBe('cushion_bundle');
});

test('multi-output single-shot tools suffix position so variations do not collide', () => {
  // index 0 keeps the legacy name (back-compat); index>0 appends _N.
  expect(buildOutputStem({ type: 'three_d_effect', refImage: REF, index: 0 })).toBe('desk_3d_effect');
  expect(buildOutputStem({ type: 'three_d_effect', refImage: REF, index: 1 })).toBe('desk_3d_effect_2');
  expect(buildOutputStem({ type: 'design_generation_v2', refImage: REF, index: 2 })).toBe('desk_design_creation_v2_3');
  expect(buildOutputStem({ type: 'design_generation', refImage: REF, extraParams: { creativity: 50 }, index: 1 })).toBe('desk_design_creation_50_2');
});
