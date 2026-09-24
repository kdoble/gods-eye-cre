// "At a glance" summary: the investor's first questions (flood, incentives, income and renters, rents, supply, jobs, environmental, schools) read from the other sections' results, with each unfinished section's honest status instead of a stand-in.
import { SECTION_STATUS, isPlaceholderValue } from './contract.js';
import { SECTION_LOADING } from './dossierController.js';
import { DRIVE_TIME_MINUTES } from './config.js';
import {
  FLOOD_LABELS,
  FLOOD_NOTES,
  FLOOD_SFHA_UNDETERMINED,
  FLOOD_SFHA_UNKNOWN,
} from './sections/hazards.js';
import { ZORI_CHANGE_12M_LABEL } from './sections/rents.js';
import { formatLabeledValue, formatSignedPercent } from './format.js';

const num = (value, digits = 0) =>
  Number(value).toLocaleString('en-US', { maximumFractionDigits: digits });
const money = (value) => `$${num(Math.round(Number(value)))}`;
const signed = (value) => `${Number(value) > 0 ? '+' : ''}${num(value, 1)}`;
const plural = (n, one, many) => `${num(n)} ${Number(n) === 1 ? one : many}`;
const isNum = (value) => typeof value === 'number' && Number.isFinite(value);

/** First value row whose label passes `test`; a stand-in value never counts. */
const row = (result, test) =>
  (result?.values || []).find(
    (item) =>
      (typeof test === 'string' ? item.label === test : test(item.label)) &&
      !isPlaceholderValue(item.value),
  ) || null;

function readFlood(result) {
  const zone = row(result, FLOOD_LABELS.zone);
  if (!zone) return null;
  const sfhaRow = row(result, FLOOD_LABELS.sfha);
  const undetermined = String(sfhaRow?.value) === FLOOD_SFHA_UNDETERMINED;
  const unknown = String(sfhaRow?.value) === FLOOD_SFHA_UNKNOWN;
  const sfha = sfhaRow?.value === 'Yes';
  const name = /^zone\b/i.test(String(zone.value))
    ? zone.value
    : `Zone ${zone.value}`;
  const parts = [
    `${name} at the site, ${
      undetermined
        ? 'flood hazard not determined by FEMA'
        : unknown
          ? 'SFHA status unknown from FEMA data'
          : `${sfha ? 'inside' : 'outside'} the 100-year floodplain`
    }`,
  ];
  const near = row(result, FLOOD_LABELS.nearby);
  if (near) {
    const nearNote = String(near.note || '');
    // A regulatory floodway within 500 ft carries the no-rise requirement,
    // so it belongs on the card, not only in the row note (B-S3-3).
    const floodway = /floodway/i.test(nearNote)
      ? ', a regulatory FLOODWAY'
      : '';
    parts.push(
      nearNote.includes(FLOOD_NOTES.nearInSfha)
        ? `100-year zone ${near.value}${floodway} within 500 ft`
        : /unknown|not determined/i.test(nearNote)
          ? `flood status for zone ${near.value} within 500 ft is unknown`
          : 'no 100-year zone within 500 ft',
    );
  }
  return parts.join('; ');
}

