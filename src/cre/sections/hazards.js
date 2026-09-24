// Dossier section "hazards": FEMA flood zone and SFHA, FEMA National Risk Index, wetlands, EPA sites within 1 mile and seismic design category, from the /api/cre/hazards routes.
import {
  buildResult,
  clean,
  isNum,
  note,
  pushValue,
  runRoutes,
} from './location.js';
import { MAP_COLORS } from '../mapColors.js';

export const id = 'hazards';
export const label = 'Hazards and environmental';
export const order = 2;

export const HAZARDS_MESSAGES = Object.freeze({
  unavailable:
    'Hazard sources (FEMA, USFWS, EPA, USGS) did not answer. Try again in a few minutes.',
  empty: 'No federal hazard data covers this point.',
});

const OPS = ['flood', 'nri', 'wetlands', 'epa', 'seismic'];
// Settle all hazard routes before the dossier controller's 30 second deadline.
export const HAZARDS_ROUTE_DEADLINE_MS = 20_000;
const OP_NAMES = {
  flood: 'FEMA flood map',
  nri: 'FEMA National Risk Index',
  wetlands: 'USFWS wetlands',
  epa: 'EPA facility registry',
  seismic: 'USGS seismic design',
};
const EPA_NAMES = {
  brownfields: 'EPA brownfields (ACRES)',
  superfund: 'EPA Superfund (SEMS)',
  rcra: 'EPA RCRA',
  tri: 'EPA TRI',
};
const SOURCE_URLS = [
  'https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer',
  'https://services.arcgis.com/XG15cJAlne2vxtgt/arcgis/rest/services/National_Risk_Index_Census_Tracts/FeatureServer/0',
  'https://fwspublicservices.wim.usgs.gov/wetlandsmapservice/rest/services/Wetlands/MapServer/0',
  'https://geodata.epa.gov/arcgis/rest/services/OEI/FRS_INTERESTS/MapServer',
  'https://earthquake.usgs.gov/ws/designmaps/asce7-22.json',
];
const CREDIT = {
  text: 'FEMA National Flood Hazard Layer and National Risk Index; USFWS National Wetlands Inventory; US EPA Facility Registry Service; USGS Seismic Design Web Services',
  url: 'https://msc.fema.gov/portal/home',
  license: 'Public domain (US Government work)',
};

/** Flood row labels and notes; the At a glance card reads them. */
export const FLOOD_LABELS = Object.freeze({
  zone: 'FEMA flood zone at site',
  sfha: 'In the 100-year floodplain',
  nearby: 'Worst flood zone within 500 ft',
});
export const FLOOD_NOTES = Object.freeze({
  nearInSfha: 'in the 100-year floodplain (SFHA)',
  nearOutsideSfha: 'outside the 100-year floodplain',
  undetermined:
    'FEMA has not determined the flood hazard here. Zone D is undetermined risk, not low risk, and lenders and insurers price it differently from Zone X',
});

/**
 * Value used in place of Yes/No where FEMA published no determination. Zone D
 * and AREA NOT INCLUDED both carry SFHA_TF = F, which rendered as "outside the
 * 100-year floodplain" and read as an all clear (B-S3-4).
 */
export const FLOOD_SFHA_UNDETERMINED = 'Not determined by FEMA';
export const FLOOD_SFHA_UNKNOWN = 'SFHA status unknown';

const UNDETERMINED_ZONES = new Set(['D', 'AREA NOT INCLUDED']);

/** True when FEMA published no flood determination for this zone. */
export function isFloodUndetermined(zone, subtype) {
  const name = String(zone ?? '')
    .trim()
    .toUpperCase()
    .replace(/^ZONE\s+/, '');
  const sub = String(subtype ?? '')
    .trim()
    .toUpperCase();
  return UNDETERMINED_ZONES.has(name) || UNDETERMINED_ZONES.has(sub);
}

const yesNo = (flag) => (flag ? 'Yes' : 'No');
const hasFeatures = (fc) =>
  fc && Array.isArray(fc.features) && fc.features.length > 0;

