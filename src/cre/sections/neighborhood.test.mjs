import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSectionResult, SECTION_STATUS } from '../contract.js';
import { id, label, order, load } from './neighborhood.js';

const CTX = {
  lat: 41.88,
  lon: -87.63,
  address: 'Chicago site',
  radiusMiles: 5,
};
const at = '2026-09-22T15:00:00.000Z';
const feature = (
  name,
  geometry = {
    type: 'LineString',
    coordinates: [
      [-87.63, 41.88],
      [-87.62, 41.89],
    ],
  },
) => ({
  type: 'Feature',
  properties: { name },
  geometry,
});
const reply =
  (data, status = 200) =>
  async () =>
    new Response(JSON.stringify({ data, retrievedAt: at }), { status });

test('module identity matches the section contract and investor-facing label', () => {
  assert.equal(id, 'neighborhood');
  assert.equal(label, 'Roads, crime coverage & local planning');
  assert.equal(order, 13);
});

test('city identity, crossing coverage and source evidence survive section mapping', async () => {
  const boundary =
    'https://gis.dallascityhall.com/arcgis/rest/services/Basemap/CityLimits/MapServer/0';
  const zoning =
    'https://gis.dallascityhall.com/arcgis/rest/services/sdc_public/Zoning/MapServer/15';
  const result = validateSectionResult(
    await load(
      { ...CTX, lat: 32.78, lon: -96.8 },
      {
        fetchImpl: reply({
          jurisdiction: {
            status: 'resolved',
            id: 'dallas-tx',
            name: 'City of Dallas, Texas',
            source: boundary,
            sourceUrls: [boundary],
            packageVersion: '2026-09-23.1',
            boundaryCheckedAt: at,
            crossesBoundary: true,
            message: 'Official city polygon.',
          },
          roads: {
            status: 'empty',
            features: [],
            message: 'No mapped road found.',
          },
          crime: {
            status: 'unsupported',
            sourceStatus: 'published-not-connected',
            features: [],
            sourceUrls: ['https://www.dallasopendata.com/'],
            message: 'Official crime link only.',
          },
          parcel: {
            status: 'ready',
            jurisdictionId: 'dallas-tx',
            parcelStatus: 'unsupported',
            zoningStatus: 'ready',
            parcelFeatures: [],
            zoningFeatures: [
              {
                type: 'Feature',
                properties: { LONG_ZONE_DIST: 'PD-619' },
                geometry: {
                  type: 'Polygon',
                  coordinates: [
                    [
                      [-96.8, 32.78],
                      [-96.79, 32.78],
                      [-96.8, 32.78],
                    ],
                  ],
                },
              },
            ],
            features: [],
            zoningSource: zoning,
            sourceUrls: [zoning],
            sourceMetadata: {
              publisher: 'City of Dallas GIS',
              recordDate: null,
              recordDateStatus: 'not-published-in-queried-fields',
            },
            message: 'City zoning map.',
          },
        }),
      },
    ),
  );
  assert.equal(result.jurisdiction.id, 'dallas-tx');
  assert.equal(result.evidence.crossesBoundary, true);
  assert.equal(result.evidence.boundarySource, boundary);
  assert.equal(result.status, SECTION_STATUS.PARTIAL);
  assert.equal(
    result.values.find(
      (v) => v.label === 'Dallas mapped zoning district (verify)',
    ).value,
    'PD-619',
  );
  assert.equal(
    result.values.find((v) => v.label === 'Parcel coverage').value,
    'No tested parcel feed for this city package',
  );
  const jurisdictionRow = result.values.find(
    (v) => v.label === 'Extra local data',
  );
  assert.match(jurisdictionRow.note, /crosses/);
  assert.equal(
    jurisdictionRow.value,
    'Dallas',
    'Coordinator item B: plain city name, not the pilot-program label',
  );
});

