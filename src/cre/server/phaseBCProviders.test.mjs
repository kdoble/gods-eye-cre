import test from 'node:test';
import assert from 'node:assert/strict';
import {
  creMarketHandler,
  creMarketProxy,
  parseHousingCsv,
  summarizeSeries,
} from '../../../server/providers/cre/market.js';
import {
  creDevelopmentProxy,
  normalizeDallasRow,
  normalizeAtlantaCase,
} from '../../../server/providers/cre/development.js';
import {
  creLocalNewsProxy,
  markExactMatches,
  parseNewsRss,
} from '../../../server/providers/cre/localNews.js';
import { marketValues } from '../sections/market.js';
import { developmentValues } from '../sections/development.js';
import { localNewsValues } from '../sections/localNews.js';

test('Vite provider hooks register middleware without returning a post-config hook', () => {
  for (const [plugin, path] of [
    [creMarketProxy(), '/api/cre/market'],
    [creDevelopmentProxy(), '/api/cre/development'],
    [creLocalNewsProxy(), '/api/cre/local-news'],
  ]) {
    const mounted = [];
    const connect = () => {
      throw new Error('Connect app must not become a Vite post-config hook');
    };
    const server = {
      middlewares: {
        use(route, handler) {
          mounted.push([route, handler]);
          return connect;
        },
      },
    };
    assert.equal(plugin.configureServer(server), undefined, plugin.name);
    assert.equal(mounted[0][0], path);
    assert.equal(typeof mounted[0][1], 'function');
  }
});

test('housing parser retains quoted ZIP metro metadata and exact-month comparisons', () => {
  const dates = Array.from({ length: 14 }, (_, i) =>
    new Date(Date.UTC(2025, i + 1, 0)).toISOString().slice(0, 10),
  );
  const csv = `RegionName,Metro,${dates.join(',')}\n75243,"Dallas-Fort Worth-Arlington, TX",${dates.map((_, i) => 100 + i).join(',')}\n`;
  const row = parseHousingCsv(csv, { metaColumn: 'Metro' })['75243'];
  assert.equal(row.meta, 'Dallas-Fort Worth-Arlington, TX');
  const trend = summarizeSeries(row.series);
  assert.equal(trend.latest.date, dates.at(-1));
  assert.equal(trend.prior12.date, dates.at(-13));
  assert.equal(trend.change12Pct, 11.9);
  const missing = summarizeSeries([row.series[0], row.series.at(-1)]);
  assert.equal(missing.prior12, null);
  assert.equal(missing.change12Pct, null);
});

test('stale market last-good data remains a dated usable route response', async () => {
  const handler = creMarketHandler({
    service: {
      marketFor: async () => ({
        data: {
          sourceStatus: {
            zhvi: 'stale',
            inventory: 'unavailable',
            zori: 'unavailable',
          },
          zhvi: { latest: { date: '2026-08-31', value: 360000 } },
          metro: 'Dallas, TX',
        },
        cachedAt: Date.parse('2026-09-20T00:00:00Z'),
        refresh: {
          status: 'failed',
          attemptedAt: '2026-09-23T00:00:00Z',
          dataRetrievedAt: '2026-09-20T00:00:00Z',
        },
      }),
    },
    limiter: null,
  });
  const res = {
    status: null,
    text: '',
    headersSent: false,
    writeHead(status) {
      this.status = status;
      this.headersSent = true;
    },
    end(text = '') {
      this.text = text;
    },
  };
  await handler(
    {
      method: 'GET',
      url: '/?lat=32.8935&lon=-96.7391&refresh=1',
      socket: { remoteAddress: '127.0.0.1' },
    },
    res,
  );
  assert.equal(res.status, 200);
  const body = JSON.parse(res.text);
  assert.equal(body.data.sourceStatus.zhvi, 'stale');
  assert.equal(body.retrievedAt, '2026-09-20T00:00:00.000Z');
  assert.equal(body.refresh.status, 'failed');
});