function floodValues(values, flood) {
  const site = flood.site;
  if (!site || !clean(site.zone)) return;
  pushValue(values, FLOOD_LABELS.zone, site.zone, {
    note: site.subtype,
  });
  const undetermined = isFloodUndetermined(site.zone, site.subtype);
  pushValue(
    values,
    FLOOD_LABELS.sfha,
    undetermined
      ? FLOOD_SFHA_UNDETERMINED
      : site.sfha === null || site.sfha === undefined
        ? FLOOD_SFHA_UNKNOWN
        : yesNo(site.sfha),
    {
      note: undetermined
        ? FLOOD_NOTES.undetermined
        : site.sfha === null || site.sfha === undefined
          ? 'FEMA SFHA flag missing or unrecognized; status unknown'
          : 'FEMA Special Flood Hazard Area (SFHA), 1% annual chance',
    },
  );
  pushValue(values, 'Base flood elevation', site.bfeFt, { unit: 'ft' });
  const near = flood.nearby;
  if (near && clean(near.zone)) {
    pushValue(values, FLOOD_LABELS.nearby, near.zone, {
      note: note(
        near.subtype,
        isFloodUndetermined(near.zone, near.subtype)
          ? FLOOD_NOTES.undetermined
          : near.sfha === null || near.sfha === undefined
            ? 'FEMA SFHA status unknown for this mapped zone'
            : near.sfha
              ? FLOOD_NOTES.nearInSfha
              : FLOOD_NOTES.nearOutsideSfha,
      ),
    });
  }
  if (flood.panel && clean(flood.panel.id)) {
    pushValue(values, 'FEMA flood map panel (FIRM)', flood.panel.id, {
      // Explicit field straight from FEMA's own panel data, never parsed
      // back out of the note prose below.
      vintage: flood.panel.effective || '',
      note: note(
        flood.panel.effective ? `effective ${flood.panel.effective}` : null,
        flood.panel.type,
        // N-3: this panel was selected by elimination (the sole
        // community-based candidate left in-state), never confirmed
        // against the site's own county -- say so plainly rather than
        // presenting a guess with the same confidence as a real match.
        flood.panelApproximate ? 'panel selection approximate' : null,
      ),
    });
  } else if (
    flood.panelAmbiguous &&
    Array.isArray(flood.panels) &&
    flood.panels.length
  ) {
    // DATA-01: none of the intersecting panels' county FIPS matched the
    // site's county. Naming one anyway risks handing a lender or insurer the
    // wrong governing panel, so every candidate is listed instead of a guess.
    pushValue(
      values,
      'FEMA flood map panels (no county match)',
      flood.panels.map((p) => p.id).join(', '),
      {
        note: 'None of the intersecting FEMA panels could be confirmed as the governing panel for this site’s county. Verify the correct panel with FEMA.',
      },
    );
  }
}

function nriValues(values, nri) {
  pushValue(values, 'Natural hazard risk score', nri.score, {
    unit: 'national percentile',
    note: note(
      'FEMA National Risk Index (NRI); this is a percentile rank among all US census tracts, not a score of 100',
      nri.tract ? `tract ${nri.tract}` : null,
      nri.version ? `NRI ${nri.version}` : null,
    ),
  });
  pushValue(values, 'Natural hazard risk rating', nri.rating, {
    note: 'FEMA National Risk Index (NRI)',
  });
  const top = Array.isArray(nri.topHazards) ? nri.topHazards : [];
  const list = top
    .filter((h) => clean(h.name) && clean(h.rating))
    .map((h) => `${h.name} (${h.rating})`);
  pushValue(values, 'Top natural hazards', list.join(', '), {
    note: 'ranked by FEMA NRI hazard risk score',
  });
  pushValue(values, 'Social vulnerability', nri.socialVulnerability, {
    note: 'FEMA NRI',
  });
  pushValue(values, 'Community resilience', nri.communityResilience, {
    note: 'FEMA NRI',
  });
}

