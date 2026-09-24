// Controller tests: parallel runs, per-section failure isolation (S7), abort safety, and panel state derivation.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDossierController,
  buildSectionContext,
  derivePanelState,
  DOSSIER_STATE,
  SECTION_LOADING,
  NO_MATCH_MESSAGE,
} from './dossierController.js';
import { fixtureSection, FIXTURE_SECTIONS } from './sections/fixture.js';
import { RINGS_M } from './config.js';

const PLACE = {
  lat: 36.320692,
  lon: -82.342509,
  matchedAddress: '601 E MAIN ST, JOHNSON CITY, TN, 37601',
  tractGeoid: '47179061900',
};

const quiet = (t) => {
  const warn = console.warn;
  console.warn = () => {};
  t.after(() => (console.warn = warn));
};

test('refresh preserves prior findings and marks an unavailable retry as failed', async () => {
  let calls = 0;
  const section = {
    id: 'sample',
    label: 'Sample',
    order: 1,
    load: async () => ({
      id: 'sample',
      label: 'Sample',
      status: ++calls === 1 ? 'ready' : 'unavailable',
      values:
        calls === 1 ? [{ label: 'Finding', value: 'Earlier evidence' }] : [],
      credit: { text: 'Agency', url: '', license: '' },
      sourceUrls: [],
      retrievedAt: '2026-09-22T12:00:00Z',
      message: calls > 1 ? 'Source did not answer.' : undefined,
    }),
  };
  const controller = createDossierController({ sections: [section] });
  await controller.run(PLACE);
  const pending = controller.run(PLACE, { refresh: true });
  assert.equal(
    controller.getSnapshot().sections[0].result.values[0].value,
    'Earlier evidence',
  );
  await pending;
  const entry = controller.getSnapshot().sections[0];
  assert.equal(entry.result.values[0].value, 'Earlier evidence');
  assert.equal(entry.refresh.status, 'failed');
});

test('refresh metadata clone cannot outwait section deadline', async (t) => {
  quiet(t);
  let calls = 0;
  const section = {
    id: 'sample',
    label: 'Sample',
    order: 1,
    async load(_ctx, { fetchImpl }) {
      await fetchImpl('/api/cre/sample?lat=1');
      return {
        id: 'sample',
        label: 'Sample',
        status: 'ready',
        values: [{ label: 'Rows', value: ++calls }],
        credit: { text: 'Agency', url: '', license: '' },
        sourceUrls: [],
        retrievedAt: '2026-09-22T12:00:00Z',
      };
    },
  };
  const controller = createDossierController({
    sections: [section],
    timeoutMs: 25,
    fetchImpl: async () => ({
      clone: () => ({ json: () => new Promise(() => {}) }),
    }),
  });
  await controller.run(PLACE);
  await controller.run(PLACE, { refresh: true });
  const entry = controller.getSnapshot().sections[0];
  assert.equal(entry.refresh.status, 'failed');
  assert.equal(entry.result.values[0].value, 1);
});

test('successful subrequest metadata cannot mask a later section timeout', async (t) => {
  quiet(t);
  let calls = 0;
  const section = {
    id: 'sample',
    label: 'Sample',
    order: 1,
    async load(_ctx, { fetchImpl }) {
      calls++;
      if (calls > 1) {
        await fetchImpl('/api/cre/sample');
        return new Promise(() => {});
      }
      return {
        id: 'sample',
        label: 'Sample',
        status: 'ready',
        values: [{ label: 'Finding', value: 1 }],
        credit: { text: 'Agency', url: '', license: '' },
        sourceUrls: [],
        retrievedAt: '2026-09-22T12:00:00Z',
      };
    },
  };
  const controller = createDossierController({
    sections: [section],
    timeoutMs: 25,
    fetchImpl: async () => ({
      ok: true,
      clone: () => ({
        json: async () => ({
          refresh: { status: 'succeeded', attemptedAt: '2026-09-23T12:00:00Z' },
        }),
      }),
    }),
  });
  await controller.run(PLACE);
  await controller.run(PLACE, { refresh: true });
  const entry = controller.getSnapshot().sections[0];
  assert.equal(entry.refresh.status, 'failed');
  assert.equal(entry.result.values[0].value, 1);
});

