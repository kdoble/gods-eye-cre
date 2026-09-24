// Dossier section "location": county, tract, place, ground elevation and slope, soils, watershed and walkability for the site, from the /api/cre/site routes; also the shared route runner the WP3 sections use.
import { SECTION_STATUS } from '../contract.js';
import { stripLsad } from '../labels.js';

const PUBLIC_DOMAIN = 'Public domain (US Government work)';
const ROUTE_TIMEOUT_MS = 25_000;

/**
 * Call several /api/cre/<family>/<op> routes in parallel. Each op settles to
 * { ok:true, status, data, retrievedAt } or { ok:false }; upstream error text
 * never leaves this function.
 * @param {{fetchImpl?:typeof fetch, family:string, ops:string[], ctx:{lat:number, lon:number}, signal?:AbortSignal}} options
 * @returns {Promise<Record<string, {ok:boolean, status?:string, data?:any, retrievedAt?:string}>>}
 */
export async function runRoutes({ fetchImpl, family, ops, ctx, signal }) {
  const doFetch = fetchImpl || ((...args) => globalThis.fetch(...args));
  const query = new URLSearchParams({
    lat: String(ctx.lat),
    lon: String(ctx.lon),
  });
  const settled = await Promise.all(
    ops.map(async (op) => {
      const timeout = AbortSignal.timeout(ROUTE_TIMEOUT_MS);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      try {
        const response = await doFetch(`/api/cre/${family}/${op}?${query}`, {
          signal: combined,
          headers: { Accept: 'application/json' },
        });
        if (!response.ok) return [op, { ok: false }];
        const body = await response.json();
        if (
          !body ||
          (body.status !== 'ready' && body.status !== 'empty') ||
          typeof body.data !== 'object'
        ) {
          return [op, { ok: false }];
        }
        return [
          op,
          {
            ok: true,
            status: body.status,
            data: body.data || {},
            retrievedAt: body.retrievedAt,
          },
        ];
      } catch {
        return [op, { ok: false }];
      }
    }),
  );
  if (signal?.aborted) {
    throw new DOMException('Section load aborted', 'AbortError');
  }
  return Object.fromEntries(settled);
}

