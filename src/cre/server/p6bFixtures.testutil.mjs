// Shared fixtures for the P6B routes (insurance EAL, LIHTC limits, demand drivers, utilities); not a test file, so importing it registers nothing.
// ArcGIS attribute values below were copied from live responses on 2026-09-24
// (FEMA NRI tract 13121001302, Atlanta GA). The HUD MTSP body is hand built
// from HUD's documented response shape because no HUD_API_TOKEN exists on the
// build machine: it has NOT been checked against a live HUD response.
import { json } from './wp3Fixtures.testutil.mjs';

export const ATLANTA = 'lat=33.7726&lon=-84.3659';
export const ATLANTA_POINT = { lat: 33.7726, lon: -84.3659 };

/** FEMA NRI attributes for tract 13121001302 (live, NRI December 2025). */
export const NRI_ATLANTA = Object.freeze({
  TRACTFIPS: '13121001302',
  COUNTY: 'Fulton',
  STATEABBRV: 'GA',
  NRI_VER: 'December 2025',
  BUILDVALUE: 605749822,
  RISK_SCORE: 2.52,
  RISK_RATNG: 'Very Low',
  EAL_VALB: 365145.26769650221,
  EAL_SCORE: 6.5199520868074314,
  EAL_RATNG: 'Very Low',
  ALR_NPCTL: 9.595556286257839,
  HRCN_EALB: 2841.3276673462783,
  HRCN_EALS: 42.721391863251654,
  HRCN_EALR: 'Very Low',
  HRCN_ALR_NPCTL: 42.829438572675265,
  SWND_EALB: 1939.9534308142961,
  SWND_EALS: 20.1,
  SWND_EALR: 'Very Low',
  SWND_ALR_NPCTL: 11.2,
  HAIL_EALB: 9303.5055121623463,
  HAIL_EALS: 40.2,
  HAIL_EALR: 'Relatively Low',
  HAIL_ALR_NPCTL: 30.4,
  TRND_EALB: 26965.54,
  TRND_EALS: 55.5,
  TRND_EALR: 'Relatively Moderate',
  TRND_ALR_NPCTL: 38.9,
  WFIR_EALB: 84.72902987957093,
  WFIR_EALS: 12.3,
  WFIR_EALR: 'Very Low',
  WFIR_ALR_NPCTL: 5.5,
  IFLD_EALB: 282814.2149,
  IFLD_EALS: 81.2,
  IFLD_EALR: 'Relatively Low',
  IFLD_ALR_NPCTL: 70.1,
  CFLD_EALB: null,
  CFLD_EALS: null,
  CFLD_EALR: 'Not Applicable',
  CFLD_ALR_NPCTL: null,
});

export const nriBody = (attributes = NRI_ATLANTA) => ({
  features: attributes ? [{ attributes }] : [],
});

/** A fetch fake that answers by URL substring, recording every call. */
export function upstreamBy(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, init });
    for (const [needle, answer] of routes) {
      if (u.includes(needle)) {
        const value = typeof answer === 'function' ? answer(u, init) : answer;
        if (value instanceof Response) return value;
        if (value instanceof Error) throw value;
        return json(value);
      }
    }
    throw new Error(`unexpected upstream ${u}`);
  };
  return { fetchImpl, calls };
}

/**
 * HUD MTSP body built by hand from HUD's documented mtspil/data/{entityid}
 * response (huduser.gov/portal/dataset/fmr-api.html, fetched 2026-09-24).
 * Values are illustrative, not Fulton County's real limits. NOT exercised
 * against the live API.
 */
export const MTSP_DOC_SHAPE = Object.freeze({
  data: {
    county_name: 'Fulton County, GA',
    counties_msa: '',
    town_name: '',
    metro_status: '1',
    metro_name: 'Atlanta-Sandy Springs-Roswell, GA HUD Metro FMR Area',
    area_name: 'Atlanta-Sandy Springs-Roswell, GA HUD Metro FMR Area',
    year: '2025',
    median_income: 120700,
    '60percent': {
      il60_p1: 50160,
      il60_p2: 57300,
      il60_p3: 64440,
      il60_p4: 71580,
      il60_p5: 77340,
      il60_p6: 83040,
      il60_p7: 88800,
      il60_p8: 94500,
    },
    '50percent': {
      il50_p1: '41800',
      il50_p2: '47750',
      il50_p3: '53700',
      il50_p4: '59650',
      il50_p5: '64450',
      il50_p6: '69200',
      il50_p7: '74000',
      il50_p8: '78750',
    },
  },
});

