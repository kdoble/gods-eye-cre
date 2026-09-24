// Dossier section "insurance": FEMA National Risk Index expected annual loss to buildings in the site's tract for the perils that drive multifamily insurance, read from /api/cre/insurance/eal; a relative risk signal, never a premium.
import { SECTION_STATUS } from '../contract.js';
import { isNum, runRoutes } from './location.js';

export const id = 'insurance';
export const label = 'Insurance cost signal';
export const order = 4;

/** Exact wording required on this section. */
export const INSURANCE_LABEL =
  'FEMA expected annual loss to buildings in this tract, a relative risk signal, not an insurance premium';

export const INSURANCE_MESSAGES = Object.freeze({
  unavailable:
    'FEMA National Risk Index did not answer. Try again in a few minutes.',
  empty: 'FEMA National Risk Index has no tract record at this point.',
});

const NRI_LAYER =
  'https://services.arcgis.com/XG15cJAlne2vxtgt/arcgis/rest/services/National_Risk_Index_Census_Tracts/FeatureServer/0';
const CREDIT = Object.freeze({
  text: 'FEMA National Risk Index, expected annual loss (census tracts)',
  url: 'https://hazards.fema.gov/nri/',
  license: 'Public domain (US Government work)',
});

const money = (n) => `$${Math.round(n).toLocaleString('en-US')}`;
const pct1 = (n) => Math.round(n * 10) / 10;

function peril(value, rating) {
  if (isNum(value) && value > 0)
    return { value: Math.round(value), unit: '$/yr' };
  if (isNum(value) && value === 0) return { value: 'No modeled loss' };
  if (/^not applicable$/i.test(rating || '')) {
    return { value: 'Not applicable here' };
  }
  if (/insufficient/i.test(rating || '')) {
    return { value: 'Insufficient FEMA data' };
  }
  return { value: 'Not rated by FEMA' };
}

const join = (...parts) => parts.filter(Boolean).join('; ');

/** Section rows from the /api/cre/insurance/eal data. */
export function insuranceRows(data) {
  const source = `FEMA National Risk Index ${data.version || '(version not stated)'}, tract ${data.tract}`;
  const rows = [];
  const c = data.composite || {};
  if (c.ealRating) {
    rows.push({
      label: 'Tract expected annual loss rating, all hazards',
      value: c.ealRating,
      note: join(
        isNum(c.ealPercentile)
          ? `national percentile ${pct1(c.ealPercentile)}`
          : null,
        c.riskRating ? `overall risk index rating ${c.riskRating}` : null,
        source,
      ),
    });
  }
  if (isNum(c.ealBuilding) && c.ealBuilding > 0) {
    const share =
      isNum(data.buildValue) && data.buildValue > 0
        ? `${((c.ealBuilding / data.buildValue) * 100).toFixed(3)}% of ${money(data.buildValue)} tract building value`
        : null;
    rows.push({
      label: 'Expected annual building loss, all hazards',
      value: Math.round(c.ealBuilding),
      unit: '$/yr',
      note: join(
        INSURANCE_LABEL,
        share,
        isNum(c.lossRatePercentile)
          ? `loss rate national percentile ${pct1(c.lossRatePercentile)}`
          : null,
        source,
      ),
    });
  }
  for (const p of data.perils || []) {
    const shown = peril(p.ealBuilding, p.rating);
    const row = {
      label: `${p.name}, expected annual building loss`,
      value: shown.value,
      note: join(
        p.rating ? `rating ${p.rating}` : null,
        isNum(p.percentile)
          ? `national percentile ${pct1(p.percentile)}`
          : null,
        isNum(p.lossRatePercentile)
          ? `loss rate national percentile ${pct1(p.lossRatePercentile)}`
          : null,
        source,
      ),
    };
    if (shown.unit) row.unit = shown.unit;
    rows.push(row);
  }
  return rows;
}

/**
 * @param {{fetchImpl?:typeof fetch}} [options]
 */
export function createInsuranceSection({ fetchImpl } = {}) {
  return {
    id,
    label,
    order,
    /** @param {import('../contract.js').SectionContext} ctx @param {{signal?:AbortSignal, fetchImpl?:typeof fetch}} [opts] */
    async load(ctx, { signal, fetchImpl: requestFetch = fetchImpl } = {}) {
      const r = await runRoutes({
        fetchImpl: requestFetch,
        family: 'insurance',
        ops: ['eal'],
        ctx,
        signal,
      });
      const eal = r.eal;
      const base = {
        id,
        label,
        values: [],
        credit: CREDIT,
        sourceUrls: [NRI_LAYER, CREDIT.url],
        retrievedAt:
          eal.ok && eal.retrievedAt
            ? eal.retrievedAt
            : new Date().toISOString(),
      };
      if (!eal.ok) {
        return {
          ...base,
          status: SECTION_STATUS.UNAVAILABLE,
          message: INSURANCE_MESSAGES.unavailable,
        };
      }
      const values = eal.status === 'ready' ? insuranceRows(eal.data) : [];
      if (!values.length) {
        return {
          ...base,
          status: SECTION_STATUS.EMPTY,
          message: INSURANCE_MESSAGES.empty,
        };
      }
      return {
        ...base,
        status: SECTION_STATUS.READY,
        values,
        message: INSURANCE_LABEL,
      };
    },
  };
}

export const load = createInsuranceSection().load;
