// Tests for /api/cre/lihtc-limits/mtsp: the no-token path answers needs-key and makes no request at all, the HUD MTSP parser against a hand-built fixture of HUD's documented shape (NOT a live response), LIHTC rent math, and the token never reaching a body or a log.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createLihtcLimitsHandlers,
  HUD_MTSP_URL,
  HUD_SIGNUP_URL,
  lihtcMaxRents,
  parseMtsp,
} from '../../../server/providers/cre/lihtcLimits.js';
import { CRE_ERRORS } from '../../../server/providers/cre/common/route.js';
import { json } from './wp3Fixtures.testutil.mjs';
import { TIMING, call } from './wp3Fixtures.testutil.mjs';
import {
  ATLANTA,
  MTSP_DOC_SHAPE,
  TIGER_COUNTY_FULTON,
  upstreamBy,
} from './p6bFixtures.testutil.mjs';

// Synthesized at runtime so no literal ever looks like a credential.
const FAKE_TOKEN = ['fixture', 'hud', 'token', 'not', 'real'].join('-');

const handlersFor = (env, hudAnswer = MTSP_DOC_SHAPE) => {
  const upstream = upstreamBy([
    ['State_County/MapServer/1', TIGER_COUNTY_FULTON],
    ['/hudapi/public/mtspil/data/', hudAnswer],
  ]);
  const handlers = createLihtcLimitsHandlers({
    fetchImpl: upstream.fetchImpl,
    env,
    timing: TIMING,
    cacheOptions: { disk: false },
    limiter: null,
  });
  return { handlers, upstream };
};

test('NEGATIVE: with no HUD_API_TOKEN the route answers needs-key and makes no request of any kind', async () => {
  for (const env of [{}, { HUD_API_TOKEN: '' }, { HUD_API_TOKEN: '   ' }]) {
    const { handlers, upstream } = handlersFor(env);
    const res = await call(handlers.mtsp, ATLANTA);
    assert.equal(res.status, 200);
    const body = res.json();
    assert.equal(body.status, 'needs-key');
    assert.equal(body.data.key, 'HUD_API_TOKEN');
    assert.equal(body.data.signupUrl, HUD_SIGNUP_URL);
    assert.equal(
      HUD_SIGNUP_URL,
      'https://www.huduser.gov/portal/dataset/fmr-api.html',
    );
    assert.equal(upstream.calls.length, 0);
  }
});

test('parseMtsp reads 50 and 60 percent limits for 1 to 8 persons, numbers or numeric strings', () => {
  const parsed = parseMtsp(MTSP_DOC_SHAPE);
  assert.equal(parsed.year, 2025);
  assert.equal(
    parsed.areaName,
    'Atlanta-Sandy Springs-Roswell, GA HUD Metro FMR Area',
  );
  assert.equal(parsed.medianIncome, 120700);
  assert.deepEqual(
    parsed.limits[60],
    [50160, 57300, 64440, 71580, 77340, 83040, 88800, 94500],
  );
  assert.deepEqual(
    parsed.limits[50],
    [41800, 47750, 53700, 59650, 64450, 69200, 74000, 78750],
  );
});

test('LIHTC max gross rent is 30 percent of the imputed-size limit over 12, rounded down (0BR=1, 1BR=1.5, 2BR=3, 3BR=4.5 persons)', () => {
  const { limits } = parseMtsp(MTSP_DOC_SHAPE);
  assert.deepEqual(lihtcMaxRents(limits[60]), {
    studio: 1254,
    oneBr: 1343,
    twoBr: 1611,
    threeBr: 1861,
  });
  assert.deepEqual(lihtcMaxRents(limits[50]), {
    studio: 1045,
    oneBr: 1119,
    twoBr: 1342,
    threeBr: 1551,
  });
});

test('NEGATIVE: parseMtsp refuses a body missing a tier, a non-numeric or a zero limit', () => {
  const clone = () => JSON.parse(JSON.stringify(MTSP_DOC_SHAPE));
  const noSixty = clone();
  delete noSixty.data['60percent'];
  assert.throws(() => parseMtsp(noSixty));
  const text = clone();
  text.data['50percent'].il50_p3 = 'n/a';
  assert.throws(() => parseMtsp(text));
  const zero = clone();
  zero.data['60percent'].il60_p1 = 0;
  assert.throws(() => parseMtsp(zero));
  assert.throws(() => parseMtsp({}));
  assert.throws(() => parseMtsp(null));
});

test('with a token: county lookup, then HUD mtspil for the county entity with a bearer header; the token never reaches the body', async () => {
  const { handlers, upstream } = handlersFor({ HUD_API_TOKEN: FAKE_TOKEN });
  const res = await call(handlers.mtsp, ATLANTA);
  assert.equal(res.status, 200);
  const body = res.json();
  assert.equal(body.status, 'ready');
  assert.equal(body.data.countyFips, '13121');
  assert.deepEqual(body.data.rents[60], {
    studio: 1254,
    oneBr: 1343,
    twoBr: 1611,
    threeBr: 1861,
  });
  const hud = upstream.calls.find((c) => c.url.includes('/mtspil/'));
  assert.equal(hud.url, `${HUD_MTSP_URL}/1312199999`);
  assert.equal(hud.init.headers.Authorization, `Bearer ${FAKE_TOKEN}`);
  assert.ok(!res.body.includes(FAKE_TOKEN));
});

test('NEGATIVE: HUD refusing the token answers 502 with the fixed message; the token is in no body and no log line', async () => {
  const logged = [];
  const original = console.error;
  console.error = (...args) => logged.push(args.map(String).join(' '));
  try {
    const { handlers } = handlersFor(
      { HUD_API_TOKEN: FAKE_TOKEN },
      () => json({ error: 'Unauthenticated' }, 401),
    );
    const res = await call(handlers.mtsp, ATLANTA);
    assert.equal(res.status, 502);
    assert.deepEqual(res.json(), { error: CRE_ERRORS.UPSTREAM });
    assert.ok(!res.body.includes(FAKE_TOKEN));
  } finally {
    console.error = original;
  }
  assert.ok(logged.every((line) => !line.includes(FAKE_TOKEN)));
});

test('NEGATIVE: a point with no county is empty and HUD is never called', async () => {
  const upstream = upstreamBy([
    ['State_County/MapServer/1', { features: [] }],
    ['/hudapi/', MTSP_DOC_SHAPE],
  ]);
  const handlers = createLihtcLimitsHandlers({
    fetchImpl: upstream.fetchImpl,
    env: { HUD_API_TOKEN: FAKE_TOKEN },
    timing: TIMING,
    cacheOptions: { disk: false },
    limiter: null,
  });
  const body = (await call(handlers.mtsp, ATLANTA)).json();
  assert.equal(body.status, 'empty');
  assert.ok(upstream.calls.every((c) => !c.url.includes('/hudapi/')));
});