export const TIGER_COUNTY_FULTON = {
  features: [{ attributes: { GEOID: '13121' } }],
};

const pt = (attributes, lat, lon) => ({
  attributes,
  geometry: { x: lon, y: lat },
});

/**
 * Hospitals near Atlanta (live FEMA-hosted HIFLD layer 6, 2026-09-24, plus
 * the point 33.77,-84.39, 10 mi -- the exact live probe behind the M3 fix).
 * HIFLD still lists Wellstar Atlanta Medical Center as OPEN with 762 beds;
 * it actually closed in November 2022 (DATA-XX cross-check fix). CMS also
 * omits it entirely, and its TYPE is plain GENERAL ACUTE CARE (not one of
 * the CMS-scope-gap types), so it is the one HIFLD "open" hospital that is
 * correctly excluded.
 *
 * PIEDMONT HOSPITAL is spelled without ", INC" in the live HIFLD layer
 * (CMS carries "PIEDMONT HOSPITAL, INC") -- exact-string matching drops a
 * real, open 643-bed hospital on punctuation alone. CHILDREN'S HEALTHCARE
 * OF ATLANTA AT EGLESTON (TYPE CHILDREN) and the ATLANTA VA MEDICAL CENTER
 * (TYPE MILITARY, CMS spells it "DECATUR (ATLANTA) VA MEDICAL CENTER") are
 * both live, open, real -- CMS's Hospital General Information dataset is
 * scoped to Medicare-participating inpatient hospitals and, verified live
 * 2026-09-24 (`facility_name like EGLESTON` nationwide = 0 rows), does not
 * carry pediatric specialty hospitals like Egleston at all. FAR NAVAL
 * HOSPITAL is a synthetic MILITARY-type record with no CMS candidate in
 * its state at all, exercising the type-exempt fallback with zero fuzzy
 * candidates (not just a below-threshold fuzzy miss).
 */
