import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_CANDIDATES,
  WORKSPACE_KEY,
  createWorkspace,
  csvCell,
  safeSourceUrl,
  validCandidate,
  MAX_SNAPSHOT_OVERLAY_VERTICES,
} from './workspace.js';
import { buildComparisonHtml, buildScreeningBrief } from './printPage.js';

const candidate = (over = {}) => ({
  id: 'candidate-1',
  schema: 'gods-eye-cre/dossier@1',
  generatedAt: '2026-09-22T12:00:00.000Z',
  radiusMiles: 1,
  site: { lat: 36.3, lon: -82.3, address: 'Test site' },
  sections: [],
  ...over,
});

function memoryStorage(initial = null) {
  let value = initial;
  return {
    getItem: (key) => (key === WORKSPACE_KEY ? value : null),
    setItem: (key, next) => {
      if (key === WORKSPACE_KEY) value = next;
    },
    value: () => value,
  };
}

test('candidate restore accepts a clean versioned backup and enforces five-site limit', () => {
  const storage = memoryStorage();
  const workspace = createWorkspace(storage);
  for (let i = 0; i < MAX_CANDIDATES; i++)
    workspace.save(candidate({ id: `site-${i}` }));
  assert.equal(workspace.list().length, MAX_CANDIDATES);
  assert.throws(
    () => workspace.save(candidate({ id: 'site-overflow' })),
    /five sites/,
  );
});

test('unreadable saved state is not overwritten by a later save', () => {
  const damaged = '{truncated';
  const storage = memoryStorage(damaged);
  const workspace = createWorkspace(storage);
  assert.match(workspace.problem, /left intact/);
  assert.throws(() => workspace.save(candidate()), /backup|read/i);
  assert.equal(storage.value(), damaged);
});

test('backup candidates with a report-injection radius are rejected before restore', () => {
  const payload = JSON.stringify({
    schema: 'gods-eye-cre/candidates@1',
    candidates: [candidate({ radiusMiles: '<img src=x onerror=alert(1)>' })],
  });
  const workspace = createWorkspace(memoryStorage());
  assert.throws(
    () => workspace.importBackup(payload),
    /invalid|candidate|radius/i,
  );
});

test('reports normalize backup-controlled radius text before building one-site and comparison output', () => {
  const malicious = '<svg onload=alert(1)>';
  const doc = {
    site: candidate().site,
    radiusMiles: malicious,
    sections: [],
    generatedAt: '2026-09-22T12:00:00.000Z',
  };
  const brief = buildScreeningBrief(doc);
  assert.doesNotMatch(brief, /<svg onload/);
  assert.match(brief, /Selected area:<\/b> 1 mile/);
  const result = buildComparisonHtml([
    candidate(),
    candidate({ id: 'candidate-2', radiusMiles: malicious }),
  ]);
  assert.doesNotMatch(result, /<svg onload/);
  assert.match(result, /1 mi; point estimated/);
});

test('source URLs drop credentials and CSV text cells neutralize spreadsheet formulas', () => {
  assert.equal(
    safeSourceUrl('https://example.com/data?api_key=secret&year=2025'),
    'https://example.com/data?year=2025',
  );
  assert.equal(
    csvCell('  =HYPERLINK("https://bad")'),
    '"\'  =HYPERLINK(""https://bad"")"',
  );
  assert.equal(
    csvCell(-4),
    '"-4"',
    'numeric negatives remain data, not formulas',
  );
});

const withOverlay = (geojson) =>
  candidate({
    sections: [
      {
        id: 'hazards',
        label: 'Hazards',
        status: 'ready',
        values: [{ label: 'Mapped result', value: 'Available' }],
        credit: { text: 'Public source', url: '', license: 'Public domain' },
        sourceUrls: [],
        retrievedAt: '2026-09-22T12:00:00.000Z',
        overlays: [{ id: 'source-overlay', geojson }],
      },
    ],
  });

test('candidate validation accepts bounded source geometry without import acreage checks', () => {
  const many = Array.from({ length: 25_001 }, () => [-82.3, 36.3]);
  assert.equal(
    validCandidate(withOverlay({ type: 'LineString', coordinates: many })),
    true,
  );
});

test('candidate validation rejects malformed source geometry and out-of-range positions', () => {
  assert.equal(
    validCandidate(
      withOverlay({
        type: 'LineString',
        coordinates: [
          [-82.3, 36.3],
          [181, 36.3],
        ],
      }),
    ),
    false,
  );
  assert.equal(
    validCandidate(
      withOverlay({
        type: 'Polygon',
        coordinates: [
          [
            [-82.3, 36.3],
            [-82.2, 36.3],
            [-82.2, 36.4],
          ],
        ],
      }),
    ),
    false,
  );
});

test('candidate validation enforces one aggregate overlay vertex budget', () => {
  const large = Array.from(
    { length: MAX_SNAPSHOT_OVERLAY_VERTICES + 1 },
    () => [-82.3, 36.3],
  );
  assert.equal(
    validCandidate(withOverlay({ type: 'LineString', coordinates: large })),
    false,
  );
});
