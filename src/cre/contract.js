// The fixed section contract (result shape, status enum, DOM attribute names, placeholder checker) every dossier section, the panel, the export and the harness depend on.

/** Section status values. */
export const SECTION_STATUS = Object.freeze({
  READY: 'ready',
  PARTIAL: 'partial',
  EMPTY: 'empty',
  UNAVAILABLE: 'unavailable',
  NEEDS_KEY: 'needs-key',
});

const STATUS_VALUES = new Set(Object.values(SECTION_STATUS));

/** DOM attribute names. The harness and the export read only these. */
export const DOSSIER_ATTR = Object.freeze({
  STATE: 'data-dossier-state',
  SECTION: 'data-dossier-section',
  STATUS: 'data-dossier-status',
  VALUE: 'data-dossier-value',
});

/**
 * @typedef {object} SectionContext
 * @property {number} lat
 * @property {number} lon
 * @property {string} address
 * @property {string} [tractGeoid]
 * @property {string} [county]
 * @property {string} [state]
 * @property {string} [zip]
 * @property {string} [approximate] - Set when the place is not a Census street match: what was matched instead.
 * @property {string[]} [otherMatches] - Other US places with the same name, most prominent first.
 * @property {{oneMi:number, threeMi:number, fiveMi:number}} rings - Radii in meters.
 */

/**
 * @typedef {object} SectionValue
 * @property {string} label
 * @property {number|string} value - Never a placeholder.
 * @property {string} [unit]
 * @property {string} [note]
 * @property {string} [raw] - Source wording when `value` was reworded for display; kept in the export.
 */

/**
 * @typedef {object} SectionOverlay
 * @property {string} id
 * @property {object} geojson
 * @property {{stroke?:string, fill?:string, icon?:string}} style
 */

/**
 * @typedef {object} SectionResult
 * @property {string} id
 * @property {string} label
 * @property {'ready'|'partial'|'empty'|'unavailable'|'needs-key'} status
 * @property {SectionValue[]} values
 * @property {SectionOverlay[]} [overlays]
 * @property {{text:string, url:string, license:string}} credit
 * @property {string[]} sourceUrls
 * @property {string} retrievedAt - ISO 8601.
 * @property {string} [message] - Honest reason; required unless status is ready.
 */

/**
 * @typedef {object} SectionModule
 * @property {string} id
 * @property {string} label
 * @property {number} order
 * @property {(ctx:SectionContext, opts:{signal:AbortSignal}) => Promise<SectionResult>} load
 */

const PLACEHOLDER_TEXT = new Set([
  'placeholder',
  'tbd',
  'tba',
  'n/a',
  'na',
  'none',
  'null',
  'undefined',
  'nan',
  'unavailable',
  'unknown',
  'loading',
  'loading...',
  '...',
  '?',
]);

/** Only dashes (hyphen, figure, en, em, horizontal bar, minus) and spaces. */
const DASH_ONLY = /^[\s\-\u2012-\u2015\u2212]+$/;

/**
 * True when a displayed value is a stand-in rather than data: null, NaN,
 * Infinity, empty or whitespace text, a lone or repeated dash, or a known
 * placeholder word (case-insensitive). The DOM harness uses this same check.
 * @param {unknown} value
 */
export function isPlaceholderValue(value) {
  if (typeof value === 'number') return !Number.isFinite(value);
  if (typeof value !== 'string') return true;
  const text = value.trim();
  if (text === '') return true;
  if (DASH_ONLY.test(text)) return true;
  return PLACEHOLDER_TEXT.has(text.toLowerCase());
}

/**
 * Units whose magnitude is structurally impossible to be zero where a real
 * site stands: money, resident counts, a median age. A ring drawn around a
 * site holds people, so "0 people" is a broken pipeline, not a finding.
 * Counts of things nearby are NOT here: zero of them is a real reading.
 */