test("Coordinator item B: outside both cities, the jurisdiction row is omitted entirely, never 'Dallas/Atlanta city package'", async () => {
  const result = validateSectionResult(
    await load(CTX, {
      fetchImpl: reply({
        jurisdiction: {
          status: 'uncovered',
          id: null,
          sourceUrls: [],
          packageVersion: '2026-09-23.1',
          boundaryCheckedAt: at,
          crossesBoundary: null,
          message: 'Outside the Dallas and Atlanta city packages.',
        },
        roads: {
          status: 'empty',
          features: [],
          message: 'No mapped road found.',
        },
      }),
    }),
  );
  assert.equal(
    result.values.find((v) => v.label === 'Extra local data'),
    undefined,
  );
  assert.equal(
    result.values.find((v) => v.label === 'Dallas/Atlanta city package'),
    undefined,
    'the old pilot-program label must never appear',
  );
  assert.equal(
    result.values.find((v) => v.label === 'Local jurisdiction check'),
    undefined,
    'uncovered is a confirmed negative, not an unresolved check -- nothing to report',
  );
});

test('Coordinator item B: an unresolved jurisdiction check (boundary service down) is surfaced honestly, not as a city name', async () => {
  const result = validateSectionResult(
    await load(CTX, {
      fetchImpl: reply({
        jurisdiction: {
          status: 'unavailable',
          id: null,
          sourceUrls: [],
          packageVersion: '2026-09-23.1',
          boundaryCheckedAt: at,
          crossesBoundary: null,
          message: 'A city boundary service did not answer.',
        },
        roads: {
          status: 'empty',
          features: [],
          message: 'No mapped road found.',
        },
      }),
    }),
  );
  const row = result.values.find((v) => v.label === 'Local jurisdiction check');
  assert.ok(row, 'a real check failure is still reported');
  assert.equal(row.value, 'Could not confirm local jurisdiction');
});

test('maps partial roads and Chicago incident records without implying a safety rating', async () => {
  let requested;
  const result = validateSectionResult(
    await load(CTX, {
      signal: new AbortController().signal,
      fetchImpl: async (url, init) => {
        requested = { url: String(url), init };
        return new Response(
          JSON.stringify({
            retrievedAt: at,
            data: {
              roads: {
                status: 'partial',
                source: 'https://www.openstreetmap.org/copyright',
                features: [feature('I-90')],
                message:
                  'Only newest roads returned; mapped road does not establish legal site access.',
              },
              crime: {
                status: 'partial',
                source:
                  'https://data.cityofchicago.org/Public-Safety/Crimes-2001-to-present/ijzp-q8t2',
                features: [
                  feature('Theft', {
                    type: 'Point',
                    coordinates: [-87.63, 41.88],
                  }),
                ],
                message: 'Chicago police reports only; not a safety rating.',
              },
              parcel: {
                status: 'unavailable',
                sourceUrls: ['https://gis.atlantaga.gov/propinfo/'],
                features: [],
                message: 'Atlanta parcel service did not answer.',
              },
            },
          }),
          { status: 200 },
        );
      },
    }),
  );
  assert.match(requested.url, /^\/api\/cre\/neighborhood\?/);
  const params = new URL(requested.url, 'https://local.invalid').searchParams;
  assert.equal(params.get('lat'), '41.88');
  assert.equal(params.get('lon'), '-87.63');
  assert.equal(params.get('radiusM'), '8047');
  assert.ok(requested.init.signal instanceof AbortSignal);
  assert.equal(result.id, 'neighborhood');
  assert.equal(result.status, SECTION_STATUS.PARTIAL);
  assert.equal(result.retrievedAt, at);
  assert.equal(
    result.values.find(
      (v) => v.label === 'Mapped major road segments (max 3 mi)',
    ).value,
    1,
  );
  assert.equal(
    result.values.find(
      (v) => v.label === 'Chicago incident records (5 mi, 90-day window)',
    ).value,
    1,
  );
  assert.equal(
    result.values.find((v) => v.label === 'Parcel coverage').value,
    'Source unavailable',
  );
  assert.deepEqual(
    result.overlays.map((item) => item.id),
    ['roads', 'crime'],
  );
  assert.ok(
    result.sourceUrls.some((url) => url.includes('data.cityofchicago.org')),
  );
  assert.ok(result.sourceUrls.some((url) => url.includes('atlantaga.gov')));
  assert.match(
    result.values.find((v) => v.label.startsWith('Chicago incident')).note,
    /not a safety rating/,
  );
  assert.doesNotMatch(
    JSON.stringify(result),
    /crime-free|low crime|safe neighborhood/i,
  );
});

