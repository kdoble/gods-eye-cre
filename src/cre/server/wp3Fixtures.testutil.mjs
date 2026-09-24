// Shared fixtures and fakes for the WP3 route and section tests (not a test file, so importing it registers nothing).

export const TIMING = Object.freeze({
  timeoutMs: 30,
  retries: 0,
  backoffMs: 1,
  sleep: async () => {},
});
export const SECRET = 'UPSTREAM SECRET TEXT';
export const TEST_POINT = 'lat=36.320692&lon=-82.342509';

export const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

export const ARCGIS_400 = {
  error: { code: 400, message: SECRET, details: [SECRET] },
};

/**
 * A fetch that never answers until its signal aborts. AbortSignal.timeout
 * timers are unref'd, so a ref'd keep-alive holds the event loop open.
 */
export const hangingFetch = (url, init) =>
  new Promise((_, reject) => {
    const keepAlive = setTimeout(() => {}, 5000);
    init.signal.addEventListener('abort', () => {
      clearTimeout(keepAlive);
      reject(new DOMException('timed out', 'TimeoutError'));
    });
  });

export function fakeRes() {
  return {
    status: 0,
    body: '',
    headersSent: false,
    writeHead(status) {
      this.status = status;
      this.headersSent = true;
    },
    end(body = '') {
      this.body = body;
    },
    json() {
      return JSON.parse(this.body);
    },
  };
}

export async function call(handler, query = TEST_POINT) {
  const res = fakeRes();
  await handler(
    {
      url: `/?${query}`,
      method: 'GET',
      socket: { remoteAddress: '127.0.0.1' },
    },
    res,
  );
  return res;
}

export const SITE_FIXTURES = {
  census: {
    result: {
      geographies: {
        'Census Tracts': [
          { GEOID: '47179060902', NAME: 'Census Tract 609.02' },
        ],
        Counties: [{ NAME: 'Washington County', GEOID: '47179' }],
        States: [{ NAME: 'Tennessee', STUSAB: 'TN' }],
        'Incorporated Places': [{ NAME: 'Johnson City city' }],
      },
    },
  },
  epqs: { value: 1649.6635824742723 },
  slope: { value: '4' },
  identify: { value: '502.817' },
  sda: {
    Table: [
      [
        'mukey',
        'muname',
        'compname',
        'comppct_r',
        'slope_r',
        'hydricrating',
        'drainagecl',
        'hydgrp',
      ],
      ['1690201', 'Urban land', 'Urban land', '90', '7', 'No', null, null],
    ],
  },
  wbd: {
    features: [{ attributes: { huc12: '060101030504', name: 'Brush Creek' } }],
  },
  walk: {
    features: [{ attributes: { GEOID20: '471790609021', NatWalkInd: 8.3333 } }],
  },
};

/**
 * Upstream router for site sources. `overrides` maps a source key to a body,
 * a Response, or a function(url, init).
 */
export function siteUpstream(overrides = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    calls.push(u);
    let key;
    if (u.includes('geocoding.geo.census.gov')) key = 'census';
    else if (u.includes('epqs.nationalmap.gov')) key = 'epqs';
    else if (u.includes('ImageServer/identify')) {
      key = u.includes('renderingRule') ? 'slope' : 'identify';
    } else if (u.includes('sdmdataaccess')) key = 'sda';
    else if (u.includes('wbd/MapServer/6')) key = 'wbd';
    else if (u.includes('WalkabilityIndex')) key = 'walk';
    else throw new Error(`unexpected upstream ${u}`);
    const chosen = key in overrides ? overrides[key] : SITE_FIXTURES[key];
    if (typeof chosen === 'function') return chosen(u, init);
    if (chosen instanceof Response) return chosen;
    return json(chosen);
  };
  return { fetchImpl, calls };
}

/** Resolve a fixture choice (body, Response, or function) to a Response. */
function answer(chosen, url, init) {
  if (typeof chosen === 'function') return chosen(url, init);
  if (chosen instanceof Response) return chosen;
  return json(chosen);
}