export const HOSPITALS_ATLANTA = {
  features: [
    pt(
      {
        NAME: 'WELLSTAR ATLANTA MEDICAL CENTER',
        BEDS: 762,
        STATUS: 'OPEN',
        TYPE: 'GENERAL ACUTE CARE',
        CITY: 'ATLANTA',
        STATE: 'GA',
        ZIP: '30312',
        ADDRESS: '303 PARKWAY DRIVE NE',
        SOURCEDATE: 1712880000000,
      },
      33.76295,
      -84.37339,
    ),
    pt(
      {
        NAME: 'SELECT SPECIALTY HOSPITAL - MIDTOWN ATLANTA, LLC',
        BEDS: 72,
        STATUS: 'OPEN',
        TYPE: 'LONG TERM CARE',
        CITY: 'ATLANTA',
        STATE: 'GA',
        ZIP: '30308',
        ADDRESS: '705 JUNIPER STREET NE',
        SOURCEDATE: 1712880000000,
      },
      33.773777,
      -84.382754,
    ),
    pt(
      {
        NAME: 'CLOSED TEST HOSPITAL',
        BEDS: 200,
        STATUS: 'CLOSED',
        TYPE: 'GENERAL ACUTE CARE',
        CITY: 'ATLANTA',
        STATE: 'GA',
        ZIP: '30303',
        ADDRESS: '1 CLOSED WAY',
        SOURCEDATE: 1712880000000,
      },
      33.7727,
      -84.366,
    ),
    pt(
      {
        NAME: 'EMORY UNIVERSITY HOSPITAL MIDTOWN',
        BEDS: -999,
        STATUS: 'OPEN',
        TYPE: 'GENERAL ACUTE CARE',
        CITY: 'ATLANTA',
        STATE: 'GA',
        ZIP: '30308',
        ADDRESS: '550 PEACHTREE STREET NE',
        SOURCEDATE: 1712880000000,
      },
      33.768,
      -84.386,
    ),
    pt(
      // Live HIFLD spelling (verified 2026-09-24): no ", INC". CMS spells
      // it "PIEDMONT HOSPITAL, INC" -- exact-string matchKey would drop
      // this real, open, 643-bed hospital.
      {
        NAME: 'PIEDMONT HOSPITAL',
        BEDS: 552,
        STATUS: 'OPEN',
        TYPE: 'GENERAL ACUTE CARE',
        CITY: 'ATLANTA',
        STATE: 'GA',
        ZIP: '30309',
        ADDRESS: '1968 PEACHTREE RD NW',
        SOURCEDATE: 1712880000000,
      },
      33.812,
      -84.3855,
    ),
    pt(
      {
        NAME: "CHILDREN'S HEALTHCARE OF ATLANTA AT EGLESTON",
        BEDS: 330,
        STATUS: 'OPEN',
        TYPE: 'CHILDREN',
        CITY: 'ATLANTA',
        STATE: 'GA',
        ZIP: '30322',
        ADDRESS: '1405 CLIFTON ROAD NE',
        SOURCEDATE: 1712880000000,
      },
      33.79,
      -84.323,
    ),
    pt(
      // CMS spells this "DECATUR (ATLANTA) VA MEDICAL CENTER" -- different
      // enough that exact match misses, close enough (token Jaccard >= 0.5
      // on ATLANTA + VA once MEDICAL/CENTER are stripped as generic) that
      // the fuzzy match keeps it as CMS-verified, not merely type-exempt.
      {
        NAME: 'ATLANTA VA MEDICAL CENTER',
        BEDS: 466,
        STATUS: 'OPEN',
        TYPE: 'MILITARY',
        CITY: 'DECATUR',
        STATE: 'GA',
        ZIP: '30033',
        ADDRESS: '1670 CLAIRMONT ROAD',
        SOURCEDATE: 1712880000000,
      },
      33.79,
      -84.31,
    ),
    pt(
      // Synthetic: a MILITARY-type record CMS has no candidate for at all
      // (no GA row shares its city or ZIP), exercising the type-exempt
      // fallback when there isn't even a fuzzy near-miss to fall back on.
      {
        NAME: 'FAR NAVAL HOSPITAL',
        BEDS: 40,
        STATUS: 'OPEN',
        TYPE: 'MILITARY',
        CITY: 'ATLANTA',
        STATE: 'GA',
        ZIP: '39999',
        ADDRESS: '1 NAVAL WAY',
        SOURCEDATE: 1712880000000,
      },
      33.83,
      -84.4,
    ),
    pt(
      // Synthetic: an ordinary GENERAL ACUTE CARE hospital whose name has
      // zero token overlap with its CMS record, matched only by shared
      // street address -- exercises the address-match path for a type that
      // is NOT CMS-scope-exempt (so without the address match it would be
      // wrongly excluded as a closure).
      {
        NAME: 'RIVERBEND COMMUNITY HOSPITAL',
        BEDS: 120,
        STATUS: 'OPEN',
        TYPE: 'GENERAL ACUTE CARE',
        CITY: 'ATLANTA',
        STATE: 'GA',
        ZIP: '30310',
        ADDRESS: '42 MERGER PARKWAY',
        SOURCEDATE: 1712880000000,
      },
      33.74,
      -84.42,
    ),
    pt(
      {
        NAME: 'FAR HOSPITAL',
        BEDS: 50,
        STATUS: 'OPEN',
        TYPE: 'GENERAL ACUTE CARE',
        CITY: 'ATLANTA',
        STATE: 'GA',
        ZIP: '30399',
        ADDRESS: '1 FAR ROAD',
        SOURCEDATE: 1712880000000,
      },
      33.9,
      -84.2,
    ),
  ],
};

/**
 * CMS Provider Data Catalog "Hospital General Information" rows (dataset
 * xubh-q36u), the shape of `results` from
 * /provider-data/api/1/datastore/query/xubh-q36u/0 verified live 2026-09-24.
 * Wellstar Atlanta Medical Center and CHOA Egleston are both deliberately
 * absent (Wellstar closed November 2022; Egleston is a pediatric specialty
 * hospital CMS's Medicare-scoped dataset never lists at all -- verified
 * live, `facility_name like EGLESTON` nationwide returns 0 rows).
 */
export const CMS_HOSPITALS_ATLANTA = {
  results: [
    {
      facility_name: 'SELECT SPECIALTY HOSPITAL - MIDTOWN ATLANTA, LLC',
      citytown: 'ATLANTA',
      state: 'GA',
      zip_code: '30308',
      address: '705 JUNIPER STREET NE',
    },
    {
      facility_name: 'EMORY UNIVERSITY HOSPITAL MIDTOWN',
      citytown: 'ATLANTA',
      state: 'GA',
      zip_code: '30308',
      address: '550 PEACHTREE STREET, NE',
    },
    {
      // Live CMS spelling (verified 2026-09-24): carries ", INC" that the
      // live HIFLD record does not.
      facility_name: 'PIEDMONT HOSPITAL, INC',
      citytown: 'ATLANTA',
      state: 'GA',
      zip_code: '30309',
      address: '1968 PEACHTREE RD NW',
    },
    {
      // Live CMS spelling for the Atlanta VA (verified 2026-09-24).
      facility_name: 'DECATUR (ATLANTA) VA MEDICAL CENTER',
      citytown: 'DECATUR',
      state: 'GA',
      zip_code: '30033',
      address: '1670 CLAIRMONT ROAD',
    },
    {
      // Shares RIVERBEND's street address under a totally different name
      // -- the only way the address-match path can confirm it.
      facility_name: 'MERGER PARKWAY MEDICAL CENTER',
      citytown: 'ATLANTA',
      state: 'GA',
      zip_code: '30310',
      address: '42 MERGER PARKWAY',
    },
  ],
};

