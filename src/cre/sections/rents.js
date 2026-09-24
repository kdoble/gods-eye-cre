// Dossier section "rents": Zillow ZORI for the site ZIP (latest, 12 and 36 month change) and HUD FMR or Small Area FMR by bedroom when HUD_API_TOKEN is configured, read from /api/cre/rents so no key or CORS issue reaches the browser.
import { SECTION_STATUS } from '../contract.js';

const CREDIT = Object.freeze({
  text: 'Zillow Observed Rent Index (ZORI), Zillow Group; HUD Fair Market Rents',
  url: 'https://www.zillow.com/research/data/',
  license:
    'Zillow Research data, free with attribution; HUD data public domain',
});
const HUD_URL = 'https://www.huduser.gov/portal/datasets/fmr.html';

/** Fixed section messages. */
export const RENTS_MESSAGES = Object.freeze({
  UNAVAILABLE: 'Zillow ZORI did not answer.',
  NO_ZIP: 'No ZIP code found for this point.',
  NO_ZORI: (zip) => `Zillow publishes no ZORI series for ZIP ${zip}.`,
  FMR_NEEDS_KEY:
    'HUD FMR and Small Area FMR need a free HUD_API_TOKEN (huduser.gov); add it in POWER UP.',
  FMR_UNAVAILABLE: 'HUD FMR API did not answer.',
  ZORI_UNAVAILABLE: 'Zillow ZORI did not answer.',
});

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];
const monthLabel = (iso) =>
  `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
// DATA-10/DATA-05: ZORI and FMR carry no cents of real precision; two decimal
// places read as an accuracy neither index nor survey actually has.
const money = (n) =>
  `$${Math.round(n).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;

/** DATA-05: what an HUD FMR actually is, verbatim, next to every figure. */
export const FMR_DEFINITION =
  'HUD Fair Market Rent: 40th percentile gross rent including utilities, used for voucher payment standards; not a market rent';

/** Label of the Zillow 12-month change row; the At a glance card reads it. */
export const ZORI_CHANGE_12M_LABEL = 'Zillow rent, 12-month change';

/**
 * ZORI value rows. Changes the file cannot support are left out, not zeroed.
 * @param {object} zori - zoriForZip output.
 */
export function zoriRows(zori) {
  const rows = [
    {
      label: `Zillow rent index (ZORI), ZIP ${zori.zip}, ${monthLabel(zori.latest.date)}`,
      value: Math.round(zori.latest.value),
      unit: '$/mo',
      // DATA-11: annualize from the unrounded index, then round for
      // display. Rounding to whole dollars first and multiplying by 12
      // compounds the rounding error (e.g. $2,079 x 12 = $24,948 vs the
      // correct $2,078.65 x 12 = $24,943.80, which rounds to $24,944).
      annualPerUnit: Math.round(zori.latest.value * 12),
      observationDate: zori.latest.date,
      vintage: monthLabel(zori.latest.date),
      note: `${money(zori.latest.value * 12)} per unit per year; smoothed typical asking rent, all homes plus multifamily`,
    },
  ];
  if (zori.change12mPct !== null && zori.change12mPct !== undefined) {
    rows.push({
      label: ZORI_CHANGE_12M_LABEL,
      value: zori.change12mPct,
      unit: '%',
      note: `From ${money(zori.value12MonthsAgo)} a year earlier`,
    });
  }
  if (zori.change36mPct !== null && zori.change36mPct !== undefined) {
    rows.push({
      label: 'Zillow rent, 36-month change',
      value: zori.change36mPct,
      unit: '%',
      note: `From ${money(zori.value36MonthsAgo)} three years earlier`,
    });
  }
  return rows;
}

/** HUD FMR rows for 1, 2 and 3 bedrooms. */
export function fmrRows(fmr) {
  const where = fmr.smallArea
    ? `Small Area FMR, ZIP ${fmr.zip}`
    : `FMR area ${fmr.areaName}`;
  const year = fmr.year ? `FY${fmr.year}` : 'current year';
  // DATA-06: the parser's field-shape assumptions are only as good as the
  // last live response that actually confirmed them; a build with no
  // HUD_API_TOKEN this session (server sets liveVerified) cannot claim that.
  const verification = fmr.liveVerified
    ? ''
    : ' This parser has not been verified against a live HUD API response this session (no HUD_API_TOKEN); values are parsed but unconfirmed.';
  return [
    ['oneBr', '1BR'],
    ['twoBr', '2BR'],
    ['threeBr', '3BR'],
  ]
    .filter(([key]) => Number.isFinite(fmr.rents?.[key]))
    .map(([key, name]) => ({
      label: `HUD Fair Market Rent (FMR), ${name}`,
      value: fmr.rents[key],
      unit: '$/mo',
      annualPerUnit: Math.round(fmr.rents[key] * 12),
      vintage: year,
      note: `${FMR_DEFINITION}. ${where}, ${year}; ${money(fmr.rents[key] * 12)} per unit per year.${verification}`,
    }));
}

async function getRoute(url, { signal, fetchImpl = globalThis.fetch }) {
  try {
    const response = await fetchImpl(url, {
      signal,
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return { ok: false };
    return { ok: true, body: await response.json() };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { ok: false };
  }
}

/**
 * @param {import('../contract.js').SectionContext} ctx
 * @param {{signal?: AbortSignal, fetchImpl?: typeof fetch}} [options]
 * @returns {Promise<import('../contract.js').SectionResult>}
 */
export async function loadRentsSection(ctx, options = {}) {
  const zip = /^\d{5}$/.test(String(ctx.zip || '')) ? `&zip=${ctx.zip}` : '';
  const reply = await getRoute(
    `/api/cre/rents?lat=${ctx.lat}&lon=${ctx.lon}${zip}`,
    options,
  );
  const base = {
    id: 'rents',
    label: 'Rents',
    credit: CREDIT,
    sourceUrls: [CREDIT.url],
    retrievedAt: reply.body?.retrievedAt || new Date().toISOString(),
  };
  const data = reply.ok ? reply.body?.data : null;
  if (!data) {
    return {
      ...base,
      status: SECTION_STATUS.UNAVAILABLE,
      values: [],
      message: RENTS_MESSAGES.UNAVAILABLE,
    };
  }
  const values = [];
  const notes = [];
  let rentsChart = null;
  if (data.zoriStatus === 'ready' && data.zori) {
    values.push(...zoriRows(data.zori));
    if (Array.isArray(data.zori.history) && data.zori.history.length) {
      rentsChart = {
        zip: data.zori.zip,
        history: data.zori.history,
        latest: data.zori.latest,
        change12mPct: data.zori.change12mPct,
        change36mPct: data.zori.change36mPct,
      };
    }
    base.retrievedAt =
      [reply.body.retrievedAt, data.zoriRetrievedAt]
        .filter((date) => Number.isFinite(Date.parse(date)))
        .sort((a, b) => Date.parse(a) - Date.parse(b))[0] || base.retrievedAt;
  } else if (data.zoriStatus === 'unavailable') {
    notes.push(RENTS_MESSAGES.ZORI_UNAVAILABLE);
  } else if (!data.zip) {
    notes.push(RENTS_MESSAGES.NO_ZIP);
  } else {
    notes.push(RENTS_MESSAGES.NO_ZORI(data.zip));
  }
  const fmr = data.fmr || {};
  if (fmr.status === 'ready') {
    values.push(...fmrRows(fmr));
    base.sourceUrls.push(HUD_URL);
  } else if (fmr.status === 'needs-key') {
    notes.push(RENTS_MESSAGES.FMR_NEEDS_KEY);
  } else if (fmr.status === 'unavailable') {
    notes.push(RENTS_MESSAGES.FMR_UNAVAILABLE);
  }
  let status = SECTION_STATUS.READY;
  if (!values.length) {
    if (fmr.status === 'needs-key') status = SECTION_STATUS.NEEDS_KEY;
    else if (data.zoriStatus === 'unavailable') {
      status = SECTION_STATUS.UNAVAILABLE;
    } else status = SECTION_STATUS.EMPTY;
  }
  const result = { ...base, status, values };
  if (notes.length) result.message = notes.join(' ');
  if (rentsChart) result.rentsChart = rentsChart;
  return result;
}

/** @type {import('../contract.js').SectionModule} */
export const rentsSection = Object.freeze({
  id: 'rents',
  label: 'Rents',
  order: 9,
  load: loadRentsSection,
});
