// Dossier section "incentives": QCT, DDA and Opportunity Zone status plus LIHTC and public housing within 1 and 3 miles, from the /api/cre/incentives routes.
import {
  buildResult,
  clean,
  isNum,
  note,
  pushValue,
  runRoutes,
} from './location.js';
import { MAP_COLORS } from '../mapColors.js';

export const id = 'incentives';
export const label = 'Incentives and affordable housing';
export const order = 7;

export const INCENTIVES_MESSAGES = Object.freeze({
  unavailable:
    'HUD incentive sources did not answer. Try again in a few minutes.',
  empty: 'No HUD incentive data covers this point.',
});

const OPS = ['zones', 'lihtc', 'publichousing'];
const OP_NAMES = {
  zones: 'HUD QCT, DDA and Opportunity Zone layers',
  lihtc: 'HUD LIHTC database',
  publichousing: 'HUD public housing developments',
};
const ZONE_NAMES = {
  qct: 'HUD Qualified Census Tracts',
  dda: 'HUD Difficult Development Areas',
  oz: 'Opportunity Zones',
};
const SOURCE_URLS = [
  'https://services.arcgis.com/VTyQ9soqVukalItT/arcgis/rest/services/QUALIFIED_CENSUS_TRACTS_2026/FeatureServer/0',
  'https://services.arcgis.com/VTyQ9soqVukalItT/arcgis/rest/services/Difficult_Development_Areas_2026/FeatureServer/0',
  'https://services.arcgis.com/VTyQ9soqVukalItT/arcgis/rest/services/Opportunity_Zones/FeatureServer/13',
  'https://services.arcgis.com/VTyQ9soqVukalItT/arcgis/rest/services/LIHTC/FeatureServer/0',
  'https://services.arcgis.com/VTyQ9soqVukalItT/arcgis/rest/services/Public_Housing_Developments/FeatureServer/0',
];
const CREDIT = {
  // DATA-08: no fixed year in the credit line; each row states its own HUD
  // designation year and the layer's data-update date.
  text: 'US Department of Housing and Urban Development (HUD eGIS: QCT, DDA, Opportunity Zones, LIHTC, Public Housing Developments)',
  url: 'https://hudgis-hud.opendata.arcgis.com/',
  license: 'Public domain (US Government work)',
};

const yesNo = (flag) => (flag ? 'Yes' : 'No');
const hasFeatures = (fc) =>
  fc && Array.isArray(fc.features) && fc.features.length > 0;

