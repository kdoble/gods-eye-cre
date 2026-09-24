// Dossier section "utilities": the electric retail utility serving the point (name and type: IOU, co-op, municipal) and the community water systems whose boundary holds it, from /api/cre/utilities; gas and sewer are stated as not available nationally rather than guessed.
import { SECTION_STATUS } from '../contract.js';
import { isNum, runRoutes } from './location.js';

export const id = 'utilities';
export const label = 'Utility providers';
export const order = 12;

export const UTILITIES_MESSAGES = Object.freeze({
  unavailable:
    'Electric territory and water system sources did not answer. Try again in a few minutes.',
});

const ELECTRIC_LAYER =
  'https://services3.arcgis.com/OYP7N6mAJJCyH6hd/arcgis/rest/services/Electric_Retail_Service_Territories_HIFLD/FeatureServer/0';
const WATER_LAYER =
  'https://services.arcgis.com/cJ9YHowT8TU7DUyn/arcgis/rest/services/Water_System_Boundaries/FeatureServer/0';
const CREDIT = Object.freeze({
  text: 'HIFLD Electric Retail Service Territories (EIA-861), public republished copy, publisher not verified; US EPA Community Water System Service Area Boundaries',
  url: 'https://www.eia.gov/electricity/data/eia861/',
  license: 'Public domain (US Government work)',
});

const fmt = (n) => Math.round(n).toLocaleString('en-US');
const join = (...parts) => parts.filter(Boolean).join('; ');

const NOT_NATIONAL = Object.freeze([
  {
    label: 'Natural gas utility',
    value: 'Not available nationally',
    note: 'No free national gas utility territory layer is live: the HIFLD natural gas service territory layer went offline with HIFLD Open in 2025. Check the state utility commission.',
  },
  {
    label: 'Sewer provider',
    value: 'Not available nationally',
    note: 'No free national sewer service area layer exists; the EPA layer above covers drinking water only. Ask the city or county public works department.',
  },
]);

function electricRows(values, data) {
  const list = data.territories || [];
  list.forEach((t, i) => {
    const suffix = list.length > 1 ? ` ${i + 1}` : '';
    // PROVENANCE: searched live 2026-09-24 for an official DOE, EIA, ORNL,
    // geoplatform.gov or HIFLD's-new-home publisher of this exact layer;
    // none was found. Every ArcGIS Online copy that turned up (this one
    // included, hosted by ArcGIS account "NBAM_Org") is a third-party
    // republish, not a government-run account. Said so plainly rather than
    // implying a verified official source. See DATA_SOURCES.md.
    const source = `HIFLD Electric Retail Service Territories (EIA-861 data year ${t.dataYear || 'not stated'}), public republished copy; publisher not verified${t.sourceDate ? `; source dated ${t.sourceDate}` : ''}`;
    values.push({
      label: `Electric utility${suffix}`,
      value: t.name,
      note: join(
        t.holdingCompany ? `holding company ${t.holdingCompany}` : null,
        isNum(t.customers) ? `${fmt(t.customers)} customers` : null,
        t.eiaId ? `EIA utility ID ${t.eiaId}` : null,
        t.state,
        source,
        'territory lines are approximate; confirm service with the utility',
      ),
    });
    if (t.typeLabel) {
      values.push({
        label: `Electric utility type${suffix}`,
        value: t.typeLabel,
        note: join(`EIA ownership code ${t.type}`, source),
      });
    }
  });
}

function waterRows(values, data) {
  (data.systems || []).forEach((s, i) => {
    values.push({
      label: `Water system ${i + 1}`,
      value: s.name,
      note: join(
        `PWSID ${s.pwsid}`,
        isNum(s.population) ? `serves ${fmt(s.population)} people` : null,
        s.areaType ? s.areaType.toLowerCase() : null,
        s.state,
        `US EPA Community Water System Service Area Boundaries${s.boundarySource ? ` (boundary: ${s.boundarySource.toLowerCase()})` : ''}`,
        'boundaries can overlap; confirm with the utility',
      ),
    });
  });
}

/**
 * @param {{fetchImpl?:typeof fetch}} [options]
 */
export function createUtilitiesSection({ fetchImpl } = {}) {
  return {
    id,
    label,
    order,
    /** @param {import('../contract.js').SectionContext} ctx @param {{signal?:AbortSignal, fetchImpl?:typeof fetch}} [opts] */
    async load(ctx, { signal, fetchImpl: requestFetch = fetchImpl } = {}) {
      const r = await runRoutes({
        fetchImpl: requestFetch,
        family: 'utilities',
        ops: ['electric', 'water'],
        ctx,
        signal,
      });
      const values = [];
      const failed = [];
      if (r.electric.ok && r.electric.status === 'ready') {
        electricRows(values, r.electric.data);
      } else if (r.electric.ok) {
        values.push({
          label: 'Electric utility',
          value: 'No territory found at this point',
          note: 'HIFLD Electric Retail Service Territories (EIA-861), public republished copy, publisher not verified, has no polygon here; confirm with the local utility',
        });
      } else failed.push('HIFLD electric territories');
      if (r.water.ok && r.water.status === 'ready') {
        waterRows(values, r.water.data);
      } else if (r.water.ok) {
        values.push({
          label: 'Water system',
          value: 'No community system boundary here',
          note: 'US EPA Community Water System Service Area Boundaries has no polygon at this point; the site may be on a private well or an unmapped system',
        });
      } else failed.push('EPA water system boundaries');

      const times = [r.electric, r.water]
        .filter((x) => x.ok && x.retrievedAt)
        .map((x) => Date.parse(x.retrievedAt))
        .filter(Number.isFinite);
      const base = {
        id,
        label,
        values: [],
        credit: CREDIT,
        sourceUrls: [ELECTRIC_LAYER, WATER_LAYER],
        retrievedAt: new Date(
          times.length ? Math.min(...times) : Date.now(),
        ).toISOString(),
      };
      if (!values.length) {
        return {
          ...base,
          status: SECTION_STATUS.UNAVAILABLE,
          message: UTILITIES_MESSAGES.unavailable,
        };
      }
      const result = {
        ...base,
        status: SECTION_STATUS.READY,
        values: [...values, ...NOT_NATIONAL],
      };
      if (failed.length) {
        result.message = `Did not answer, try again later: ${failed.join(', ')}.`;
      }
      return result;
    },
  };
}

export const load = createUtilitiesSection().load;
