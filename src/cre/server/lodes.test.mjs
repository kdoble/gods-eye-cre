// Tests for the LODES family: block-to-tract roll-up, rejection of a 14-digit block code, the disk-cached state download with vintage fallback, and the county job cluster.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { gzipSync } from 'node:zlib';
import {
  LodesFormatError,
  createLodesStore,
  loadCluster,
  loadJobs,
  lodesJobsHandler,
  rollUpWac,
} from '../../../server/providers/cre/lodes.js';

const SECTORS = Array.from(
  { length: 20 },
  (_, i) => `CNS${String(i + 1).padStart(2, '0')}`,
);
const HEADER = ['w_geocode', 'C000', 'CA01', ...SECTORS, 'createdate'].join(
  ',',
);
/** One WAC line: block, total, one CA filler, sector counts (index -> count). */
function line(block, total, sectors) {
  const cells = SECTORS.map((_, i) => sectors[i] ?? 0);
  return [block, total, 0, ...cells, '20250101'].join(',');
}
const FIXTURE = [
  HEADER,
  line('471790609021000', 100, { 15: 60, 6: 40 }),
  line('471790609021001', 50, { 15: 50 }),
  line('471790619002000', 30, { 17: 30 }),
].join('\n');

test('three blocks roll up to the right tract totals and sectors', () => {
  const tracts = rollUpWac(FIXTURE);
  assert.equal(tracts.size, 2);
  const a = tracts.get('47179060902');
  assert.equal(a[0], 150);
  assert.equal(a[16], 110, 'CNS16 health care summed across two blocks');
  assert.equal(a[7], 40, 'CNS07 retail');
  assert.equal(tracts.get('47179061900')[0], 30);
});

test('NEGATIVE: a 14-digit block code rejects the whole file', () => {
  const bad = `${FIXTURE}\n${line('47179060902100', 5, {})}`;
  assert.throws(() => rollUpWac(bad), LodesFormatError);
  assert.throws(
    () => rollUpWac('x,y\n1,2'),
    LodesFormatError,
    'missing columns',
  );
});

async function tempDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'lodes-test-'));
}

test('state file downloads once, falls back a vintage on 404, and serves tract jobs', async () => {
  const dir = await tempDir();
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(String(url));
    if (String(url).includes('_2023.'))
      return new Response('', { status: 404 });
    return new Response(gzipSync(FIXTURE), { status: 200 });
  };
  const store = createLodesStore({ fetchImpl, dir });
  const jobs = await loadJobs(
    ['47179060902', '47179061900', '47179000100'],
    store,
  );
  assert.equal(jobs.year, 2022);
  assert.equal(jobs.tracts['47179060902'].total, 150);
  assert.equal(jobs.tracts['47179060902'].sectors.CNS16, 110);
  assert.equal(jobs.tracts['47179000100'].total, 0);
  assert.deepEqual(jobs.zero, ['47179000100']);
  assert.ok(jobs.sourceUrls[0].endsWith('tn_wac_S000_JT00_2022.csv.gz'));
  const again = createLodesStore({ fetchImpl, dir });
  await loadJobs(['47179060902'], again);
  assert.equal(
    seen.filter((u) => u.includes('_2022.')).length,
    1,
    'disk cache hit',
  );
  await fsp.rm(dir, { recursive: true, force: true });
});

test('NEGATIVE: a missing state file fails rather than reporting zero jobs', async () => {
  const dir = await tempDir();
  const store = createLodesStore({
    fetchImpl: async () => new Response('', { status: 404 }),
    dir,
  });
  await assert.rejects(loadJobs(['47179060902'], store));
  await assert.rejects(loadJobs(['72001000100'], store), 'no LODES state code');
  await fsp.rm(dir, { recursive: true, force: true });
});

test('jobs route rejects bad geoids with 400', async () => {
  const res = {
    status: 0,
    body: '',
    writeHead(s) {
      this.status = s;
    },
    end(b = '') {
      this.body = b;
    },
  };
  const handler = lodesJobsHandler({
    store: {
      state: async () => {
        throw new Error('unused');
      },
    },
    limiter: null,
  });
  await handler({ url: '/?geoids=123', method: 'GET', socket: {} }, res);
  assert.equal(res.status, 400);
});

test('county cluster picks the tract with the most jobs within a mile', async () => {
  const table = {
    year: 2023,
    url: 'u',
    tracts: new Map([
      ['47179000100', [500]],
      ['47179000200', [400]],
      ['47179000300', [700]],
    ]),
  };
  const store = { state: async () => table };
  const fetchImpl = async () =>
    Response.json({
      features: [
        // 100 and 200 are 0.5 km apart (900 jobs together); 300 stands alone.
        {
          attributes: {
            GEOID: '47179000100',
            INTPTLAT: '+36.3000',
            INTPTLON: '-082.3500',
          },
        },
        {
          attributes: {
            GEOID: '47179000200',
            INTPTLAT: '+36.3045',
            INTPTLON: '-082.3500',
          },
        },
        {
          attributes: {
            GEOID: '47179000300',
            INTPTLAT: '+36.4000',
            INTPTLON: '-082.2000',
          },
        },
      ],
    });
  const cluster = await loadCluster('47179', store, { fetchImpl });
  assert.equal(cluster.clusterJobs, 900);
  assert.ok(['47179000100', '47179000200'].includes(cluster.geoid));
  assert.equal(cluster.countyJobs, 1600);
});