// DATA-08: the designation year is the HUD layer-name year, corroborated by
// the layer's data-edit date (HUD publishes year N in the fall of N-1).
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
const monthYear = (iso) =>
  `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
const yearLabel = (name, d) => (d?.year ? `${name} (${d.year})` : name);
/** "HUD 2026 designation, data updated Sep 2025" plus any staleness flags. */
function designationNote(d) {
  if (!d?.year) return null;
  return note(
    `HUD ${d.year} designation, ${d.dataUpdated ? `data updated ${monthYear(d.dataUpdated)}` : 'update date unavailable'}`,
    d.dataMayBeStale
      ? `layer data may be stale (last edited ${d.dataUpdated})`
      : null,
    d.newerYearMayExist
      ? 'a newer HUD designation year may be available'
      : null,
  );
}

function zoneValues(values, zones, failed) {
  for (const key of zones.failed || []) failed.push(ZONE_NAMES[key] || key);
  if (zones.qct) {
    pushValue(
      values,
      yearLabel('Qualified Census Tract', zones.qctDesignation),
      yesNo(zones.qct.inside),
      {
        note: note(
          zones.qct.inside ? note(zones.qct.tract, zones.qct.name) : null,
          designationNote(zones.qctDesignation),
        ),
      },
    );
  }
  if (zones.dda) {
    pushValue(
      values,
      yearLabel('Difficult Development Area', zones.ddaDesignation),
      yesNo(zones.dda.inside),
      {
        note: note(
          zones.dda.inside
            ? note(
                zones.dda.name,
                zones.dda.zcta ? `ZCTA ${zones.dda.zcta}` : null,
              )
            : null,
          designationNote(zones.ddaDesignation),
        ),
      },
    );
  }
  if (zones.oz) {
    pushValue(values, 'Opportunity Zone', yesNo(zones.oz.inside), {
      note: note(
        zones.oz.inside && zones.oz.tract2010
          ? `designated tract ${zones.oz.tract2010}`
          : null,
        'OZ designations use 2010 census tracts',
      ),
    });
  }
}

function ringValues(values, data, names) {
  for (const [ring, miles] of [
    ['oneMi', 1],
    ['threeMi', 3],
  ]) {
    const s = data[ring];
    if (!s || !isNum(s.count)) continue;
    pushValue(values, `${names.count} within ${miles} mi`, s.count, {
      note:
        s.unitsUnknown > 0 ? `${s.unitsUnknown} with units not reported` : null,
    });
    if (s.count > 0 && isNum(s.units)) {
      pushValue(values, `${names.units} within ${miles} mi`, s.units);
    }
  }
  const nearest = Array.isArray(data.nearest) ? data.nearest : [];
  nearest.slice(0, 3).forEach((n, i) => {
    if (!clean(n.name) || !isNum(n.distanceMi)) return;
    pushValue(values, `${names.nearest} ${i + 1}`, n.name, {
      note: note(
        `${n.distanceMi} mi`,
        isNum(n.units) ? `${n.units} units` : null,
        n.address,
      ),
    });
  });
}

/**
 * Build the section module with an injectable fetch (tests, live runs).
 * @param {{fetchImpl?:typeof fetch}} [options]
 */
export function createIncentivesSection({ fetchImpl } = {}) {
  return {
    id,
    label,
    order,
    /** @param {import('../contract.js').SectionContext} ctx @param {{signal?:AbortSignal}} [opts] */
    async load(ctx, { signal, fetchImpl: requestFetch = fetchImpl } = {}) {
      const r = await runRoutes({
        fetchImpl: requestFetch,
        family: 'incentives',
        ops: OPS,
        ctx,
        signal,
      });
      const ready = (op) =>
        r[op].ok && r[op].status === 'ready' ? r[op].data : null;
      const values = [];
      const overlays = [];
      const extraFailed = [];
      const zones = ready('zones');
      if (zones) {
        zoneValues(values, zones, extraFailed);
        if (hasFeatures(zones.geojson)) {
          overlays.push({
            id: 'incentives-zones',
            geojson: zones.geojson,
            style: { stroke: MAP_COLORS.zones, fill: MAP_COLORS.zonesFill },
          });
        }
      }
      const lihtc = ready('lihtc');
      if (lihtc) {
        ringValues(values, lihtc, {
          count: 'Tax credit (LIHTC) properties',
          units: 'Tax credit (LIHTC) units',
          nearest: 'Nearest tax credit (LIHTC) property',
        });
        if (hasFeatures(lihtc.geojson)) {
          overlays.push({
            id: 'incentives-lihtc',
            geojson: lihtc.geojson,
            style: { stroke: MAP_COLORS.lihtc, icon: 'lihtc' },
          });
        }
      }
      const ph = ready('publichousing');
      if (ph) {
        ringValues(values, ph, {
          count: 'Public housing developments',
          units: 'Public housing units',
          nearest: 'Nearest public housing',
        });
        if (hasFeatures(ph.geojson)) {
          overlays.push({
            id: 'incentives-public-housing',
            geojson: ph.geojson,
            style: { stroke: MAP_COLORS.publicHousing, icon: 'public-housing' },
          });
        }
      }
      return buildResult({
        section: { id, label },
        results: r,
        values,
        overlays,
        credit: CREDIT,
        sourceUrls: SOURCE_URLS,
        opNames: OP_NAMES,
        messages: INCENTIVES_MESSAGES,
        extraFailed,
      });
    },
  };
}

export const load = createIncentivesSection().load;
