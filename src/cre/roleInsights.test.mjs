import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRoleInsights,
  groupIsNoData,
  partitionGroups,
} from './roleInsights.js';
import { createDossierPanel } from './dossierPanel.js';
import { createFakeDocument } from './testing/fakeDom.mjs';

const section = (id, values, extra = {}) => ({
  id,
  label: id,
  status: 'ready',
  result: {
    id,
    status: 'ready',
    values,
    retrievedAt: '2026-09-23T14:00:00.000Z',
    credit: { text: `${id} publisher`, url: `https://data.example/${id}` },
    sourceUrls: [`https://data.example/${id}`],
    ...extra,
  },
});

const snapshot = {
  ctx: {
    address: '1 Main St',
    lat: 36,
    lon: -82,
    locationConfirmed: true,
    radiusMiles: 3,
  },
  sections: [
    section('neighborhood', [
      {
        label: 'Reported incidents (12 months)',
        value: 31,
        note: '2025-09 to 2026-08; block-aggregated',
      },
      { label: 'Mapped major road segments', value: 8 },
      { label: 'Johnson City zoning district (verify)', value: 'R-3' },
    ]),
    section('destinations', [
      {
        label: 'Grocery: Example Market',
        value: '12 min walk',
        note: 'Routed walk: 0.6 mi',
      },
      { label: 'Retail: Regional Plaza', value: '8 min drive' },
    ]),
    section('location', [
      {
        label: 'EPA Walkability Index',
        value: 12,
        note: 'Block group; 2021 release',
      },
      { label: 'Elevation', value: 1400, unit: 'ft' },
    ]),
    section(
      'demographics',
      Array.from({ length: 20 }, (_, i) => ({
        label: `Population group ${i}`,
        value: 100 + i,
      })),
    ),
  ],
};

test('investor insight groups foreground only matching crime, walkability and retail evidence', () => {
  const view = buildRoleInsights(snapshot, 'investor');
  assert.deepEqual(
    view.groups.slice(0, 3).map((group) => group.id),
    ['crime', 'walkability', 'retail-access'],
  );
  const crime = view.groups[0];
  assert.equal(crime.items.length, 1);
  assert.match(crime.items[0].text, /31.*2025-09 to 2026-08.*block-aggregated/);
  assert.equal(crime.items[0].source, 'neighborhood publisher');
  assert.equal(crime.items[0].retrievedAt, '2026-09-23T14:00:00.000Z');
  const walk = view.groups[1];
  assert.ok(walk.items.some((item) => item.label.startsWith('Grocery:')));
  assert.ok(walk.items.some((item) => item.label === 'EPA Walkability Index'));
  assert.ok(walk.items.every((item) => item.label !== 'Elevation'));
  assert.ok(
    view.groups[2].items.some((item) => item.label.startsWith('Retail:')),
  );
  assert.ok(
    view.groups[2].items.every((item) => !item.label.startsWith('Grocery:')),
  );
  assert.ok(
    view.groups[3].items.length <= 7,
    'large market sections stay compact',
  );
});

test('developer parcel group filters out unrelated neighborhood values and never infers feasibility', () => {
  const view = buildRoleInsights(snapshot, 'developer');
  assert.deepEqual(
    view.groups.slice(0, 2).map((group) => group.id),
    ['crime', 'parcel'],
  );
  assert.deepEqual(
    view.groups[1].items.map((item) => item.label),
    ['Johnson City zoning district (verify)'],
  );
  assert.ok(
    view.questions.some((question) => /no area is inferred/i.test(question)),
  );
});

test('missing crime stays unknown, never zero or low risk', () => {
  const view = buildRoleInsights(
    {
      ctx: snapshot.ctx,
      sections: [
        section('neighborhood', [
          { label: 'Mapped major road segments', value: 0 },
        ]),
      ],
    },
    'investor',
  );
  const crime = view.groups[0];
  assert.match(crime.items[0].text, /No crime-specific result/);
  assert.match(crime.items[0].text, /does not establish absence or low risk/i);
  assert.doesNotMatch(crime.items[0].text, /0 incidents|safety rating/i);
});