function readIncentives(result) {
  const parts = [
    ['Qualified Census Tract', 'QCT'],
    ['Opportunity Zone', 'Opportunity Zone'],
    ['Difficult Development Area', 'DDA'],
  ]
    .map(([prefix, short]) => {
      const item = row(result, (label) => label.startsWith(prefix));
      return item ? `${short}: ${item.value}` : null;
    })
    .filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

function readIncomeRenters(result) {
  const income = row(result, (label) =>
    label.startsWith('Median household income (tract'),
  );
  const renters = row(result, (label) =>
    label.startsWith('Renter-occupied share (tract'),
  );
  const parts = [];
  if (income && isNum(income.value))
    parts.push(`${money(income.value)} median household income`);
  if (renters && isNum(renters.value))
    parts.push(`${num(renters.value, 1)}% of households rent`);
  return parts.length ? `${parts.join(', ')} (site tract)` : null;
}

function readGrossRent(result) {
  const rent = row(result, (label) =>
    label.startsWith('Median gross rent (tract'),
  );
  if (!rent || !isNum(rent.value)) return null;
  // Beside the Zillow line this reads as an achievable rent, and it is not:
  // ACS gross rent carries the tenant-paid utilities too (B-S3-2). The
  // annual figure prefers the row's own explicit `annualPerUnit` field (per
  // DATA-11) over re-deriving from an already-rounded monthly value, which
  // compounds rounding error.
  const annual = rent.annualPerUnit ?? Math.round(rent.value * 12);
  return `${money(rent.value)}/mo, ${money(annual)} per unit per year (site tract, Census ACS; gross rent includes tenant-paid utilities; not an estimate of achievable subject rent)`;
}

function readZillow(result) {
  const change = row(result, ZORI_CHANGE_12M_LABEL);
  if (!change || !isNum(change.value)) return null;
  const index = row(result, (label) => label.startsWith('Zillow rent index'));
  const zip = /ZIP (\d{5})/.exec(index?.label || '')?.[1];
  return `${signed(change.value)}% over 12 months${zip ? ` (ZIP ${zip})` : ''}`;
}

function readPermits(result) {
  const trend = row(result, (label) => label.endsWith(' 5+ unit trend'));
  if (!trend) return null;
  const where = trend.label.slice(0, -' 5+ unit trend'.length);
  // The trend runs on annual files only. On one test property it called
  // supply "Falling" while 2026 year to date already beat all of 2025, so
  // the card has to carry the newest data on the same screen (B-S3-6).
  const ytd = row(
    result,
    (label) =>
      label.startsWith(where) &&
      / 5\+ unit permits, \d{4} through /.test(label),
  );
  const window = row(result, (label) => label === `${where} 5+ unit trend`);
  const ytdText = ytd
    ? `; ${/\d{4} through \w+/.exec(ytd.label)?.[0] ?? 'year to date'} ${ytd.value} (separate year to date)`
    : '';
  const latestAnnual = /and (\d{4})/.exec(String(window?.note || ''))?.[1];
  return `Annual${latestAnnual ? ` ${latestAnnual}` : ' files'}: ${trend.value} (${where})${ytdText}`;
}

function readJobs(result) {
  const jobs = row(result, `Jobs within ${DRIVE_TIME_MINUTES} min drive`);
  return jobs && isNum(jobs.value) ? `${num(jobs.value)} jobs` : null;
}

function readEnvironmental(result) {
  const within = (prefix) =>
    row(
      result,
      (label) => label.startsWith(prefix) && label.endsWith('within 1 mi'),
    );
  const brown = within('Brownfields');
  const tri = within('Toxic release');
  const superfund = within('Superfund');
  const parts = [];
  if (brown && isNum(brown.value))
    parts.push(plural(brown.value, 'brownfield', 'brownfields'));
  if (tri && isNum(tri.value))
    parts.push(plural(tri.value, 'toxic release (TRI) site', 'TRI sites'));
  if (superfund && isNum(superfund.value) && superfund.value > 0)
    parts.push(plural(superfund.value, 'Superfund site', 'Superfund sites'));
  return parts.length ? `${parts.join(', ')} within 1 mi` : null;
}

function readSchools(result) {
  const parts = [
    ['Nearest elementary', 'Elementary'],
    ['Nearest middle', 'Middle'],
    ['Nearest high', 'High'],
  ]
    .map(([label, short]) => {
      const item = row(result, label);
      return item ? `${short}: ${item.value}` : null;
    })
    .filter(Boolean);
  return parts.length ? parts.join('; ') : null;
}

/**
 * The glance lines in reading order. `section` is the section whose result
 * feeds the line and where its link scrolls.
 */
export const GLANCE_LINES = Object.freeze([
  { key: 'flood', label: 'Flood zone', section: 'hazards', read: readFlood },

  {
    key: 'crime',
    label: 'Reported crime coverage',
    section: 'neighborhood',
    read: (result) => {
      const count = result.values?.find((item) =>
        item.label.startsWith('Chicago incident records'),
      );
      if (count)
        return `${count.partial ? 'At least ' : ''}${Number(count.value).toLocaleString('en-US')} reports in the selected area and 90-day window. Not a crime rate or safety rating; see dates and coverage.`;
      const coverage = row(result, 'Crime coverage');
      return coverage
        ? `${coverage.value}. Do not infer low crime from missing coverage.`
        : null;
    },
  },
  {
    key: 'parcel',
    label: 'Parcel and zoning',
    section: 'neighborhood',
    read: (result) => {
      const parcel = row(result, 'Atlanta parcel ID'),
        // DATA-13: Atlanta's parcel layer emits its zoning field under its own
        // label (neighborhood.js), not the generic fallback label, so the
        // glance card must check both or it silently drops Atlanta zoning.
        zone =
          row(result, 'Parcel zoning field (verify)') ||
          row(result, 'Zoning (verify with city)');
      if (parcel)
        return `Atlanta parcel ${parcel.value}${zone ? `; zoning ${zone.value}` : ''}. Verify current boundaries and permitted use with the city.`;
      const coverage = row(result, 'Parcel coverage');
      return coverage
        ? `${coverage.value}. Check local assessor and planning records.`
        : null;
    },
  },
  {
    key: 'roads',
    label: 'Road context',
    section: 'neighborhood',
    read: (result) => {
      const roads = result.values?.find((item) =>
        item.label.startsWith('Mapped major road segments'),
      );
      if (roads)
        return `${roads.partial ? 'Capped sample: ' : ''}${roads.value} mapped segments in the selected area (maximum 3 mi). Legal access, curb cuts and traffic counts require diligence.`;
      const coverage = row(result, 'Road coverage');
      return coverage ? String(coverage.value) : null;
    },
  },

  {
    key: 'incentives',
    label: 'QCT, Opportunity Zone, DDA',
    section: 'incentives',
    read: readIncentives,
  },
  {
    key: 'income',
    label: 'Income and renters',
    section: 'demographics',
    read: readIncomeRenters,
  },
  {
    key: 'gross-rent',
    label: 'Median gross rent',
    section: 'demographics',
    read: readGrossRent,
  },
  {
    key: 'zillow',
    label: 'Zillow rent trend',
    section: 'rents',
    read: readZillow,
  },
  {
    key: 'permits',
    label: '5+ unit permits (county)',
    section: 'supply',
    read: readPermits,
  },
  {
    key: 'jobs',
    label: `Jobs within ${DRIVE_TIME_MINUTES}-minute drive`,
    section: 'jobs',
    read: readJobs,
  },
  {
    key: 'environmental',
    label: 'Environmental, 1 mi',
    section: 'hazards',
    read: readEnvironmental,
  },
  {
    key: 'schools',
    label: 'Nearest schools',
    section: 'schools',
    read: readSchools,
  },
]);

/**
 * Text that must never reach the card: a placeholder as the whole text or as
 * any comma, semicolon, colon or bracket separated piece of it ("QCT: N/A"),
 * or a template hole ("$NaN", "undefined jobs").
 */
export function isGlanceStandIn(text) {
  if (typeof text !== 'string' || isPlaceholderValue(text)) return true;
  if (/\b(?:undefined|null|NaN|Infinity)\b|\[object /.test(text)) return true;
  return text
    .split(/[,;:()]/)
    .map((piece) => piece.trim())
    .filter(Boolean)
    .some((piece) => isPlaceholderValue(piece));
}

function guard(line, text) {
  if (isGlanceStandIn(text)) {
    throw new TypeError(
      `Refusing to render placeholder in At a glance line "${line.key}"`,
    );
  }
  return text;
}

/** Honest words for a section that has not answered this line. */
function statusText(entry) {
  if (entry.status === SECTION_LOADING)
    return `Loading ${String(entry.label).toLowerCase()}`;
  const message = entry.result?.message?.trim();
  if (entry.status === SECTION_STATUS.READY) {
    return message || `Not reported in ${entry.label}`;
  }
  return message || `${entry.label}: no data at this site`;
}

// --- Summary tiles: the headline figures shown above the tabs, for every
// role tab, so the strongest evidence never hides behind a "no data" card.
// Tests: buildSummaryTiles.test in summary.test.mjs.

/** Tile status vocabulary the dossier body and the printed brief both use. */
export const TILE_STATUS = Object.freeze({
  OK: 'ok',
  PARTIAL: 'partial',
  NEEDS_KEY: 'needs-key',
  UNAVAILABLE: 'unavailable',
});

/** Text before the first ";" in a row note, which every section uses to lead with its vintage or window. */
function leadingNote(note) {
  const first = String(note ?? '')
    .split(';')[0]
    .trim();
  return first || '';
}

/** The parenthesised geography at the end of a scoped row label, e.g. "(tract 123)" -> "tract 123". */
function trailingGeography(label) {
  const match = /\(([^()]+)\)\s*$/.exec(String(label ?? ''));
  return match ? match[1] : '';
}

/** First real (non-placeholder) value row whose label matches `test`. */
function findRow(result, test) {
  return (
    (result?.values || []).find(
      (item) =>
        (typeof test === 'string' ? item.label === test : test(item.label)) &&
        !isPlaceholderValue(item.value),
    ) || null
  );
}

/**
 * A demographics row scoped either to the site tract or the 1 mi ring.
 * @param {object} result
 * @param {string} name - e.g. "Median gross rent".
 * @param {boolean} preferRing - true to try the 1 mi ring before the tract.
 */
function scopeRow(result, name, preferRing) {
  const tract = () =>
    findRow(result, (label) => label.startsWith(`${name} (tract`));
  const ring = () =>
    findRow(result, (label) => label.startsWith(`${name} (1 mi`));
  return preferRing ? ring() || tract() : tract() || ring();
}

function tileFromRow(row) {
  if (!row) return null;
  return {
    value: row.value,
    unit: row.unit || '',
    geography: trailingGeography(row.label),
    date: row.vintage || leadingNote(row.note),
    // Carried through so formatTileValue can recover a rent row's own
    // explicit annual-per-unit figure (format.js formatLabeledValue);
    // harmless for every other tile, which never reads it.
    annualPerUnit: row.annualPerUnit,
  };
}

/** The county's most recent annual 5+ unit permit row (county rows are pushed before place rows in the supply section). */
function permitsTile(result) {
  const re = /^(.+) 5\+ unit permits, (\d{4})$/;
  let countyName = null;
  let best = null;
  for (const item of result?.values || []) {
    if (isPlaceholderValue(item.value)) continue;
    const match = re.exec(item.label);
    if (!match) continue;
    if (countyName === null) countyName = match[1];
    if (match[1] !== countyName) continue;
    const year = Number(match[2]);
    if (!best || year > best.year) best = { year, item };
  }
  if (!best) return null;
  return {
    value: best.item.value,
    unit: '',
    geography: countyName,
    date: String(best.year),
  };
}

function zillowTile(result) {
  const index = findRow(result, (label) =>
    label.startsWith('Zillow rent index'),
  );
  if (!index) return null;
  const zip = /ZIP (\d{5})/.exec(index.label)?.[1] || '';
  const month = /,\s*([A-Za-z]{3}\s+\d{4})\s*$/.exec(index.label)?.[1] || '';
  const change = findRow(result, ZORI_CHANGE_12M_LABEL);
  const changeNum = isNum(change?.value) ? change.value : null;
  return {
    value: index.value,
    unit: index.unit || '',
    geography: zip ? `ZIP ${zip}` : '',
    date: month,
    annualPerUnit: index.annualPerUnit,
    changeLabel:
      changeNum === null
        ? ''
        : `${changeNum > 0 ? '+' : ''}${num(changeNum, 1)}% 12mo`,
  };
}

/** "Panel effective 2013-09-18" from the section's own evidence, never the checkedAt retrieval stamp; a data vintage a reader can act on, even when FEMA reports no panel date. */
function floodPanelDate(result) {
  const panelEffective = result?.evidence?.flood?.panelEffectiveDate;
  return panelEffective
    ? `Panel effective ${panelEffective}`
    : 'FEMA NFHL (no panel date reported)';
}

function floodZoneTile(result) {
  const zone = findRow(result, FLOOD_LABELS.zone);
  if (!zone) return null;
  const name = /^zone\b/i.test(String(zone.value))
    ? String(zone.value)
    : `Zone ${zone.value}`;
  return {
    value: name,
    unit: '',
    geography: 'Site',
    date: floodPanelDate(result),
  };
}

function jobsTile(result) {
  const row = findRow(result, (label) =>
    label.startsWith(`Jobs within ${DRIVE_TIME_MINUTES} min drive`),
  );
  if (!row) return null;
  return {
    value: row.value,
    unit: row.unit || '',
    geography: `${DRIVE_TIME_MINUTES} min drive`,
    // "LODES 2023" (or "LODES mixed vintages 2022, 2023") from the row's
    // own explicit `vintage` field, so the jobs tile and brief row are
    // never dateless.
    date: row.vintage || 'LODES (vintage not reported)',
  };
}

/**
 * The single named source for one tile's metric, e.g. "Zillow Observed Rent
 * Index (ZORI)" rather than the whole rents section's combined credit
 * string. Report brief rows read this instead of the section-wide credit so
 * page one never cites a provider that did not actually supply this figure.
 */
export const TILE_SOURCE = Object.freeze({
  'gross-rent': 'U.S. Census Bureau, American Community Survey (ACS)',
  'renter-share': 'U.S. Census Bureau, American Community Survey (ACS)',
  'median-income': 'U.S. Census Bureau, American Community Survey (ACS)',
  'rental-vacancy': 'U.S. Census Bureau, American Community Survey (ACS)',
  jobs: 'U.S. Census Bureau LEHD LODES8 workplace jobs',
  'flood-zone': 'FEMA National Flood Hazard Layer',
  permits: 'U.S. Census Bureau Building Permits Survey',
  'zillow-rent': 'Zillow Observed Rent Index (ZORI)',
});

/**
 * The 8 headline tiles, in display order. Each `read` takes a section result
 * and returns `{value, unit, geography, date}` (plus `changeLabel` for
 * zillow), or null when this snapshot has no matching row.
 */
export const TILE_SPECS = Object.freeze([
  {
    key: 'gross-rent',
    label: 'Median gross rent',
    section: 'demographics',
    read: (result) => tileFromRow(scopeRow(result, 'Median gross rent', false)),
  },
  {
    key: 'renter-share',
    label: 'Renter share',
    section: 'demographics',
    read: (result) =>
      tileFromRow(scopeRow(result, 'Renter-occupied share', false)),
  },
  {
    key: 'median-income',
    label: 'Median household income',
    section: 'demographics',
    read: (result) =>
      tileFromRow(scopeRow(result, 'Median household income', true)),
  },
  {
    key: 'rental-vacancy',
    label: 'Rental vacancy',
    section: 'demographics',
    read: (result) =>
      tileFromRow(scopeRow(result, 'Rental vacancy rate', false)),
  },
  {
    key: 'jobs',
    label: `Jobs within ${DRIVE_TIME_MINUTES} min drive`,
    section: 'jobs',
    read: jobsTile,
  },
  {
    key: 'flood-zone',
    label: 'FEMA flood zone',
    section: 'hazards',
    read: floodZoneTile,
  },
  {
    key: 'permits',
    label: '5+ unit permits',
    section: 'supply',
    read: permitsTile,
  },
  {
    key: 'zillow-rent',
    label: 'Zillow rent',
    section: 'rents',
    read: zillowTile,
  },
]);

/**
 * Build the headline summary tiles from a controller snapshot. A tile whose
 * section is not registered in this snapshot is left out entirely; a tile
 * whose section IS registered but has not answered carries an honest status
 * ('needs-key' or 'unavailable') instead of a value.
 * @param {{sections: Array<{id:string, label:string, status:string, result:object|null}>}} snapshot
 * @param {ReadonlyArray<typeof TILE_SPECS[number]>} [specs]
 */
export function buildSummaryTiles(snapshot, specs = TILE_SPECS) {
  const byId = new Map(
    (snapshot?.sections || []).map((entry) => [entry.id, entry]),
  );
  const tiles = [];
  for (const spec of specs) {
    const entry = byId.get(spec.section);
    if (!entry) continue;
    let status = TILE_STATUS.UNAVAILABLE;
    let content = null;
    if (entry.status === SECTION_STATUS.NEEDS_KEY) {
      status = TILE_STATUS.NEEDS_KEY;
    } else if (
      [SECTION_STATUS.READY, SECTION_STATUS.PARTIAL].includes(entry.status) &&
      entry.result
    ) {
      content = spec.read(entry.result);
      if (content)
        status =
          entry.status === SECTION_STATUS.PARTIAL
            ? TILE_STATUS.PARTIAL
            : TILE_STATUS.OK;
    }
    tiles.push({
      key: spec.key,
      label: spec.label,
      section: spec.section,
      status,
      value: content?.value ?? null,
      unit: content?.unit ?? '',
      geography: content?.geography ?? '',
      date: content?.date ?? '',
      changeLabel: content?.changeLabel ?? '',
      annualPerUnit: content?.annualPerUnit,
      source: TILE_SOURCE[spec.key] || '',
      retrievedAt: entry.result?.retrievedAt ?? '',
      needsKeyMessage:
        status === TILE_STATUS.NEEDS_KEY
          ? entry.result?.message ||
            `${entry.label || spec.section} needs a free key.`
          : '',
    });
  }
  return tiles;
}

/** "$812/mo ($9,744/yr per unit)" or "71.4%" — the same rendering rule the dossier and the printed brief share. */
export function formatTileValue(tile) {
  if (
    tile.value === null ||
    tile.value === undefined ||
    tile.status === TILE_STATUS.NEEDS_KEY ||
    tile.status === TILE_STATUS.UNAVAILABLE
  )
    return '';
  return formatLabeledValue({
    label: tile.label,
    value: tile.value,
    unit: tile.unit,
    annualPerUnit: tile.annualPerUnit,
  });
}

/**
 * @typedef {object} GlanceLine
 * @property {string} key
 * @property {string} label
 * @property {string} section Section id the line links to.
 * @property {'value'|'status'} kind value = read from data; status = the section's own status.
 * @property {string} sectionStatus
 * @property {string} text
 */

/**
 * Build the glance lines from a controller snapshot. A line whose section is
 * not registered is left out. Throws when any line would show a stand-in.
 * @param {{sections: Array<{id:string, label:string, status:string, result:object|null}>}} snapshot
 * @param {ReadonlyArray<typeof GLANCE_LINES[number]>} [lines]
 * @returns {GlanceLine[]}
 */
export function buildGlance(snapshot, lines = GLANCE_LINES) {
  const byId = new Map(
    (snapshot?.sections || []).map((entry) => [entry.id, entry]),
  );
  const out = [];
  for (const line of lines) {
    const entry = byId.get(line.section);
    if (!entry) continue;
    const value =
      [SECTION_STATUS.READY, SECTION_STATUS.PARTIAL].includes(entry.status) &&
      entry.result
        ? line.read(entry.result)
        : null;
    out.push({
      key: line.key,
      label: line.label,
      section: line.section,
      kind: value ? 'value' : 'status',
      sectionStatus: entry.status,
      text: guard(line, value || statusText(entry)),
    });
  }
  return out;
}