/** Trimmed non-empty string, else null. */
export function clean(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** True for a finite number. */
export const isNum = (value) =>
  typeof value === 'number' && Number.isFinite(value);

/**
 * Push a value only when it is real: finite numbers and non-empty strings.
 * @param {Array} values
 * @param {string} label
 * @param {unknown} value
 * @param {{unit?:string, note?:string|null}} [extra]
 */
export function pushValue(values, label, value, extra = {}) {
  const real = isNum(value) || clean(/** @type {any} */ (value)) !== null;
  if (!real) return;
  const item = {
    label,
    value: typeof value === 'string' ? value.trim() : value,
  };
  if (extra.unit) item.unit = extra.unit;
  if (clean(extra.note)) item.note = extra.note.trim();
  values.push(item);
}

/** Join the real parts of a note with "; ". */
export function note(...parts) {
  const kept = parts.filter((p) => clean(p) !== null);
  return kept.length ? kept.join('; ') : null;
}

/** Oldest retrievedAt among successful ops, else now. */
function oldestRetrieved(results) {
  const times = Object.values(results)
    .filter(
      (r) => r.ok && r.retrievedAt && !Number.isNaN(Date.parse(r.retrievedAt)),
    )
    .map((r) => Date.parse(r.retrievedAt));
  const at = times.length ? Math.min(...times) : Date.now();
  return new Date(at).toISOString();
}

/**
 * Assemble a SectionResult. Ready when any real value came back; otherwise
 * unavailable when every op failed, else empty. Messages are fixed text.
 * @param {object} args
 * @param {{id:string, label:string}} args.section
 * @param {Record<string, {ok:boolean}>} args.results
 * @param {Array} args.values
 * @param {Array} [args.overlays]
 * @param {{text:string, url:string, license:string}} args.credit
 * @param {string[]} args.sourceUrls
 * @param {Record<string,string>} args.opNames - Op id to display name.
 * @param {{unavailable:string, empty:string}} args.messages
 * @param {string[]} [args.extraFailed] - Display names of failed sub-sources.
 */
export function buildResult({
  section,
  results,
  values,
  overlays = [],
  credit,
  sourceUrls,
  opNames,
  messages,
  extraFailed = [],
}) {
  const failed = [
    ...Object.entries(results)
      .filter(([, r]) => !r.ok)
      .map(([op]) => opNames[op] || op),
    ...extraFailed,
  ];
  const base = {
    id: section.id,
    label: section.label,
    values: [],
    credit,
    sourceUrls,
    retrievedAt: oldestRetrieved(results),
  };
  if (values.length > 0) {
    const result = { ...base, status: SECTION_STATUS.READY, values };
    if (overlays.length) result.overlays = overlays;
    if (failed.length) {
      result.message = `Did not answer, try again later: ${failed.join(', ')}.`;
    }
    return result;
  }
  const allFailed = Object.values(results).every((r) => !r.ok);
  return allFailed
    ? {
        ...base,
        status: SECTION_STATUS.UNAVAILABLE,
        message: messages.unavailable,
      }
    : { ...base, status: SECTION_STATUS.EMPTY, message: messages.empty };
}

export const id = 'location';
export const label = 'Location and site';
export const order = 1;

export const LOCATION_MESSAGES = Object.freeze({
  unavailable:
    'Site data sources (Census, USGS, USDA, EPA) did not answer. Try again in a few minutes.',
  empty: 'No federal site data covers this point.',
});

const OPS = ['geography', 'elevation', 'soils', 'watershed', 'walkability'];
const OP_NAMES = {
  geography: 'Census geography',
  elevation: 'USGS elevation',
  soils: 'USDA soils',
  watershed: 'USGS watershed',
  walkability: 'EPA walkability',
};
const SOURCE_URLS = [
  'https://geocoding.geo.census.gov/geocoder/geographies/coordinates',
  'https://epqs.nationalmap.gov/v1/json',
  'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer',
  'https://sdmdataaccess.sc.egov.usda.gov/Tabular/post.rest',
  'https://hydro.nationalmap.gov/arcgis/rest/services/wbd/MapServer/6',
  'https://geodata.epa.gov/arcgis/rest/services/OA/WalkabilityIndex/MapServer/0',
];
const CREDIT = {
  text: 'US Census Bureau; USGS 3DEP and Watershed Boundary Dataset; USDA NRCS SSURGO; US EPA Smart Location Walkability Index',
  url: 'https://www.usgs.gov/3d-elevation-program',
  license: PUBLIC_DOMAIN,
};

/** @param {Record<string, any>} r @param {import('../contract.js').SectionContext} ctx */
function locationValues(r, ctx) {
  const values = [];
  const geo =
    r.geography.ok && r.geography.status === 'ready' ? r.geography.data : null;
  const elev =
    r.elevation.ok && r.elevation.status === 'ready' ? r.elevation.data : null;
  const soils = r.soils.ok && r.soils.status === 'ready' ? r.soils.data : null;
  const shed =
    r.watershed.ok && r.watershed.status === 'ready' ? r.watershed.data : null;
  const walk =
    r.walkability.ok && r.walkability.status === 'ready'
      ? r.walkability.data
      : null;

  if (geo) {
    const county = clean(geo.county);
    const st = clean(geo.stateAbbr) || clean(geo.state);
    pushValue(values, 'County', county && st ? `${county}, ${st}` : county, {
      note: geo.countyGeoid ? `FIPS ${geo.countyGeoid}` : null,
    });
    // Display name without the Census suffix; the raw TIGER name rides along
    // in `raw`, which the JSON export keeps.
    const place = clean(geo.place);
    if (place) {
      const item = { label: 'City or place', value: stripLsad(place) };
      if (item.value !== place) item.raw = place;
      values.push(item);
    }
    pushValue(values, 'Census tract', geo.tractGeoid, { note: geo.tractName });
  } else {
    pushValue(values, 'County', ctx.county, { note: 'from the address match' });
    pushValue(values, 'Census tract', ctx.tractGeoid, {
      note: 'from the address match',
    });
  }
  if (elev) {
    pushValue(
      values,
      'Ground elevation',
      isNum(elev.elevationFt) ? Math.round(elev.elevationFt) : null,
      { unit: 'ft', note: elev.elevationMethod },
    );
    pushValue(values, 'Ground slope', elev.slopeDeg, {
      unit: 'degrees',
      note: 'USGS 3DEP, 10 m cells',
    });
  }
  if (soils) {
    pushValue(values, 'Soil map unit', soils.mapUnit, {
      note: soils.mukey
        ? `USDA soil survey (SSURGO) map unit key ${soils.mukey}`
        : null,
    });
    const top = Array.isArray(soils.components) ? soils.components[0] : null;
    if (top && clean(top.name)) {
      pushValue(
        values,
        'Dominant soil component',
        isNum(top.pct) ? `${top.name} (${top.pct}%)` : top.name,
        {
          note: note(
            isNum(top.slopePct)
              ? `representative slope ${top.slopePct}%`
              : null,
            top.drainage,
            top.hydric ? `hydric: ${top.hydric}` : null,
            top.hydGroup ? `hydrologic group ${top.hydGroup}` : null,
          ),
        },
      );
    }
  }
  if (shed) {
    pushValue(values, 'Watershed', shed.name, {
      note: shed.huc12 ? `USGS watershed code (HUC12) ${shed.huc12}` : null,
    });
  }
  if (walk) {
    pushValue(values, 'EPA walkability index', walk.index, {
      unit: 'of 20',
      note: note(
        walk.band,
        walk.blockGroup ? `block group ${walk.blockGroup}` : null,
      ),
    });
  }
  if (values.length === 0) return values;
  const head = [];
  pushValue(head, 'Matched address', ctx.address);
  pushValue(
    head,
    'Coordinates',
    `${ctx.lat.toFixed(6)}, ${ctx.lon.toFixed(6)}`,
    {
      note: 'WGS84 latitude, longitude',
    },
  );
  return [...head, ...values];
}

/**
 * Build the section module with an injectable fetch (tests, live runs).
 * @param {{fetchImpl?:typeof fetch}} [options]
 */
export function createLocationSection({ fetchImpl } = {}) {
  return {
    id,
    label,
    order,
    /** @param {import('../contract.js').SectionContext} ctx @param {{signal?:AbortSignal}} [opts] */
    async load(ctx, { signal, fetchImpl: requestFetch = fetchImpl } = {}) {
      const results = await runRoutes({
        fetchImpl: requestFetch,
        family: 'site',
        ops: OPS,
        ctx,
        signal,
      });
      return buildResult({
        section: { id, label },
        results,
        values: locationValues(results, ctx),
        credit: CREDIT,
        sourceUrls: SOURCE_URLS,
        opNames: OP_NAMES,
        messages: LOCATION_MESSAGES,
      });
    },
  };
}

export const load = createLocationSection().load;