/**
 * A clockwise (ArcGIS outer) square ring around the test point. Shifted by
 * the same delta the site itself moved (test point migration, 2026-09-24:
 * +0.011227 lat, +0.023098 lon) so it still encloses TEST_POINT, rather
 * than a stale square left behind at the old site.
 */
export const SQUARE = [
  [-82.342902, 36.320227],
  [-82.342902, 36.321227],
  [-82.341902, 36.321227],
  [-82.341902, 36.320227],
  [-82.342902, 36.320227],
];

const frs = (id, name, lat, lon) => ({
  attributes: {
    REGISTRY_ID: id,
    PRIMARY_NAME: name,
    LATITUDE83: lat,
    LONGITUDE83: lon,
  },
});

export const HAZARD_FIXTURES = {
  floodSite: {
    features: [
      {
        attributes: {
          FLD_ZONE: 'X',
          ZONE_SUBTY: 'AREA OF MINIMAL FLOOD HAZARD',
          SFHA_TF: 'F',
          STATIC_BFE: -9999,
        },
        // Shifted by the same delta the site itself moved (+0.011227 lat,
        // +0.023098 lon) so this on-site polygon still encloses TEST_POINT.
        geometry: {
          rings: [
            [
              [-82.343902, 36.319227],
              [-82.343902, 36.322227],
              [-82.340902, 36.322227],
              [-82.340902, 36.319227],
              [-82.343902, 36.319227],
            ],
          ],
        },
      },
    ],
  },
  floodNear: {
    features: [
      {
        attributes: { FLD_ZONE: 'X', ZONE_SUBTY: null, SFHA_TF: 'F' },
        geometry: {
          rings: [
            [
              [-82.343902, 36.319227],
              [-82.343902, 36.322227],
              [-82.340902, 36.322227],
              [-82.340902, 36.319227],
              [-82.343902, 36.319227],
            ],
          ],
        },
      },
      {
        attributes: {
          FLD_ZONE: 'AE',
          ZONE_SUBTY: null,
          SFHA_TF: 'T',
          STATIC_BFE: 1640,
        },
        // Shifted by the same delta so this "within 500 ft" AE ring stays
        // just outside the (also-shifted) on-site square above.
        geometry: {
          rings: [
            [
              [-82.342602, 36.321027],
              [-82.342602, 36.322227],
              [-82.341402, 36.322227],
              [-82.341402, 36.321027],
              [-82.342602, 36.321027],
            ],
          ],
        },
      },
    ],
  },
  floodShapes: {
    features: [
      { attributes: { FLD_ZONE: 'AE' }, geometry: { rings: [SQUARE] } },
    ],
  },
  panel: {
    features: [
      {
        attributes: {
          FIRM_PAN: '47019C0165E',
          EFF_DATE: Date.UTC(2008, 8, 26),
          PANEL_TYP: 'Countywide, Panel Printed',
        },
      },
    ],
  },
  nri: {
    features: [
      {
        attributes: {
          TRACTFIPS: '47179060902',
          RISK_SCORE: 8.918697156719347,
          RISK_RATNG: 'Very Low',
          SOVI_RATNG: 'Relatively Moderate',
          RESL_RATNG: 'Relatively High',
          NRI_VER: 'December 2025',
          LTNG_RISKS: 84.51,
          LTNG_RISKR: 'Relatively High',
          SWND_RISKS: 82.14,
          SWND_RISKR: 'Relatively Moderate',
          ERQK_RISKS: 65.62,
          ERQK_RISKR: 'Relatively Low',
          IFLD_RISKS: 12.4,
          IFLD_RISKR: 'Very Low',
          DRGT_RISKS: 0,
          DRGT_RISKR: 'No Rating',
          TSUN_RISKS: null,
          TSUN_RISKR: 'Not Applicable',
        },
      },
    ],
  },
  wetSite: { features: [] },
  wetNear: {
    features: [
      ['PEM1A', 'Freshwater Emergent Wetland', 4.0654],
      ['PUBHx', 'Freshwater Pond', 0.6417],
      ['R5UBH', 'Riverine', 1.8045],
    ].map(([code, type, acres]) => ({
      attributes: {
        'Wetlands.ATTRIBUTE': code,
        'Wetlands.WETLAND_TYPE': type,
        'Wetlands.ACRES': acres,
      },
      geometry: { rings: [SQUARE] },
    })),
  },
  // EPA facility points, all shifted by the same delta the site itself
  // moved (test point migration, 2026-09-24: +0.011227 lat, +0.023098 lon)
  // so each keeps its original distance and bearing from the site.
  epa0: {
    features: [
      frs('110000001', 'MENNEL MILL SITE', 36.327527, -82.336602),
      frs('110000002', 'OTHER BROWNFIELD', 36.336227, -82.346902),
      frs('110000002', 'OTHER BROWNFIELD', 36.336227, -82.346902),
    ],
  },
  epa21: { features: [] },
  epa15: {
    features: [
      frs('110007860350', 'MULLICAN FLOORING LP', 36.321127, -82.342002),
    ],
  },
  epa23: {
    features: [frs('110000372105', 'GENERAL MILL SITE', 36.322227, -82.333042)],
  },
  seismic: { response: { data: { sdc: 'B', ss: 0.34, s1: 0.094 } } },
  // Washington County TN, matching SITE_FIXTURES.census for the same CTX point.
  county: { features: [{ attributes: { GEOID: '47179' } }] },
};