test('municipal records preserve status, dates and local-context scope', () => {
  const dallas = normalizeDallasRow(
    {
      attributes: {
        EXTERNALFILENUM: 'ROW-2026-503895',
        WORKDESCRIPTION: '<script>Leak repair</script>',
        STATUSDESCRIPTION: 'Issued',
        CREATEDDATE: Date.parse('2026-09-21'),
        ISSUEDATE: Date.parse('2026-09-22'),
      },
      geometry: { x: -96.7391, y: 32.8935 },
    },
    { lat: 32.8935, lon: -96.7391 },
  );
  assert.equal(dallas.status, 'Issued');
  assert.equal(dallas.recordDate, '2026-09-21');
  assert.equal(dallas.distanceM, 0);
  assert.equal(dallas.scope, 'local-context');
  const atlanta = normalizeAtlantaCase({
    attributes: {
      DOCKET_NO: 'Z-26-038',
      FROM_ZONE: 'PD-MU',
      TO_ZONE: 'MRC-3',
      STATUS: 'PENDING',
      FINAL_UPDA: null,
    },
  });
  assert.equal(atlanta.recordDate, null);
  assert.equal(atlanta.docketYear, 2026);
  assert.equal(atlanta.status, 'PENDING');
  const values = developmentValues({
    region: 'dallas-tx',
    records: [dallas],
    totalReturned: 61,
    truncated: true,
    window: '2026 to date, 1 mile',
    sourceUrls: [],
  });
  assert.match(values[0].note, /61 returned/);
  assert.match(values[0].note, /display capped/);
});

test('news headline parsing excludes publisher-name and Dallas Georgia false matches', () => {
  const now = Date.parse('2026-09-23T23:00:00Z');
  const item = (title, publisher = 'Dallas News') =>
    `<item><title>${title} - ${publisher}</title><link>https://news.google.com/rss/articles/ABC?oc=5</link><pubDate>Wed, 23 Sep 2026 14:47:47 GMT</pubDate><source>${publisher}</source></item>`;
  const xml = `<rss><channel>${item('Dallas road construction begins')}${item('Georgia DOT begins Dallas Highway construction')}${item('Fort Worth road construction')}${item('Dallas retail opening')}</channel></rss>`;
  const records = parseNewsRss(xml, {
    topic: 'roads',
    region: 'dallas-tx',
    now,
  });
  assert.deepEqual(
    records.map((r) => r.title),
    ['Dallas road construction begins'],
  );
  assert.equal(records[0].publisher, 'Dallas News');
});

test('exact-address headline classification requires the full street, never number alone', () => {
  const input = [
    '675 Ponce apartment opens',
    '675 Ponce de Leon project',
    '675 Ponce Place project',
    '9505 Royal Road project',
  ].map((title) => ({
    title,
    topic: 'housing',
    publisher: 'Publisher',
    publishedAt: '2026-09-23T00:00:00Z',
    url: 'https://news.google.com/rss/articles/ABC',
    scope: 'city-context',
  }));
  const result = markExactMatches(
    input,
    '675 Ponce de Leon Ave NE, Atlanta, GA',
  );
  assert.deepEqual(
    result.map((r) => r.scope),
    ['city-context', 'property-headline-match', 'city-context', 'city-context'],
  );
  const values = localNewsValues({ records: result });
  assert.match(values[1].note, /not independently verified/);
  assert.equal(values[0].scope, 'city-context');
});

test('market rows state area geography and never claim property occupancy', () => {
  const values = marketValues({
    metro: 'Dallas, TX',
    zip: '75243',
    zhvi: {
      latest: { date: '2026-08-31', value: 360436 },
      prior12: { date: '2025-08-31', value: 368830 },
      change12Pct: -2.3,
    },
    inventory: {
      latest: { date: '2026-08-31', value: 245 },
      prior12: { date: '2025-08-31', value: 285 },
      change12Pct: -14,
    },
    zori: {
      latest: { date: '2026-08-31', value: 1048.25 },
      change12mPct: -1.55,
    },
  });
  assert.match(values[0].label, /metro/);
  assert.match(values[2].label, /ZIP 75243/);
  assert.match(values[2].note, /not multifamily units or property occupancy/);
});

test('Coordinator item A: market ZORI row annualizes from the UNROUNDED index, matching the rents section exactly, never round-then-multiply', () => {
  const values = marketValues({
    metro: 'Atlanta, GA',
    zip: '30308',
    zori: {
      // The exact figure from the review: rounds to a displayed $2,079/mo,
      // but the true monthly value is $2,078.65.
      latest: { date: '2026-08-31', value: 2078.65 },
      change12mPct: 1.2,
    },
  });
  const row = values.find((v) => v.label.startsWith('Typical asking rent'));
  assert.equal(row.value, 2079, 'the displayed monthly figure is still rounded for display');
  assert.equal(
    row.annualPerUnit,
    24944,
    'annualized from the unrounded 2078.65 x 12 = 24943.80 -> 24944, never round(2078.65) x 12 = 24948',
  );
  assert.notEqual(row.annualPerUnit, 24948, 'the exact wrong value the review caught');
});