test('published Johnson City crime source is concise while preserving source provenance', () => {
  const fullNote =
    'official local map with a long detailed source caveat '.repeat(30);
  const view = buildRoleInsights(
    {
      ctx: snapshot.ctx,
      sections: [
        section('neighborhood', [
          {
            label: 'Crime coverage',
            value: 'Official source published; incident feed not connected',
            note: fullNote,
            status: 'published-not-connected',
            partial: true,
            sourceUrls: ['https://city.example/police-map'],
          },
        ]),
      ],
    },
    'investor',
  );
  const crime = view.groups[0].items[0];
  assert.match(crime.text, /Official police map is published/);
  assert.match(crime.text, /No incident counts or rating/);
  assert.match(crime.text, /Full source notes and exclusions are in Details/);
  assert.ok(crime.text.length < 220);
  assert.doesNotMatch(crime.text, /long detailed source caveat/);
  assert.equal(crime.status, 'partial');
  assert.equal(crime.sourceStatus, 'published-not-connected');
  assert.ok(crime.sourceUrls.includes('https://city.example/police-map'));
});

test('group limits apply across sections and retail access excludes daily-needs destinations', () => {
  const many = (id, label, count) =>
    section(
      id,
      Array.from({ length: count }, (_, index) => ({
        label: `${label} ${index + 1}`,
        value: index + 1,
        note: 'named OSM destination within 5 km',
      })),
    );
  const groceries = many('destinations', 'Grocery: Market', 8);
  const retailers = many('destinations', 'Retail: Center', 8);
  const view = buildRoleInsights(
    {
      ctx: snapshot.ctx,
      sections: [
        section('destinations', [
          ...groceries.result.values,
          ...retailers.result.values,
        ]),
        many('demographics', 'Household income', 8),
        many('rents', 'Median rent', 8),
        many('jobs', 'Jobs within 15 min drive', 8),
        section('neighborhood', [
          { label: 'Mapped major road segments (max 3 mi)', value: 3 },
          { label: 'Drive to Regional Center', value: '12 min drive' },
        ]),
      ],
    },
    'investor',
  );
  const retail = view.groups.find((group) => group.id === 'retail-access');
  assert.ok(retail.items.some((item) => item.label === 'Retail: Center 1'));
  assert.ok(
    retail.items.some((item) => item.label === 'Drive to Regional Center'),
  );
  assert.ok(
    retail.items.some((item) => item.label.startsWith('Mapped major road')),
  );
  assert.ok(
    retail.items.every((item) => !/Grocery:|Pharmacy:/i.test(item.label)),
  );
  assert.ok(
    view.groups.find((group) => group.id === 'market').items.length <= 7,
  );
});

test('role tabs preserve existing details/map, expose analysis slot and keep shared research status available', () => {
  const doc = createFakeDocument();
  const changes = [];
  const panel = createDossierPanel({
    documentRef: doc,
    onRoleChange: (role) => changes.push(role),
  });
  panel.render(snapshot);
  assert.ok(panel.analysisSlot);
  assert.equal(panel.getRole(), 'investor');
  panel.setRole('developer');
  assert.equal(panel.getRole(), 'developer');
  assert.deepEqual(changes, [], 'boot role restoration does not write back');
  const buttons = panel.root.querySelectorAll('button');
  buttons.find((button) => button.textContent === 'Investor').click();
  assert.deepEqual(changes, ['investor']);
  buttons.find((button) => button.textContent === 'Details').click();
  assert.equal(
    panel.root.querySelector('[data-dossier-section="neighborhood"]') !== null,
    true,
  );
  buttons
    .find((button) => button.getAttribute('data-view') === 'analysis')
    .click();
  assert.equal(
    panel.root.querySelector('[data-cre-view-content="analysis"]').hidden,
    false,
  );
  panel.setResearchProgress({
    status: 'running',
    selectedIds: ['crime', 'walk'],
    results: [{ status: 'ready' }, { status: 'researching' }],
  });
  const progress = panel.root.querySelector('.cre-research-progress');
  assert.equal(progress.hidden, false);
  assert.match(progress.textContent, /1 of 2 ready · 1 researching/);
  progress.click();
  assert.equal(panel.getActiveView(), 'analysis');
});