/** Upstream router for hazard sources; overrides as in siteUpstream. */
export function hazardUpstream(overrides = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    calls.push(u);
    const params = new URL(u).searchParams;
    let key;
    if (u.includes('/NFHL/MapServer/28/')) {
      if ((params.get('where') || '').includes('SFHA_TF')) key = 'floodShapes';
      else key = params.has('distance') ? 'floodNear' : 'floodSite';
    } else if (u.includes('/NFHL/MapServer/3/')) key = 'panel';
    else if (u.includes('National_Risk_Index')) key = 'nri';
    else if (u.includes('Wetlands/MapServer/0')) {
      key = params.has('distance') ? 'wetNear' : 'wetSite';
    } else if (u.includes('FRS_INTERESTS/MapServer/')) {
      key = `epa${u.match(/MapServer\/(\d+)\//)[1]}`;
    } else if (u.includes('designmaps')) key = 'seismic';
    else if (u.includes('State_County/MapServer/1')) key = 'county';
    else throw new Error(`unexpected upstream ${u}`);
    const chosen = key in overrides ? overrides[key] : HAZARD_FIXTURES[key];
    return answer(chosen, u, init);
  };
  return { fetchImpl, calls };
}

const hudPoint = (attributes, lat, lon) => ({
  attributes,
  geometry: { x: lon, y: lat },
});