test('a throwing section is unavailable while its sibling is ready (S7)', async (t) => {
  quiet(t);
  const controller = createDossierController({
    sections: [
      fixtureSection({ id: 'bad', label: 'Bad', order: 1, throws: true }),
      fixtureSection({
        id: 'good',
        label: 'Good',
        order: 2,
        values: () => [{ label: 'Units', value: 120 }],
      }),
    ],
  });
  await controller.run(PLACE);
  const snap = controller.getSnapshot();
  const byId = Object.fromEntries(snap.sections.map((s) => [s.id, s]));
  assert.equal(byId.bad.status, 'unavailable');
  assert.match(byId.bad.result.message, /Bad did not answer/);
  assert.doesNotMatch(byId.bad.result.message, /on purpose/);
  assert.equal(byId.good.status, 'ready');
  assert.equal(byId.good.result.values[0].value, 120);
  assert.equal(snap.state, DOSSIER_STATE.PARTIAL);
});

test('a section returning a placeholder value is demoted to unavailable', async (t) => {
  quiet(t);
  const controller = createDossierController({
    sections: [
      fixtureSection({
        id: 'fake',
        label: 'Fake',
        order: 1,
        values: () => [{ label: 'Rent', value: 'placeholder' }],
      }),
    ],
  });
  await controller.run(PLACE);
  assert.equal(controller.getSnapshot().sections[0].status, 'unavailable');
});

test('an aborted run never writes a late result', async () => {
  const changes = [];
  let release;
  const slow = {
    id: 'slow',
    label: 'Slow',
    order: 1,
    load: () =>
      new Promise((resolve) => {
        release = () =>
          resolve({
            id: 'slow',
            label: 'Slow',
            status: 'ready',
            values: [{ label: 'Old', value: 'stale site' }],
            credit: { text: 'x', url: '', license: '' },
            sourceUrls: [],
            retrievedAt: new Date().toISOString(),
          });
      }),
  };
  const controller = createDossierController({
    sections: [slow],
    onChange: (snap, change) => changes.push([change.type, snap.state]),
  });
  const first = controller.run(PLACE);
  controller.noMatch('zzzz');
  release();
  await first;
  const snap = controller.getSnapshot();
  assert.equal(snap.state, DOSSIER_STATE.NO_MATCH);
  assert.equal(snap.message, NO_MATCH_MESSAGE);
  assert.deepEqual(
    changes.map(([type]) => type),
    ['run', 'no-match'],
  );
});

test('the abort signal reaches the section when a new search starts', async () => {
  let seen;
  const controller = createDossierController({
    sections: [
      {
        id: 'watch',
        label: 'Watch',
        order: 1,
        load: (_ctx, { signal }) => {
          seen = signal;
          return new Promise(() => {});
        },
      },
    ],
  });
  void controller.run(PLACE);
  assert.equal(seen.aborted, false);
  void controller.run({ ...PLACE, lat: 33.77 });
  assert.equal(seen.aborted, false, 'second run got a fresh signal');
  controller.destroy();
  assert.equal(seen.aborted, true);
});

test('sections run in parallel and settle in any order', async () => {
  const controller = createDossierController({ sections: FIXTURE_SECTIONS });
  const started = Date.now();
  const warn = console.warn;
  console.warn = () => {};
  await controller.run(PLACE);
  console.warn = warn;
  const elapsed = Date.now() - started;
  // Sum of fixture delays is about 3.5 s; parallel means about the longest.
  assert.ok(elapsed < 1500, `took ${elapsed} ms`);
  const snap = controller.getSnapshot();
  assert.equal(snap.sections.length, 11);
  assert.equal(snap.sections.filter((s) => s.status === 'ready').length, 8);
  assert.deepEqual(
    snap.sections.map((s) => s.id),
    [
      'location',
      'hazards',
      'demographics',
      'jobs',
      'access',
      'schools',
      'incentives',
      'supply',
      'rents',
      'amenities',
      'cameras',
    ],
  );
});

test('panel state derivation', () => {
  assert.equal(derivePanelState(['ready', SECTION_LOADING]), 'loading');
  assert.equal(derivePanelState(['ready', 'empty', 'needs-key']), 'ready');
  assert.equal(derivePanelState(['ready', 'unavailable']), 'partial');
  assert.equal(derivePanelState([]), 'ready');
});