test('unsupported local crime, roads, and parcel coverage are unavailable, not zero incidents or no constraints', async () => {
  const result = validateSectionResult(
    await load(
      { ...CTX, lat: 36.320692, lon: -82.342509, radiusMiles: 1 },
      {
        fetchImpl: reply({
          roads: {
            status: 'unsupported',
            features: [],
            message: 'Road coverage unavailable for this locality.',
          },
          crime: {
            status: 'unsupported',
            features: [],
            message: 'Chicago only. Missing coverage does not mean low crime.',
          },
          parcel: {
            status: 'unsupported',
            features: [],
            message: 'Atlanta parcel pilot only; verify official records.',
          },
        }),
      },
    ),
  );
  assert.equal(result.status, SECTION_STATUS.UNAVAILABLE);
  assert.deepEqual(
    result.values.map((v) => v.value),
    [
      'Not supported in this locality',
      'Not supported in this locality',
      'Not supported in this locality',
    ],
  );
  assert.match(
    result.values.find((v) => v.label === 'Crime coverage').note,
    /Missing coverage does not mean low crime/,
  );
  assert.match(
    result.values.find((v) => v.label === 'Parcel coverage').note,
    /verify official records/,
  );
  assert.doesNotMatch(
    JSON.stringify(result),
    /no incidents|no crime|no zoning|no parcel/i,
  );
  assert.deepEqual(result.overlays, []);
});

test('Atlanta parcel attributes are transcribed and its polygon overlay is retained', async () => {
  const result = validateSectionResult(
    await load(
      { ...CTX, lat: 33.75, lon: -84.39, radiusMiles: 3 },
      {
        fetchImpl: reply({
          roads: {
            status: 'ready',
            features: [],
            message: 'No major road geometry returned.',
          },
          crime: {
            status: 'unsupported',
            source:
              'https://data.cityofchicago.org/Public-Safety/Crimes-2001-to-present/ijzp-q8t2',
            features: [],
            message: 'This pilot covers Chicago only.',
          },
          parcel: {
            status: 'ready',
            sourceUrls: ['https://gis.atlantaga.gov/propinfo/'],
            features: [
              {
                type: 'Feature',
                properties: {
                  PIN: '14-0012-0001',
                  SITEADDRESS: '1 Peachtree St',
                  ZONING: 'C-3',
                },
                geometry: { type: 'MultiPolygon', coordinates: [] },
              },
            ],
            message:
              'Confirm parcel boundaries and current zoning with the city.',
          },
        }),
      },
    ),
  );
  assert.equal(result.status, SECTION_STATUS.PARTIAL);
  assert.equal(
    result.values.find((v) => v.label === 'Atlanta parcel ID').value,
    '14-0012-0001',
  );
  assert.equal(
    result.values.find((v) => v.label === 'Parcel address').value,
    '1 Peachtree St',
  );
  assert.equal(
    result.values.find((v) => v.label === 'Zoning (verify with city)').value,
    'C-3',
  );
  assert.deepEqual(
    result.overlays.map((item) => item.id),
    ['parcel'],
  );
  assert.match(result.message, /Confirm parcel boundaries and current zoning/);
});