/**
 * Colleges near Atlanta (live FEMA-hosted HIFLD layer 5 shape). TINY
 * COMMUNITY COLLEGE is deliberately the CLOSEST degree-granting school
 * (0.1 mi) but has only 48 students -- the exact "nearest-first surfaces
 * 48-student schools" case the ranking fix addresses. SPELMAN COLLEGE
 * outranks it on enrollment (2,400) so Tiny falls out of the top 3 even
 * though it is nearer than Spelman.
 */
export const COLLEGES_ATLANTA = {
  features: [
    pt(
      {
        NAME: 'GEORGIA INSTITUTE OF TECHNOLOGY-MAIN CAMPUS',
        TOT_ENROLL: 39771,
        STATUS: 'A',
        NAICS_DESC: 'COLLEGES, UNIVERSITIES, AND PROFESSIONAL SCHOOLS',
        SOURCEDATE: 1255392000000,
      },
      33.7756,
      -84.3963,
    ),
    pt(
      {
        NAME: 'GEORGIA STATE UNIVERSITY',
        TOT_ENROLL: 37000,
        STATUS: 'A',
        NAICS_DESC: 'COLLEGES, UNIVERSITIES, AND PROFESSIONAL SCHOOLS',
        SOURCEDATE: 1255392000000,
      },
      33.753,
      -84.3853,
    ),
    pt(
      {
        NAME: 'SPELMAN COLLEGE',
        TOT_ENROLL: 2400,
        STATUS: 'A',
        NAICS_DESC: 'COLLEGES, UNIVERSITIES, AND PROFESSIONAL SCHOOLS',
        SOURCEDATE: 1255392000000,
      },
      33.7327,
      -84.4108,
    ),
    pt(
      {
        NAME: 'TINY COMMUNITY COLLEGE',
        TOT_ENROLL: 48,
        STATUS: 'A',
        NAICS_DESC: 'JUNIOR COLLEGES',
        SOURCEDATE: 1255392000000,
      },
      33.7728,
      -84.3665,
    ),
    pt(
      {
        NAME: 'BEAUTY TRADE SCHOOL',
        TOT_ENROLL: 80,
        STATUS: 'A',
        NAICS_DESC: 'COSMETOLOGY AND BARBER SCHOOLS',
        SOURCEDATE: 1255392000000,
      },
      33.7727,
      -84.366,
    ),
    pt(
      {
        NAME: 'ATLANTA TECHNICAL JUNIOR COLLEGE',
        TOT_ENROLL: null,
        STATUS: 'A',
        NAICS_DESC: 'JUNIOR COLLEGES',
        SOURCEDATE: 1255392000000,
      },
      33.71,
      -84.4,
    ),
  ],
};

/** Electric retail territory at Atlanta (live HIFLD copy, 2026-09-24). */
export const ELECTRIC_ATLANTA = {
  features: [
    {
      attributes: {
        ID: '7140',
        NAME: 'GEORGIA POWER CO',
        TYPE: 'INVESTOR OWNED',
        STATE: 'GA',
        HOLDING_CO: 'SOUTHERN COMPANY',
        CUSTOMERS: 2712780,
        YEAR: '2022',
        SOURCEDATE: 1690848000000,
      },
    },
  ],
};

/** EPA community water system boundaries at Atlanta (live, 2026-09-24). */
export const WATER_ATLANTA = {
  features: [
    {
      attributes: {
        PWSID: 'GA1210001',
        PWS_Name: 'ATLANTA',
        Primacy_Agency: 'GA',
        Population_Served_Count: 1089893,
        Service_Area_Type: 'Municipality',
        Symbology_Field: 'System Sourced',
      },
    },
    {
      attributes: {
        PWSID: 'GA0890001',
        PWS_Name: 'DEKALB COUNTY',
        Primacy_Agency: 'GA',
        Population_Served_Count: 743000,
        Service_Area_Type: 'Municipality',
        Symbology_Field: 'System Sourced',
      },
    },
  ],
};