function wetlandValues(values, wet) {
  pushValue(values, 'Wetland mapped at site', yesNo(wet.onSite), {
    note: wet.onSite ? wet.onSiteType : null,
  });
  if (!isNum(wet.count)) return;
  const types = Array.isArray(wet.types)
    ? wet.types.filter((t) => clean(t.type)).map((t) => t.type)
    : [];
  pushValue(values, 'Wetland areas within 500 m', wet.count, {
    note: note(
      wet.count > 0 && isNum(wet.acres)
        ? `${wet.acres} acres inside the 500 m circle${isNum(wet.circleAcres) ? ` (circle is ${wet.circleAcres} acres)` : ''}`
        : null,
      types.slice(0, 3).join(', '),
      wet.truncated ? 'list truncated by the service' : null,
    ),
  });
}

function epaValues(values, epa, failed) {
  const programs = epa.programs || {};
  for (const [key, name] of Object.entries(EPA_NAMES)) {
    const p = programs[key];
    if (!p) {
      if ((epa.failed || []).includes(key)) failed.push(name);
      continue;
    }
    if (!isNum(p.count)) continue;
    pushValue(values, `${p.label || name} within 1 mi`, p.count, {
      note:
        p.nearest && clean(p.nearest.name) && isNum(p.nearest.distanceMi)
          ? `nearest ${p.nearest.name}, ${p.nearest.distanceMi} mi`
          : null,
    });
  }
}

function seismicValues(values, s) {
  pushValue(values, 'Seismic design category', s.sdc, {
    note: note(
      `${s.code || 'ASCE 7-22'}, Risk Category ${s.riskCategory || 'II'}, Site Class ${s.siteClass || 'D'} (default)`,
      isNum(s.ss) ? `Ss ${s.ss} g` : null,
      isNum(s.s1) ? `S1 ${s.s1} g` : null,
    ),
  });
}

/**
 * Build the section module with an injectable fetch (tests, live runs).
 * @param {{fetchImpl?:typeof fetch}} [options]
 */