test('Johnson City separates live parcel facts from the zoning overlay and incident-feed limitation', async () => {
  const result = validateSectionResult(
    await load(
      { ...CTX, lat: 36.320692, lon: -82.342509 },
      {
        fetchImpl: reply({
          roads: { status: 'ready', features: [], message: 'Mapped roads.' },
          crime: {
            status: 'unavailable',
            sourceStatus: 'published-not-connected',
            verifiedOn: '2026-09-23',
            sourceUrls: [
              'https://experience.arcgis.com/experience/43bc4ffa407d4ac1b0a402ed189f745f/',
              'https://www.tn.gov/tbi/divisions/cjis-division/tncrimeonline.html',
            ],
            source:
              'https://experience.arcgis.com/experience/43bc4ffa407d4ac1b0a402ed189f745f/',
            features: [],
            message:
              'Official map linked, but feed could not be loaded. Excludes homicide.',
          },
          parcel: {
            status: 'ready',
            sourceUrls: [
              'https://gis.johnsoncitytn.org/arcgis/rest/services/ParcelPublishing/TaxParcels/MapServer/0',
              'https://gis.johnsoncitytn.org/arcgis/rest/services/LandUsePlanning/Zoning_and_Overlays/MapServer/1',
            ],
            features: [feature('parcel'), feature('zoning')],
            parcelFeatures: [
              {
                type: 'Feature',
                properties: { ADDRESS: '601 E Main St', WATER: 'Yes' },
                geometry: { type: 'MultiPolygon', coordinates: [] },
              },
            ],
            zoningFeatures: [
              {
                type: 'Feature',
                properties: { ZONECLASS: 'R-4' },
                geometry: { type: 'MultiPolygon', coordinates: [] },
              },
            ],
            message: 'Verify boundaries and utility capacity.',
          },
        }),
      },
    ),
  );
  assert.equal(result.status, SECTION_STATUS.PARTIAL);
  assert.equal(
    result.values.find((v) => v.label === 'Johnson City parcel address').value,
    '601 E Main St',
  );
  assert.equal(
    result.values.find(
      (v) => v.label === 'Johnson City zoning district (verify)',
    ).value,
    'R-4',
  );
  assert.equal(
    result.values.find((v) => v.label === 'Crime coverage').value,
    'Official source published; incident feed not connected',
  );
  const crime = result.values.find((v) => v.label === 'Crime coverage');
  assert.equal(crime.status, 'published-not-connected');
  assert.equal(
    crime.sourceUrls[0],
    'https://experience.arcgis.com/experience/43bc4ffa407d4ac1b0a402ed189f745f/',
  );
  assert.doesNotMatch(crime.sourceUrls[0], /chicago|openstreetmap/i);
  assert.deepEqual(
    result.overlays.map((item) => item.id),
    ['parcel', 'zoning'],
  );
  assert.ok(result.sourceUrls.some((url) => url.includes('johnsoncitytn.org')));
  assert.ok(
    result.sourceUrls.some((url) =>
      url.includes(
        'experience.arcgis.com/experience/43bc4ffa407d4ac1b0a402ed189f745f',
      ),
    ),
  );
  assert.match(result.message, /Excludes homicide/);
});

test('local route failure is unavailable with a fixed no-inference message', async () => {
  const result = validateSectionResult(
    await load(CTX, {
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: 'upstream internal secret' }), {
          status: 502,
        }),
    }),
  );
  assert.equal(result.status, SECTION_STATUS.UNAVAILABLE);
  assert.deepEqual(result.values, []);
  assert.match(
    result.message,
    /Do not infer no roads, no crime or no constraints/,
  );
  assert.doesNotMatch(JSON.stringify(result), /upstream internal secret/);
});

test('an aborted section request rethrows for the controller to discard', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    load(CTX, {
      signal: controller.signal,
      fetchImpl: async (_url, init) => {
        init.signal.throwIfAborted();
        return new Response('{}');
      },
    }),
  );
});