test('context carries rings, parses state and ZIP, keeps optional tract', () => {
  const ctx = buildSectionContext(PLACE);
  assert.deepEqual(ctx.rings, { ...RINGS_M });
  assert.equal(ctx.state, 'TN');
  assert.equal(ctx.zip, '37601');
  assert.equal(ctx.tractGeoid, '47179061900');
  const bare = buildSectionContext({ lat: 1, lng: 2, label: 'Somewhere' });
  assert.equal(bare.lon, 2);
  assert.equal('tractGeoid' in bare, false);
  assert.throws(() => buildSectionContext({ lat: 'x', lon: 1 }), RangeError);
});

test('race: two quick searches never show the first address under the second (B1-07)', async () => {
  const pending = [];
  const signals = [];
  const section = {
    id: 'rents',
    label: 'Rents',
    order: 1,
    load(ctx, { signal }) {
      signals.push(signal);
      return new Promise((resolve) => {
        pending.push(() =>
          resolve({
            id: 'rents',
            label: 'Rents',
            status: 'ready',
            values: [{ label: 'Address seen', value: ctx.address }],
            credit: { text: 'Fixture', url: '', license: '' },
            sourceUrls: [],
            retrievedAt: new Date().toISOString(),
          }),
        );
      });
    },
  };
  const seen = [];
  const controller = createDossierController({
    sections: [section],
    onChange: (snap) => seen.push(snap),
  });
  const first = controller.run({ ...PLACE, matchedAddress: 'FIRST ADDRESS' });
  controller.searching('675 Ponce de Leon Ave NE, Atlanta, GA');
  const cleared = controller.getSnapshot();
  assert.equal(cleared.state, DOSSIER_STATE.LOADING);
  assert.equal(cleared.ctx, null, 'old header gone at once');
  assert.deepEqual(cleared.sections, [], 'old values gone at once');
  assert.equal(signals[0].aborted, true, 'first run aborted');
  const second = controller.run({
    lat: 33.772,
    lon: -84.366,
    matchedAddress: 'SECOND ADDRESS',
  });
  // The first load answers late, after the second search began.
  pending[0]();
  await first;
  pending[1]();
  await second;
  const after = seen.slice(seen.indexOf(cleared));
  for (const snap of after) {
    const text = JSON.stringify(snap);
    assert.doesNotMatch(text, /FIRST ADDRESS/, 'first address leaked');
  }
  const final = controller.getSnapshot();
  assert.equal(final.ctx.address, 'SECOND ADDRESS');
  assert.equal(final.sections[0].result.values[0].value, 'SECOND ADDRESS');
});

test('negative: without searching(), the old dossier would still be on screen', async () => {
  const controller = createDossierController({
    sections: [
      fixtureSection({
        id: 'a',
        label: 'A',
        order: 1,
        values: () => [{ label: 'Units', value: 1 }],
      }),
    ],
  });
  await controller.run({ ...PLACE, matchedAddress: 'FIRST ADDRESS' });
  // This is the B1-07 state the checker above must reject.
  assert.match(JSON.stringify(controller.getSnapshot()), /FIRST ADDRESS/);
});

test('outside the US: no section runs and the message says US only (B1-14)', async () => {
  let loads = 0;
  const controller = createDossierController({
    sections: [
      fixtureSection({ id: 'a', label: 'A', order: 1 }),
      { id: 'b', label: 'B', order: 2, load: async () => loads++ },
    ],
  });
  controller.outsideUs('Myrhorod, Poltava Oblast, Ukraine');
  const snap = controller.getSnapshot();
  assert.equal(snap.state, DOSSIER_STATE.OUTSIDE_US);
  assert.deepEqual(snap.sections, []);
  assert.equal(loads, 0);
  assert.match(snap.message, /^US addresses only\. .*Ukraine/);
});