export function createHazardsSection({
  fetchImpl,
  routeDeadlineMs = HAZARDS_ROUTE_DEADLINE_MS,
} = {}) {
  return {
    id,
    label,
    order,
    /** @param {import('../contract.js').SectionContext} ctx @param {{signal?:AbortSignal}} [opts] */
    async load(ctx, { signal, fetchImpl: requestFetch = fetchImpl } = {}) {
      const mapRadiusM =
        ([1, 3, 5].includes(ctx.radiusMiles) ? ctx.radiusMiles : 1) * 1609.344;
      const request = (url, init) => {
        const address = String(url);
        const bounded = {
          ...init,
          signal: AbortSignal.any([
            init?.signal || new AbortController().signal,
            AbortSignal.timeout(routeDeadlineMs),
          ]),
        };
        if (!address.startsWith('/api/cre/hazards/flood?'))
          return (requestFetch || globalThis.fetch)(url, bounded);
        const parsed = new URL(address, 'http://cre.local');
        parsed.searchParams.set('radiusM', String(mapRadiusM));
        return (requestFetch || globalThis.fetch)(
          `${parsed.pathname}${parsed.search}`,
          bounded,
        );
      };
      const r = await runRoutes({
        fetchImpl: request,
        family: 'hazards',
        ops: OPS,
        ctx,
        signal,
      });
      const ready = (op) =>
        r[op].ok && r[op].status === 'ready' ? r[op].data : null;
      const values = [];
      const overlays = [];
      const extraFailed = [];
      const flood = ready('flood');
      if (flood) {
        floodValues(values, flood);
        if (flood.partial)
          values.push({
            label: 'FEMA flood supporting coverage',
            value: 'Partial',
            note: 'The exact site zone is available. A nearby-zone, map-panel, or polygon query was incomplete, or multiple map panels intersect the point. Review the official FEMA map for parcel-level decisions.',
            status: 'partial',
            partial: true,
            sourceUrls: [SOURCE_URLS[0]],
          });
        values.push({
          label: `FEMA flood polygons in selected ${Math.round(mapRadiusM / 1609.344)} mi map area`,
          value:
            flood.mapStatus === 'unavailable'
              ? 'Map geometry unavailable'
              : flood.mapFeatureCount || 0,
          note: `SFHA polygons intersecting the selected map area; ${flood.mapStatus || 'status unknown'}. Geometry is simplified for display and may extend beyond the ring. Site zone uses an unsimplified point query.${flood.mapStatus === 'partial' ? ' FEMA capped the polygon result.' : ''}`,
          status: flood.mapStatus,
          partial: ['partial', 'unavailable'].includes(flood.mapStatus),
          sourceUrls: [SOURCE_URLS[0]],
        });
        if (hasFeatures(flood.sfhaGeojson)) {
          overlays.push({
            id: 'hazards-sfha',
            geojson: flood.sfhaGeojson,
            style: { stroke: MAP_COLORS.flood, fill: MAP_COLORS.floodFill },
          });
        }
      } else if (
        !r.flood.ok &&
        Object.entries(r).some(
          ([op, item]) => op !== 'flood' && item.ok && item.status === 'ready',
        )
      ) {
        values.push({
          label: 'FEMA flood coverage',
          value: 'Could not verify the flood zone',
          note: 'FEMA source did not answer. Other hazard findings do not resolve this flood-data gap.',
          status: 'unavailable',
          partial: true,
          sourceUrls: [SOURCE_URLS[0]],
        });
      }
      const nri = ready('nri');
      if (nri) nriValues(values, nri);
      const wet = ready('wetlands');
      if (wet) {
        wetlandValues(values, wet);
        if (hasFeatures(wet.geojson)) {
          overlays.push({
            id: 'hazards-wetlands',
            geojson: wet.geojson,
            style: { stroke: MAP_COLORS.wetland, fill: MAP_COLORS.wetlandFill },
          });
        }
      }
      const epa = ready('epa');
      if (epa) {
        epaValues(values, epa, extraFailed);
        if (hasFeatures(epa.geojson)) {
          overlays.push({
            id: 'hazards-epa-sites',
            geojson: epa.geojson,
            style: { stroke: MAP_COLORS.epa, icon: 'hazard' },
          });
        }
      }
      const seismic = ready('seismic');
      if (seismic) seismicValues(values, seismic);
      const result = buildResult({
        section: { id, label },
        results: r,
        values,
        overlays,
        credit: CREDIT,
        sourceUrls: SOURCE_URLS,
        opNames: OP_NAMES,
        messages: HAZARDS_MESSAGES,
        extraFailed,
      });
      if (
        result.status === 'ready' &&
        (!r.flood.ok ||
          r.flood.status === 'empty' ||
          flood?.partial ||
          flood?.mapStatus === 'partial' ||
          flood?.mapStatus === 'unavailable' ||
          flood?.panelAmbiguous)
      )
        result.status = 'partial';
      if (result.status === 'partial' && !result.message) {
        result.message = flood?.panelAmbiguous
          ? 'Multiple FEMA map panels intersect this point; verify the governing effective panel with FEMA.'
          : flood?.partial
            ? 'FEMA supporting flood coverage is incomplete; the exact site-zone observation remains available.'
            : 'FEMA flood coverage is incomplete for this point.';
      }
      result.evidence = {
        flood: flood?.sourceMetadata || null,
        floodMapStatus:
          flood?.mapStatus || (r.flood.ok ? r.flood.status : 'unavailable'),
        floodMapRadiusM: flood?.mapRadiusM || mapRadiusM,
        floodMapFeatureCount: flood?.mapFeatureCount ?? null,
        floodPanelCount: flood?.panelCount ?? null,
      };
      if (
        r.flood.ok &&
        r.flood.status === 'empty' &&
        result.status === 'partial'
      ) {
        const gap = 'FEMA has no effective flood map at this point.';
        result.message = result.message ? `${gap} ${result.message}` : gap;
      }
      return result;
    },
  };
}

export const load = createHazardsSection().load;
