import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createResearchWorkspace,
  researchContextKey,
} from './researchWorkspace.js';

const site = (overrides = {}) => ({
  address: '100 Main St, Atlanta, GA',
  lat: 33.75,
  lon: -84.39,
  jurisdiction: 'Fulton County, GA',
  radiusMiles: 3,
  locationConfirmed: true,
  ...overrides,
});

function memoryStorage(initial = null) {
  const values = new Map(
    initial ? [['gods-eye-cre-research-v1', initial]] : [],
  );
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    values,
  };
}

test('research identity includes radius, coordinates, address, and jurisdiction', () => {
  const a = site();
  assert.notEqual(
    researchContextKey(a),
    researchContextKey(site({ radiusMiles: 5 })),
  );
  assert.notEqual(
    researchContextKey(a),
    researchContextKey(site({ jurisdiction: 'DeKalb County, GA' })),
  );
  assert.notEqual(
    researchContextKey(a),
    researchContextKey(site({ lat: 33.76 })),
  );
  assert.equal(
    researchContextKey(a),
    researchContextKey(site({ lat: 33.7500001 })),
  );
});

test('saved preferences, explicit auto-run, and role changes do not duplicate research', async () => {
  const storage = memoryStorage();
  let calls = 0;
  const provider = async ({ layer }) => {
    calls += 1;
    return {
      status: 'ready',
      summary: `${layer} done`,
      evidence: [],
      sources: [],
      usage: null,
    };
  };
  const workspace = createResearchWorkspace({
    documentRef: null,
    storage,
    provider,
  });
  workspace.setPreferences({
    autoRun: true,
    budgetPerAddress: 2,
    selected: ['crime', 'walking'],
  });
  workspace.setContext(site({ locationConfirmed: false }));
  await Promise.resolve();
  assert.equal(calls, 0, 'unconfirmed geocodes must not auto-run');
  workspace.setContext(site());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);
  assert.equal(workspace.getSnapshot().usage.calls, 2);
  workspace.setRole('developer');
  workspace.setRole('investor');
  assert.equal(
    calls,
    2,
    'switching roles is a presentation/preference change only',
  );
  assert.deepEqual(workspace.getSelected(), ['crime', 'walking']);
  const stored = JSON.parse(storage.values.get('gods-eye-cre-research-v1'));
  assert.equal(stored.snapshot.layers.length, 2);
  workspace.destroy();
});

test('an intentionally empty role selection survives switching and refresh', () => {
  const storage = memoryStorage();
  const workspace = createResearchWorkspace({ documentRef: null, storage });
  workspace.setSelected([]);
  workspace.setRole('developer');
  workspace.setRole('investor');
  assert.deepEqual(workspace.getSelected(), []);
  workspace.destroy();
  const reloaded = createResearchWorkspace({ documentRef: null, storage });
  reloaded.setRole('investor');
  assert.deepEqual(reloaded.getSelected(), []);
});

test('restore is context-bound and does not invoke a provider; empty restore clears prior layers', async () => {
  let calls = 0;
  const storage = memoryStorage();
  const workspace = createResearchWorkspace({
    documentRef: null,
    storage,
    provider: async () => {
      calls += 1;
      return { status: 'ready', evidence: [], sources: [] };
    },
  });
  workspace.setContext(site());
  const snapshot = {
    version: 1,
    contextKey: researchContextKey(site()),
    role: 'investor',
    status: 'ready',
    updatedAt: '2026-09-23T12:00:00Z',
    usage: { calls: 1 },
    layers: [
      {
        id: 'crime',
        label: 'ignored',
        status: 'ready',
        summary: 'Saved finding',
        evidence: [],
        sources: [],
      },
    ],
  };
  assert.equal(workspace.restore(snapshot, site()), true);
  assert.equal(workspace.getSnapshot().layers[0].summary, 'Saved finding');
  assert.equal(calls, 0);
  assert.equal(
    workspace.restore(undefined, site({ address: '200 Main St, Atlanta, GA' })),
    true,
  );
  assert.equal(workspace.getSnapshot().layers.length, 0);
  assert.equal(workspace.getSnapshot().usage.calls, 0);
});

test('changing site invalidates late provider results and blank context cancels current generation', async () => {
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const workspace = createResearchWorkspace({
    documentRef: null,
    storage: memoryStorage(),
    provider: () => pending,
  });
  workspace.setSelected(['crime']);
  workspace.setContext(site());
  const run = workspace.runSelected();
  await new Promise((resolve) => setImmediate(resolve));
  workspace.setContext(site({ address: '200 Main St, Atlanta, GA' }));
  release({
    status: 'ready',
    summary: 'Late result',
    evidence: [],
    sources: [],
  });
  await run;
  assert.deepEqual(workspace.getSnapshot().layers, []);
  workspace.setContext(site());
  const second = workspace.runSelected();
  await new Promise((resolve) => setImmediate(resolve));
  workspace.setContext(null);
  release({
    status: 'ready',
    summary: 'Late result',
    evidence: [],
    sources: [],
  });
  await second;
  assert.equal(workspace.getSnapshot(), null);
});

test('restoring a different candidate invalidates an active research generation', async () => {
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const workspace = createResearchWorkspace({
    documentRef: null,
    storage: memoryStorage(),
    provider: () => pending,
  });
  workspace.setSelected(['crime']);
  workspace.setContext(site());
  const run = workspace.runSelected();
  await new Promise((resolve) => setImmediate(resolve));
  const candidate = site({ address: '200 Main St, Atlanta, GA', lat: 33.76 });
  assert.equal(workspace.restore(null, candidate), true);
  release({
    status: 'ready',
    summary: 'Late result from previous candidate',
    evidence: [],
    sources: [],
  });
  await run;
  assert.equal(workspace.getSnapshot().site.address, candidate.address);
  assert.deepEqual(workspace.getSnapshot().layers, []);
  assert.equal(workspace.getSnapshot().usage.calls, 0);
});

test('default workspace performs no IO and reports optional research as skipped', async () => {
  const workspace = createResearchWorkspace({
    documentRef: null,
    storage: memoryStorage(),
  });
  workspace.setSelected(['crime']);
  workspace.setContext(site());
  assert.equal(await workspace.runSelected(), false);
  const snapshot = workspace.getSnapshot();
  assert.equal(snapshot.layers[0].status, 'skipped');
  assert.match(snapshot.layers[0].message, /No site information was sent/);
  assert.equal(snapshot.usage.calls, 0);
});