const ZERO_IMPOSSIBLE_UNITS = new Set([
  '$',
  '$/mo',
  '$/month',
  '$/yr',
  '$/year',
  'usd',
  'usd/mo',
  'usd/month',
  'usd/yr',
  'usd/year',
  'people',
  'residents',
  'households',
  'years',
]);

/**
 * Units where a zero is a real reading: nothing found nearby, no change, a
 * distance or a rate that genuinely floors at zero.
 */
const ZERO_MEANINGFUL_UNITS = new Set([
  '%',
  'percent',
  'mi',
  'km',
  'm',
  'ft',
  'min',
  'minutes',
  'sq mi',
  'degrees',
]);

/**
 * Labels whose magnitude cannot be zero at a real site, checked so a build
 * that drops the unit string is still caught.
 */
const ZERO_IMPOSSIBLE_LABELS = [
  /\bmedian\b[^()]*\b(?:income|rent|age|value|price|wage)\b/i,
  /\brent index\b|\bzori\b/i,
  /\bfair market rent\b|\bfmr\b/i,
  /\b(?:avg|average|mean)\b[^()]*\bwage\b/i,
  /^\s*population\b/i,
  /\bhouseholds\b/i,
];

/**
 * Deltas. A change of exactly zero is a real reading whatever it is measured
 * in, so these beat even a money unit.
 */
const ZERO_DELTA_LABELS =
  /\b(?:change|changes|changed|growth|trend|delta|difference|since)\b/i;

/**
 * Counts, shares and rates of things that may genuinely not be there. These
 * beat the impossible-LABEL list but never the impossible-UNIT list: a row
 * labelled "Public schools within 3 mi" that renders "0 USD" is still a
 * broken pipeline, because the unit is money.
 */
const ZERO_COUNT_LABELS =
  /\b(?:share|rate|burden|burdened|percent|within|near|nearest|permits|properties|cameras|schools|acres|releases|updates)\b|%/i;

/**
 * Split a rendered value cell into its leading number and trailing unit.
 * `formatValue` writes "1,471.84 $/mo", so the unit is text, not metadata.
 * @param {unknown} text
 * @returns {{number: number|null, unit: string, currency: boolean}}
 */
export function splitDisplayedValue(text) {
  const raw = String(text ?? '').trim();
  const match = /^([-+]?\s?\$?\s?[\d,]+(?:\.\d+)?)\s*(.*)$/.exec(raw);
  if (!match) return { number: null, unit: '', currency: false };
  const currency = match[1].includes('$');
  const number = Number(match[1].replace(/[$,\s]/g, ''));
  return {
    number: Number.isFinite(number) ? number : null,
    unit: match[2].trim(),
    currency: currency || match[2].trim().startsWith('$'),
  };
}

/**
 * Whether a zero would be nonsense for this label and unit. The unit outranks
 * the label, because the unit is the harder evidence: only a delta label
 * beats a money unit.
 */
function zeroIsImpossible(label, unit, currency) {
  const text = String(label ?? '');
  const key = String(unit ?? '')
    .trim()
    .toLowerCase();
  if (ZERO_DELTA_LABELS.test(text)) return false;
  if (ZERO_MEANINGFUL_UNITS.has(key)) return false;
  if (currency || ZERO_IMPOSSIBLE_UNITS.has(key)) return true;
  if (ZERO_COUNT_LABELS.test(text)) return false;
  return ZERO_IMPOSSIBLE_LABELS.some((pattern) => pattern.test(text));
}

/**
 * True when a RENDERED value cell reads zero for a metric that cannot be zero
 * at a real site: a $0 median income, a $0 median rent, 0 people in a ring
 * that holds the site. A finite 0 used to count as a real value, so a build
 * rendering every ACS median as $0 passed 12 of 12 sections (S3-6). Zeros that
 * mean something (0 cameras within 5 mi, 0.0 % change) stay real.
 * @param {unknown} text - The cell text, e.g. "0 USD".
 * @param {string} [label] - The row label, when the harness could read it.
 */