test("a crime card with no local feed never cites another city's pilot program", () => {
  const view = buildRoleInsights(
    {
      ctx: snapshot.ctx,
      sections: [
        section('neighborhood', [
          {
            label: 'Crime coverage',
            value: 'Not supported in this locality',
            status: 'unsupported',
            partial: true,
            note: 'Not supported in this locality. No automatic local crime feed for this area. Coverage pilot: Chicago reported incidents only. Import a dated official GeoJSON layer or check local police records. Missing coverage does not mean low crime.',
            sourceUrls: ['https://data.cityofchicago.org/x'],
          },
        ]),
      ],
    },
    'investor',
  );
  const crime = view.groups[0].items[0];
  assert.doesNotMatch(crime.text, /Chicago|coverage pilot/i);
  assert.match(crime.text, /No automated crime feed for this city yet/i);
  assert.match(crime.text, /missing coverage does not mean low crime/i);
  assert.ok(
    !crime.sourceUrls.some((url) => /cityofchicago/i.test(url)),
    'the Chicago pilot data portal is not a relevant source for another city',
  );
});

test('an Atlanta-style published-but-unconnected crime feed keeps its own city source', () => {
  const view = buildRoleInsights(
    {
      ctx: snapshot.ctx,
      sections: [
        section('neighborhood', [
          {
            label: 'Crime coverage',
            value: 'Official source published; incident feed not connected',
            status: 'published-not-connected',
            partial: true,
            note: 'long source caveat',
            sourceUrls: ['https://atlantapd.org'],
          },
        ]),
      ],
    },
    'investor',
  );
  const crime = view.groups[0].items[0];
  assert.match(crime.text, /Official police map is published/);
  assert.ok(crime.sourceUrls.includes('https://atlantapd.org'));
});

test('groupIsNoData is true only when every item is unavailable, not connected or needs a key', () => {
  const noData = {
    id: 'crime',
    items: [{ status: 'unavailable' }, { status: 'unsupported' }],
  };
  const hasData = {
    id: 'market',
    items: [{ status: 'unavailable' }, { status: undefined, text: 'ok' }],
  };
  const needsKeyOnly = {
    id: 'market',
    items: [{ status: 'needs-key' }],
  };
  assert.equal(groupIsNoData(noData), true);
  assert.equal(groupIsNoData(hasData), false);
  assert.equal(groupIsNoData(needsKeyOnly), true);
});

test('partitionGroups moves every no-data group to the end, in its original order, and keeps the rest in place', () => {
  const groups = [
    { id: 'crime', items: [{ status: 'unavailable' }] },
    { id: 'walkability', items: [{ status: undefined }] },
    { id: 'retail-access', items: [{ status: 'unsupported' }] },
    { id: 'market', items: [{ status: undefined }] },
  ];
  const { visible, hidden } = partitionGroups(groups);
  assert.deepEqual(
    visible.map((g) => g.id),
    ['walkability', 'market'],
  );
  assert.deepEqual(
    hidden.map((g) => g.id),
    ['crime', 'retail-access'],
  );
});

test('role insight data is rendered as inert text and external sources keep safe URLs', () => {
  const doc = createFakeDocument();
  const hostile = {
    ctx: snapshot.ctx,
    sections: [
      section(
        'neighborhood',
        [{ label: 'Crime <img src=x>', value: '<script>bad()</script>' }],
        { sourceUrls: ['javascript:alert(1)', 'https://safe.example/data'] },
      ),
    ],
  };
  const panel = createDossierPanel({ documentRef: doc });
  panel.render(hostile);
  const crime = panel.root.querySelector('[data-cre-insight="crime"]');
  assert.match(crime.textContent, /<script>bad\(\)<\/script>/);
  assert.equal(crime.querySelectorAll('script').length, 0);
  const sourceLinks = crime.querySelectorAll('a');
  assert.ok(
    sourceLinks.some(
      (link) => link.getAttribute('href') === 'https://safe.example/data',
    ),
  );
  assert.ok(
    sourceLinks.every((link) =>
      link.getAttribute('href').startsWith('https://'),
    ),
  );
});