test('city mismatch: no section runs, the message names the distance, and the fallback data is kept for the "use city center" action (B1)', async () => {
  let loads = 0;
  const controller = createDossierController({
    sections: [
      fixtureSection({ id: 'a', label: 'A', order: 1 }),
      { id: 'b', label: 'B', order: 2, load: async () => loads++ },
    ],
  });
  const cityCenter = { lat: 30.3211, lng: -104.0212, label: 'Marfa, TX' };
  controller.cityMismatch({
    typed: '101 Main St, Marfa TX',
    matchLabel: '101 MAIN ST, GEORGETOWN, TX, 78626',
    milesOff: 379,
    cityCenter,
  });
  const snap = controller.getSnapshot();
  assert.equal(snap.state, DOSSIER_STATE.CITY_MISMATCH);
  assert.deepEqual(snap.sections, []);
  assert.equal(loads, 0);
  assert.equal(
    snap.message,
    'No street match for 101 Main St, Marfa TX. Closest result: 101 MAIN ST, GEORGETOWN, TX, 78626, 379 miles away.',
  );
  assert.deepEqual(snap.mismatch, {
    typed: '101 Main St, Marfa TX',
    matchLabel: '101 MAIN ST, GEORGETOWN, TX, 78626',
    milesOff: 379,
    cityCenter,
    unresolved: false,
    matchedPlace: null,
  });
});

test('S4: an unresolved city mismatch (Photon unreachable) shows the "could not confirm" message, not a distance', () => {
  const controller = createDossierController({
    sections: FIXTURE_SECTIONS,
    fetchImpl: async () => {},
  });
  controller.cityMismatch({
    typed: '101 Main St, Marfa TX',
    matchLabel: '101 MAIN ST, GEORGETOWN, TX, 78626',
    unresolved: true,
  });
  const snap = controller.getSnapshot();
  assert.equal(snap.state, DOSSIER_STATE.CITY_MISMATCH);
  assert.equal(
    snap.message,
    'Could not confirm the city for 101 Main St, Marfa TX (the city-check service is unreachable). Use the matched pin anyway, or try another address.',
  );
  assert.equal(snap.mismatch.unresolved, true);
  assert.equal(snap.mismatch.milesOff, 0);
});

test('N-2: an unresolved city mismatch keeps the original matched pin, so it can be used anyway', () => {
  const controller = createDossierController({
    sections: FIXTURE_SECTIONS,
    fetchImpl: async () => {},
  });
  const matchedPlace = { lat: 33.7, lng: -84.4, label: 'Marfa area match' };
  controller.cityMismatch({
    typed: '101 Main St, Marfa TX',
    matchLabel: '101 MAIN ST, GEORGETOWN, TX, 78626',
    unresolved: true,
    matchedPlace,
  });
  const snap = controller.getSnapshot();
  assert.deepEqual(snap.mismatch.matchedPlace, matchedPlace);
});

test('an approximate place carries its warning into the context', () => {
  const ctx = buildSectionContext({
    lat: 36.299,
    lon: -82.383,
    label: 'ZIP 37601',
    approximate: 'Approximate match: center of ZIP 37601, not a street address',
    otherMatches: ['a', 'b', 'c', 'd'],
  });
  assert.match(ctx.approximate, /not a street address/);
  assert.deepEqual(ctx.otherMatches, ['a', 'b', 'c']);
  assert.equal(buildSectionContext(PLACE).approximate, undefined);
});

test('a hung section times out to unavailable instead of Loading forever (B1-21)', async (t) => {
  quiet(t);
  let seenSignal = null;
  const controller = createDossierController({
    timeoutMs: 50,
    sections: [
      {
        id: 'hung',
        label: 'Rents',
        order: 1,
        load: (ctx, { signal }) => {
          seenSignal = signal;
          return new Promise(() => {});
        },
      },
      fixtureSection({
        id: 'fast',
        label: 'Fast',
        order: 2,
        values: () => [{ label: 'Units', value: 3 }],
      }),
    ],
  });
  const started = Date.now();
  await controller.run(PLACE);
  assert.ok(Date.now() - started < 2000);
  const byId = Object.fromEntries(
    controller.getSnapshot().sections.map((s) => [s.id, s]),
  );
  assert.equal(byId.hung.status, 'unavailable');
  assert.match(byId.hung.result.message, /Rents did not answer/);
  assert.equal(seenSignal.aborted, true, 'the hung load was told to stop');
  assert.equal(byId.fast.status, 'ready');
  assert.equal(controller.getSnapshot().state, DOSSIER_STATE.PARTIAL);
});
