// Shared money/percent/unit formatting for the dossier tiles, cards and the
// printed report, so a figure never renders as "1,858 USD/month" (wraps
// mid-word in a narrow tile) or "43 %" (extra space) in one place and
// "$1,858/mo" in another. One formatter, one set of unit tests
// (format.test.mjs); no ad hoc formatting left in the render code.

/** Every unit string a section emits for a money figure, mapped to its display suffix. */
const MONEY_UNIT_SUFFIX = Object.freeze({
  $: '',
  USD: '',
  '$/mo': '/mo',
  '$/yr': '/yr',
  'USD/month': '/mo',
  'USD/year': '/yr',
  'USD/week': '/wk',
});

/** True when `unit` is one of the known money-figure unit strings. */
export function isMoneyUnit(unit) {
  return Object.prototype.hasOwnProperty.call(
    MONEY_UNIT_SUFFIX,
    String(unit ?? '').trim(),
  );
}

/**
 * Absolute-value digits for a money or percent figure. Without an explicit
 * `digits` this shows whole dollars (money) or up to 2 decimals without
 * padding (percent) -- never a forced ".0" on a whole number, never a
 * silently truncated ".3".
 */
function absDigits(n, digits, { maximumFractionDigits = 0 } = {}) {
  const opts =
    digits === undefined
      ? { maximumFractionDigits }
      : { minimumFractionDigits: digits, maximumFractionDigits: digits };
  return Math.abs(n).toLocaleString('en-US', opts);
}

/** "$1,858" or "($1,858)" for a negative value. Never a bare minus sign. */
export function formatMoney(value, { digits } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value ?? '');
  const text = `$${absDigits(n, digits)}`;
  return n < 0 ? `(${text})` : text;
}

/** "$1,858/mo" or "($1,858/mo)" for a negative value. */
function formatMoneyWithSuffix(value, suffix, { digits } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value ?? '');
  const text = `$${absDigits(n, digits)}${suffix}`;
  return n < 0 ? `(${text})` : text;
}

/** "43%" or "(43%)" for a negative value. Never a space before the sign. */
export function formatPercent(value, { digits } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value ?? '');
  const text = `${absDigits(n, digits, { maximumFractionDigits: 2 })}%`;
  return n < 0 ? `(${text})` : text;
}

/** "+3.2%", "(1.3%)" or "0%" — for a change figure that must always carry its sign. */
export function formatSignedPercent(value, { digits = 1 } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value ?? '');
  const magnitude = Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  if (n < 0) return `(${magnitude}%)`;
  if (n > 0) return `+${magnitude}%`;
  return `${magnitude}%`;
}

/**
 * The one formatter for a {value, unit} pair everywhere in the dossier: a
 * tile, a card row, or a report table cell. Money units render as "$X",
 * "$X/mo" or "$X/yr"; "%" renders with no space; anything else keeps the
 * existing "value unit" shape (e.g. "412 units", "1.2 mi").
 * @param {number|string} value
 * @param {string} [unit]
 * @param {{digits?:number}} [opts]
 */
export function formatUnitValue(value, unit, opts = {}) {
  const unitKey = String(unit ?? '').trim();
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    const text = String(value ?? '').trim();
    return unitKey ? `${text} ${unitKey}` : text;
  }
  if (unitKey === '%') return formatPercent(value, opts);
  if (Object.prototype.hasOwnProperty.call(MONEY_UNIT_SUFFIX, unitKey)) {
    return formatMoneyWithSuffix(value, MONEY_UNIT_SUFFIX[unitKey], opts);
  }
  const text = value.toLocaleString('en-US', { maximumFractionDigits: 2 });
  return unitKey ? `${text} ${unitKey}` : text;
}

/**
 * A label naming an ACS/Zillow/HUD rent figure that should carry both the
 * monthly and the per-unit annual number, so a reader is never left doing
 * the x12 in their head (and never mistakes the monthly figure alone for the
 * annual one). Excludes the ACS "change" row, which is a percent, not a rent.
 */
const RENT_MONTHLY_LABEL =
  /median gross rent(?!\s*change)|zillow rent|typical asking rent|fair market rent|\bzori\b/i;

export function isRentMonthlyLabel(label) {
  return RENT_MONTHLY_LABEL.test(String(label ?? ''));
}

/**
 * "$1,858/mo ($22,296/yr per unit)" — the annual figure comes from
 * `annualOverride` when the caller has one (the row's own precomputed,
 * unrounded-then-rounded figure), otherwise from the given monthly value
 * times 12, rounded. Passing the row's true unrounded monthly value (or an
 * override) is what makes this exact; passing an already-rounded monthly
 * value is not ($2,079 x 12 rounds to $24,948, not $24,944).
 * @param {number} monthlyValue
 * @param {{annualOverride?:number}} [opts]
 */
export function formatRentMonthlyAnnual(monthlyValue, { annualOverride } = {}) {
  const n = Number(monthlyValue);
  if (!Number.isFinite(n)) return '';
  const monthly = formatMoneyWithSuffix(n, '/mo');
  const annualRaw = Number.isFinite(annualOverride)
    ? Math.round(annualOverride)
    : Math.round(n * 12);
  const annual = formatMoneyWithSuffix(annualRaw, '/yr per unit').replace(
    /^\(|\)$/g,
    '',
  );
  return `${monthly} (${annual})`;
}

/**
 * The full display string for one {label, value, unit, annualPerUnit} row:
 * the rent monthly+annual form when the label and unit both say "this is a
 * monthly rent figure" (preferring the row's own explicit `annualPerUnit`
 * field, computed upstream from the unrounded monthly value before it was
 * rounded for display, when present), the shared unit formatter otherwise.
 * @param {{label?:string, value:number|string, unit?:string, annualPerUnit?:number}} item
 */
export function formatLabeledValue(item) {
  const unitKey = String(item?.unit ?? '').trim();
  if (
    typeof item?.value === 'number' &&
    Number.isFinite(item.value) &&
    isRentMonthlyLabel(item?.label) &&
    (unitKey === '$/mo' || unitKey === 'USD/month')
  ) {
    return formatRentMonthlyAnnual(item.value, {
      annualOverride: item?.annualPerUnit,
    });
  }
  return formatUnitValue(item?.value, item?.unit);
}
