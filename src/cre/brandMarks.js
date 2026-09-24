// Original neutral labels. No retailer logo artwork is bundled.
function neutralMark(key, name, initials) {
  return Object.freeze({
    key,
    name,
    initials,
    image: `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><rect x="1" y="1" width="30" height="30" rx="5" fill="#455568" stroke="white"/><text x="16" y="21" text-anchor="middle" font-family="Arial,sans-serif" font-size="13" fill="white">${initials}</text></svg>`)}`,
  });
}
export const BRAND_MARKS = Object.freeze({
  starbucks: neutralMark('starbucks', 'Starbucks', 'Sb'),
  kroger: neutralMark('kroger', 'Kroger', 'Kr'),
  target: neutralMark('target', 'Target', 'Ta'),
  walmart: neutralMark('walmart', 'Walmart', 'Wm'),
  walgreens: neutralMark('walgreens', 'Walgreens', 'Wg'),
});

/** The fixed chain keys a local override file may be named after (see `local-brand-marks/`). */
export const KNOWN_BRAND_MARK_KEYS = Object.freeze(Object.keys(BRAND_MARKS));

/** Exact-name chain matching only. Unknown names keep their category symbols. */
export function brandMarkFor(name) {
  const value = String(name || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
  if (/^starbucks(?: coffee)?$/.test(value)) return BRAND_MARKS.starbucks;
  if (/^kroger(?: marketplace| fuel center)?$/.test(value))
    return BRAND_MARKS.kroger;
  if (/^target$/.test(value)) return BRAND_MARKS.target;
  if (/^walmart(?: supercenter| neighborhood market)?$/.test(value))
    return BRAND_MARKS.walmart;
  if (/^walgreens(?: pharmacy)?$/.test(value)) return BRAND_MARKS.walgreens;
  return null;
}

const CATEGORY_GLYPHS = Object.freeze({
  retail: 'R',
  coffee: 'C',
  parks: 'P',
  attractions: 'A',
  restaurants: 'D',
  amenities: '+',
  schools: 'S',
  employers: 'W',
});

/** A local generic marker for named places without a verified chain match. */
export function categoryGlyphFor(layerId) {
  return CATEGORY_GLYPHS[layerId] || null;
}

export function categoryIconImage(layerId, color = '#566579') {
  const glyph = categoryGlyphFor(layerId);
  if (!glyph) return null;
  const safeColor = /^#[0-9a-f]{6}$/i.test(color) ? color : '#566579';
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="${safeColor}" stroke="white" stroke-width="2"/><text x="12" y="16" text-anchor="middle" font-family="Arial,sans-serif" font-size="12" font-weight="bold" fill="white">${glyph}</text></svg>`)}`;
}