export function isNonsenseZero(text, label = '') {
  const { number, unit, currency } = splitDisplayedValue(text);
  if (number !== 0) return false;
  return zeroIsImpossible(label, unit, currency);
}

/**
 * The same rule against a SectionValue, before it is rendered.
 * @param {{label?:string, value?:unknown, unit?:string}} item
 */
export function isNonsenseZeroValue(item) {
  if (typeof item?.value !== 'number' || item.value !== 0) return false;
  const unit = String(item.unit ?? '');
  return zeroIsImpossible(item.label ?? '', unit, unit.includes('$'));
}

/**
 * True when a rendered cell carries data: neither a placeholder nor a zero
 * that is structurally impossible for its metric.
 * @param {unknown} text
 * @param {string} [label]
 */
export function isRealValueText(text, label = '') {
  return !isPlaceholderValue(text) && !isNonsenseZero(text, label);
}

/**
 * True when a dossier section counts toward the kill criterion (SPEC 3): it
 * is ready and holds at least one value that is real. `rows` carries the row
 * labels when the snapshot could read them; `values` is the text-only
 * fallback, where the unit in the cell still catches a $0 median.
 * @param {{status?:string|null, values?:unknown[], rows?:Array<{label?:string, text?:unknown}>}} section
 */
export function isRealReadySection(section) {
  if (section?.status !== SECTION_STATUS.READY) return false;
  if (!Array.isArray(section.values)) return false;
  const rows =
    Array.isArray(section.rows) && section.rows.length === section.values.length
      ? section.rows
      : section.values.map((text) => ({ label: '', text }));
  return rows.some((row) => isRealValueText(row?.text, row?.label ?? ''));
}

function fail(reason) {
  throw new TypeError(`Invalid SectionResult: ${reason}`);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Throw a TypeError when a section result breaks the contract. Returns the
 * result unchanged when it is valid.
 * @param {SectionResult} result
 * @returns {SectionResult}
 */
export function validateSectionResult(result) {
  if (!result || typeof result !== 'object') fail('not an object');
  if (!nonEmptyString(result.id)) fail('id');
  if (!nonEmptyString(result.label)) fail('label');
  if (!STATUS_VALUES.has(result.status)) fail('status');
  if (!Array.isArray(result.values)) fail('values');
  result.values.forEach((item, index) => {
    if (!item || typeof item !== 'object') fail(`values[${index}]`);
    if (!nonEmptyString(item.label)) fail(`values[${index}].label`);
    if (isPlaceholderValue(item.value)) {
      fail(`values[${index}].value is a placeholder`);
    }
    if (isNonsenseZeroValue(item)) {
      fail(
        `values[${index}].value is a nonsense zero for "${item.label}"${item.unit ? ` (${item.unit})` : ''}`,
      );
    }
  });
  if (result.status === SECTION_STATUS.READY && result.values.length === 0) {
    fail('ready with no values');
  }
  if (
    result.status !== SECTION_STATUS.READY &&
    !nonEmptyString(result.message)
  ) {
    fail('message required when not ready');
  }
  const credit = result.credit;
  if (!credit || !nonEmptyString(credit.text)) fail('credit.text');
  if (!Array.isArray(result.sourceUrls)) fail('sourceUrls');
  if (!result.sourceUrls.every(nonEmptyString)) fail('sourceUrls entry');
  if (
    !nonEmptyString(result.retrievedAt) ||
    Number.isNaN(Date.parse(result.retrievedAt))
  ) {
    fail('retrievedAt');
  }
  if (result.overlays !== undefined) {
    if (!Array.isArray(result.overlays)) fail('overlays');
    result.overlays.forEach((overlay, index) => {
      if (!overlay || !nonEmptyString(overlay.id) || !overlay.geojson) {
        fail(`overlays[${index}]`);
      }
    });
  }
  return result;
}