export const INCENTIVE_FIXTURES = {
  qct: {
    features: [
      {
        attributes: { GEOID: '47179060902', NAME: 'Census Tract 609.02' },
        geometry: { rings: [SQUARE] },
      },
    ],
  },
  dda: { features: [] },
  oz: {
    features: [
      { attributes: { GEOID10: '47179060902' }, geometry: { rings: [SQUARE] } },
    ],
  },
  lihtc: {
    features: [
      // About 2 miles north.
      hudPoint(
        {
          HUD_ID: 'TNA3',
          PROJECT: 'FAR PLACE',
          PROJ_ADD: '9 FAR RD',
          N_UNITS: 100,
          LI_UNITS: 100,
        },
        // Shifted north by the same delta the site itself moved (test point
        // migration, 2026-09-24) so this stays "about 2 miles north" of the
        // site, not a stale absolute latitude that now sits at a different
        // bearing/distance from the new site.
        36.349627,
        -82.342509,
      ),
      // About 0.5 miles north.
      hudPoint(
        {
          HUD_ID: 'TNA1',
          PROJECT: 'WATAUGA SQUARE',
          PROJ_ADD: '503 W WATAUGA AVE',
          N_UNITS: 102,
          LI_UNITS: 102,
        },
        36.327927,
        -82.342509,
      ),
      // About 0.7 miles; N_UNITS missing, revised count present.
      hudPoint(
        {
          HUD_ID: 'TNA2',
          PROJECT: 'CEDAR GROVE',
          PROJ_ADD: '1003 MILLIGAN HWY',
          N_UNITS: null,
          N_UNITSR: 38,
        },
        36.330827,
        -82.342509,
      ),
      // About 0.8 miles; no unit count at all.
      hudPoint(
        {
          HUD_ID: 'TNA4',
          PROJECT: 'NO COUNT',
          PROJ_ADD: null,
          N_UNITS: null,
          N_UNITSR: null,
        },
        36.332227,
        -82.342509,
      ),
    ],
  },
  // DATA-08: recorded (trimmed) from the real HUD FeatureServer root JSON on
  // 2026-09-24. The description text is stale boilerplate ("Fiscal Year
  // 2024 ... Date Updated: 10/2023"); the data itself was last edited
  // 2025-09-22, the fall before designation year 2026, which is how HUD
  // publishes. The year comes from the layer name, never the description.
  qctMeta: {
    name: 'QUALIFIED_CENSUS_TRACTS_2026',
    description:
      'Provides data on Qualified Census Tracts for the Low-Income Housing Tax Credit Program for 2024. Data Dictionary: DD_Qualified Census Tracts Date of Coverage: Fiscal Year 2024Date Updated: 10/2023',
    editingInfo: {
      lastEditDate: 1759243862931,
      schemaLastEditDate: 1759243860308,
      dataLastEditDate: 1758570469600,
    },
  },
  ddaMeta: {
    name: 'Difficult_Development_Areas2026',
    description:
      'Difficult Development Areas (DDA) for the Low Income Housing Tax Credit program... Data Dictionary: DD_Difficult Development Areas Date of Coverage: 2023-2024Last Updated: 10-2023',
    editingInfo: {
      lastEditDate: 1759243892906,
      schemaLastEditDate: 1759243890129,
      dataLastEditDate: 1758570317767,
    },
  },
  ph: {
    features: [
      hudPoint(
        {
          PROJECT_NAME: 'NORTHSIDE',
          FORMAL_PARTICIPANT_NAME: 'Johnson City Housing Authority',
          TOTAL_UNITS: 74,
        },
        36.3182,
        -82.342509,
      ),
      hudPoint(
        {
          PROJECT_NAME: 'SOUTHSIDE',
          FORMAL_PARTICIPANT_NAME: 'Johnson City Housing Authority',
          TOTAL_UNITS: 351,
        },
        36.2805,
        -82.342509,
      ),
    ],
  },
};

/** Upstream router for HUD incentive layers; overrides as in siteUpstream. */
export function incentiveUpstream(overrides = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    calls.push(u);
    // DATA-08: a layer-metadata request (?f=json, no /query) asks the
    // service what vintage it actually carries, separate from the ArcGIS
    // feature query the rest of this router answers.
    if (!u.includes('/query')) {
      let metaKey;
      if (u.includes('QUALIFIED_CENSUS_TRACTS_2026')) metaKey = 'qctMeta';
      else if (u.includes('Difficult_Development_Areas_2026'))
        metaKey = 'ddaMeta';
      else throw new Error(`unexpected metadata upstream ${u}`);
      const chosenMeta =
        metaKey in overrides ? overrides[metaKey] : INCENTIVE_FIXTURES[metaKey];
      return answer(chosenMeta, u, init);
    }
    let key;
    if (u.includes('QUALIFIED_CENSUS_TRACTS_2026')) key = 'qct';
    else if (u.includes('Difficult_Development_Areas_2026')) key = 'dda';
    else if (u.includes('Opportunity_Zones/FeatureServer/13')) key = 'oz';
    else if (u.includes('/LIHTC/')) key = 'lihtc';
    else if (u.includes('Public_Housing_Developments')) key = 'ph';
    else throw new Error(`unexpected upstream ${u}`);
    const chosen = key in overrides ? overrides[key] : INCENTIVE_FIXTURES[key];
    return answer(chosen, u, init);
  };
  return { fetchImpl, calls };
}
