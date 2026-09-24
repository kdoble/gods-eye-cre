// Dossier section "lihtc-limits": HUD MTSP 50 and 60 percent income limits (1 to 4 persons) and LIHTC max gross rents (0BR to 3BR), annual with monthly shown, for the site's county, from /api/cre/lihtc-limits/mtsp. Needs a free HUD_API_TOKEN; without it the section says so and links the signup page.
import { SECTION_STATUS } from '../contract.js';

export const id = 'lihtc-limits';
export const label = 'LIHTC rent and income limits';
export const order = 8;

const HUD_SIGNUP_URL = 'https://www.huduser.gov/portal/dataset/fmr-api.html';
const MTSP_PAGE = 'https://www.huduser.gov/portal/datasets/mtsp.html';

export const LIHTC_LIMITS_MESSAGES = Object.freeze({
  needsKey:
    'HUD MTSP income and rent limits need a free HUD_API_TOKEN from HUD USER; add it in POWER UP.',
  unavailable: 'HUD USER API did not answer. Try again in a few minutes.',
  empty: 'No county found for this point, so no HUD MTSP area applies.',
});

const CREDIT = Object.freeze({
  text: 'HUD Multifamily Tax Subsidy Project (MTSP) income limits, HUD USER API',
  url: MTSP_PAGE,
  license: 'Public domain (US Government work)',
});

const dollars = (n) => `$${Math.round(n).toLocaleString('en-US')}`;
const cents = (n) =>
  `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const BEDROOMS = Object.freeze([
  ['studio', '0BR (studio)', '1 person'],
  ['oneBr', '1BR', '1.5 persons'],
  ['twoBr', '2BR', '3 persons'],
  ['threeBr', '3BR', '4.5 persons'],
]);

/** Section rows from the ready route data. */
export function lihtcRows(data) {
  const source = `HUD Multifamily Tax Subsidy Project (MTSP) limits, FY${data.year ?? 'year not stated'}, ${data.areaName || `county ${data.countyFips}`}`;
  const rows = [];
  for (const tier of [50, 60]) {
    const limits = data.limits?.[tier] || [];
    for (let n = 1; n <= 4; n += 1) {
      const annual = limits[n - 1];
      if (typeof annual !== 'number' || !(annual > 0)) continue;
      rows.push({
        label: `LIHTC income limit, ${tier}% AMI, ${n} ${n === 1 ? 'person' : 'persons'}`,
        value: annual,
        unit: '$/yr',
        note: `${cents(Math.round((annual / 12) * 100) / 100)} per month; ${source}`,
      });
    }
  }
  for (const tier of [50, 60]) {
    const rents = data.rents?.[tier] || {};
    for (const [key, name, size] of BEDROOMS) {
      const monthly = rents[key];
      if (typeof monthly !== 'number' || !(monthly > 0)) continue;
      rows.push({
        label: `Max gross LIHTC rent, ${tier}% AMI, ${name}`,
        value: monthly * 12,
        unit: '$/yr',
        note: `${dollars(monthly)} per month; gross rent, tenant-paid utility allowance comes out of it; 30% of the ${tier}% limit at ${size}, rounded down; ${source}`,
      });
    }
  }
  return rows;
}

async function getRoute(url, { signal, fetchImpl }) {
  const doFetch = fetchImpl || ((...args) => globalThis.fetch(...args));
  try {
    const response = await doFetch(url, {
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
 * @param {{fetchImpl?:typeof fetch}} [options]
 */
export function createLihtcLimitsSection({ fetchImpl } = {}) {
  return {
    id,
    label,
    order,
    /** @param {import('../contract.js').SectionContext} ctx @param {{signal?:AbortSignal, fetchImpl?:typeof fetch}} [opts] */
    async load(ctx, { signal, fetchImpl: requestFetch = fetchImpl } = {}) {
      const reply = await getRoute(
        `/api/cre/lihtc-limits/mtsp?lat=${ctx.lat}&lon=${ctx.lon}`,
        { signal, fetchImpl: requestFetch },
      );
      const body = reply.ok ? reply.body : null;
      const base = {
        id,
        label,
        values: [],
        credit: CREDIT,
        sourceUrls: [MTSP_PAGE],
        retrievedAt:
          body && !Number.isNaN(Date.parse(body.retrievedAt))
            ? body.retrievedAt
            : new Date().toISOString(),
      };
      if (body?.status === 'needs-key') {
        return {
          ...base,
          status: SECTION_STATUS.NEEDS_KEY,
          message: LIHTC_LIMITS_MESSAGES.needsKey,
          sourceUrls: [HUD_SIGNUP_URL, MTSP_PAGE],
          values: [
            {
              label: 'HUD LIHTC income and rent limits (MTSP)',
              value: 'Needs HUD key',
              note: `Free HUD USER API token. Sign up at ${HUD_SIGNUP_URL}, then set HUD_API_TOKEN.`,
              sourceUrls: [HUD_SIGNUP_URL],
            },
          ],
        };
      }
      if (!body || (body.status !== 'ready' && body.status !== 'empty')) {
        return {
          ...base,
          status: SECTION_STATUS.UNAVAILABLE,
          message: LIHTC_LIMITS_MESSAGES.unavailable,
        };
      }
      const values = body.status === 'ready' ? lihtcRows(body.data || {}) : [];
      if (!values.length) {
        return {
          ...base,
          status: SECTION_STATUS.EMPTY,
          message: LIHTC_LIMITS_MESSAGES.empty,
        };
      }
      return { ...base, status: SECTION_STATUS.READY, values };
    },
  };
}

export const load = createLihtcLimitsSection().load;
