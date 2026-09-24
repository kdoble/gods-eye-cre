// Tests for the time slider's layer handling on a fake viewer (one overlay at index 1, previous removed, compare splits left and right) and for the shared Wayback changes fetch.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  captionFor,
  createImageryOverlay,
  orderOldestFirst,
} from './timeSlider.js';
import {
  clearWaybackChangesCache,
  createWaybackImageryProvider,
  fetchWaybackChanges,
} from './waybackProvider.js';

const SplitDirection = Object.freeze({ LEFT: -1, NONE: 0, RIGHT: 1 });
const FakeCesium = { SplitDirection };

function fakeViewer() {
  const list = [{ name: 'base' }];
  return {
    scene: { splitPosition: 0 },
    imageryLayers: {
      get length() {
        return list.length;
      },
      addImageryProvider(provider, index) {
        const layer = { provider, splitDirection: SplitDirection.NONE };
        list.splice(index ?? list.length, 0, layer);
        return layer;
      },
      contains: (layer) => list.includes(layer),
      remove(layer) {
        const at = list.indexOf(layer);
        if (at >= 0) list.splice(at, 1);
        return at >= 0;
      },
      indexOf: (layer) => list.indexOf(layer),
      get: (i) => list[i],
    },
    list,
  };
}

const change = (release, releaseDate, extra = {}) => ({
  release,
  releaseDate,
  tileTemplate: `https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/WMTS/1.0.0/default028mm/MapServer/tile/${release}/{z}/{y}/{x}`,
  captureDate: null,
  resolutionM: null,
  provider: null,
  ...extra,
});

const OLD = change(10, '2014-02-20');
const NEW = change(64001, '2026-02-26', {
  captureDate: '2025-04-19',
  resolutionM: 0.5,
  provider: 'Vantor Vivid Advanced',
});

const makeOverlay = (viewer) =>
  createImageryOverlay(viewer, {
    Cesium: FakeCesium,
    createProvider: (c) => ({ release: c.release }),
  });

test('selecting a release adds one layer at index 1 and removes the previous one', () => {
  const viewer = fakeViewer();
  const overlay = makeOverlay(viewer);
  const first = overlay.show(OLD);
  assert.equal(viewer.list.length, 2);
  assert.equal(viewer.imageryLayers.indexOf(first), 1);
  assert.equal(first.provider.release, 10);
  const second = overlay.show(NEW);
  assert.equal(viewer.list.length, 2, 'the previous overlay is removed');
  assert.equal(viewer.imageryLayers.indexOf(second), 1);
  assert.equal(viewer.imageryLayers.contains(first), false);
  assert.equal(viewer.list[0].name, 'base', 'base layer untouched');
});

test('compare splits the reference left and the selected release right', () => {
  const viewer = fakeViewer();
  const overlay = makeOverlay(viewer);
  overlay.show(OLD);
  overlay.setCompare(true, NEW);
  assert.equal(viewer.list.length, 3);
  assert.equal(overlay.overlay.splitDirection, SplitDirection.RIGHT);
  assert.equal(overlay.reference.splitDirection, SplitDirection.LEFT);
  assert.equal(overlay.reference.provider.release, 64001);
  assert.equal(viewer.scene.splitPosition, 0.5);
  overlay.setSplitPosition(0.3);
  assert.equal(viewer.scene.splitPosition, 0.3);
  overlay.setCompare(false);
  assert.equal(viewer.list.length, 2);
  assert.equal(overlay.overlay.splitDirection, SplitDirection.NONE);
  assert.equal(viewer.scene.splitPosition, 0, 'split restored');
  overlay.clear();
  assert.deepEqual(
    viewer.list.map((l) => l.name),
    ['base'],
  );
});

test('an empty imagery stack gets the overlay at index 0, not a gap', () => {
  const viewer = fakeViewer();
  viewer.list.length = 0;
  const layer = makeOverlay(viewer).show(OLD);
  assert.equal(viewer.imageryLayers.indexOf(layer), 0);
});

test('slider order is oldest first; captions prefer the capture date', () => {
  assert.deepEqual(
    orderOldestFirst([NEW, OLD]).map((c) => c.release),
    [10, 64001],
  );
  assert.equal(
    captionFor(NEW),
    'captured 2025-04-19, Wayback release 2026-02-26, 0.5 m source, Vantor Vivid Advanced',
  );
  assert.equal(captionFor(OLD), 'Wayback release 2014-02-20');
});

test('the Cesium provider uses the release template and maximumLevel 19', () => {
  const made = [];
  class UrlTemplateImageryProvider {
    constructor(options) {
      made.push(options);
    }
  }
  class Credit {
    constructor(html) {
      this.html = html;
    }
  }
  createWaybackImageryProvider(NEW, {
    Cesium: { UrlTemplateImageryProvider, Credit },
  });
  assert.equal(made[0].url, NEW.tileTemplate);
  assert.equal(made[0].maximumLevel, 19);
  assert.match(made[0].credit.html, /^Esri, Vantor, Earthstar Geographics/);
});

test('fetchWaybackChanges shares one request and drops non-Esri templates', async () => {
  clearWaybackChangesCache();
  let calls = 0;
  const fetchImpl = async (url) => {
    calls += 1;
    assert.equal(url, '/api/cre/wayback/changes?lat=36.320692&lon=-82.342509');
    return new Response(
      JSON.stringify({
        status: 'ready',
        retrievedAt: '2026-09-22T12:00:00.000Z',
        data: {
          releases: [
            NEW,
            OLD,
            { ...OLD, release: 5, tileTemplate: 'https://evil.example/{z}' },
          ],
          unknown: [],
          catalog: { count: 196 },
        },
      }),
    );
  };
  const [a, b] = await Promise.all([
    fetchWaybackChanges(36.320692, -82.342509, { fetchImpl }),
    fetchWaybackChanges(36.320692, -82.342509, { fetchImpl }),
  ]);
  assert.equal(calls, 1);
  assert.equal(a, b);
  assert.deepEqual(
    a.releases.map((r) => r.release),
    [64001, 10],
  );
});

test('negative: a failed changes request is not remembered', async () => {
  clearWaybackChangesCache();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response('{}', { status: 502 });
  };
  await assert.rejects(fetchWaybackChanges(1, 2, { fetchImpl }));
  await assert.rejects(fetchWaybackChanges(1, 2, { fetchImpl }));
  assert.equal(calls, 2);
});
