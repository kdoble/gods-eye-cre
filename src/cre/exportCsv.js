// Excel-ready CSV export: one row per metric across every dossier section,
// laid out for underwriting (RFC 4180, UTF-8 BOM so Excel opens it cleanly,
// numeric cells stay numbers, formula-injection guarded). Built from the same
// export document `buildDossierExport` produces, so JSON and CSV always
// describe the same snapshot.
import { EXPORT_SCHEMA } from './export.js';

export const CSV_SCHEMA = `${EXPORT_SCHEMA}/csv-table@1`;

const COLUMNS = Object.freeze([
  'Section',
  'Metric',
  'Value',
  'Unit',
  'Geography',
  'Vintage or observation date',
  'Source',
  'Source URL',
  'Retrieved at',
  'Status',
  'Note',
]);

/** Formula-injection characters CSV_FORMULA_GUARD defuses (Excel/Sheets convention). */
const FORMULA_LEAD = /^[\s]*[=+\-@]/;

/**
 * A single CSV cell: RFC 4180 quoting, and a formula-injection guard that
 * prefixes a leading = + - @ with a single quote. A true numeric value is
 * never quoted and never guarded, so it opens in Excel as a number, not text.
 * @param {unknown} value
 */
export function csvCell(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : '';
  }
  const text = String(value ?? '');
  const safe = FORMULA_LEAD.test(text) ? `'${text}` : text;
  if (/[",\r\n]/.test(safe) || safe !== text) {
    return `"${safe.replaceAll('"', '""')}"`;
  }
  return safe;
}

/** Join cells into one RFC 4180 row. */
export function csvRow(cells) {
  return cells.map(csvCell).join(',');
}

const GEOGRAPHY_PATTERNS = Object.freeze([
  [/\btract\b/i, 'tract'],
  [/\b1\s*mi\b/i, '1 mi'],
  [/\b3\s*mi\b/i, '3 mi'],
  [/\b5\s*mi\b/i, '5 mi'],
  [/\bzip\b/i, 'ZIP'],
  [/\bcounty\b/i, 'county'],
]);

/**
 * Best-effort geography for a value row that does not already carry its own
 * `geography` field (market.js sets one directly; most sections do not). A
 * ring or ZIP mentioned in the label wins; anything else, including a
 * drive-time area (not one of the fixed ring sizes), falls back to `point`,
 * the site-level default, so every row still names a geography rather than
 * leaving the cell blank.
 * @param {{label?:string, geography?:string}} item
 */
export function inferGeography(item) {
  if (typeof item?.geography === 'string' && item.geography.trim()) {
    return item.geography;
  }
  const label = String(item?.label ?? '');
  for (const [pattern, name] of GEOGRAPHY_PATTERNS) {
    if (pattern.test(label)) return name;
  }
  return 'point';
}

const YEAR_QUARTER = /\b(19|20)\d{2}\s*Q[1-4]\b/i;
const FY_YEAR = /\bFY\s?((?:19|20)\d{2})\b/i;
const MONTH_YEAR =
  /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+((?:19|20)\d{2})\b/i;
const ISO_DATE = /\b((?:19|20)\d{2}-\d{2}-\d{2})\b/;
// S5: a bare 4-digit-year scan was removed. It invented vintages from
// unrelated text -- "2010" out of the note "OZ designations use 2010 census
// tracts" (the real vintage is 2018), "1999" out of a facility named "1999
// Motors LLC", or a year embedded in "Census Tract 2010.02" -- for every
// row that carries no structured date at all (incentives, hazards, EPA,
// demand drivers, utilities).

/** The exact text an exported row's Note gets when no structured vintage exists. */
export const VINTAGE_NOT_PROVIDED_NOTE = 'vintage not provided by source';

/**
 * Best-effort vintage for a row, checked from most to least specific:
 * structured `observationDate`/`vintage` fields (market.js sets
 * `observationDate`; rents, demographics, jobs/LODES and the FEMA panel row
 * set `vintage`), then a small set of unambiguous DATE-SHAPED patterns over
 * the label/note ("2025 Q4", "FY2025", "Aug 2026", an ISO date) that a
 * section author wrote as the actual period, not incidental prose. There is
 * deliberately no bare-year fallback (see S5 above) and no silent fallback
 * to the section's retrievedAt date, which is a fetch timestamp, not a
 * vintage -- a row with none of the above returns '' and the caller notes
 * `VINTAGE_NOT_PROVIDED_NOTE` instead of guessing.
 * @param {{label?:string, note?:string, observationDate?:string, vintage?:string}} item
 */
export function inferVintage(item) {
  if (
    typeof item?.observationDate === 'string' &&
    item.observationDate.trim()
  ) {
    return item.observationDate;
  }
  if (typeof item?.vintage === 'string' && item.vintage.trim()) {
    return item.vintage;
  }
  const text = `${item?.label ?? ''} ${item?.note ?? ''}`;
  for (const pattern of [YEAR_QUARTER, FY_YEAR, MONTH_YEAR, ISO_DATE]) {
    const match = pattern.exec(text);
    if (match) return match[0];
  }
  return '';
}

/** Note cell text: the row's own note, plus the not-provided flag when there is no vintage. */
function noteWithVintageFlag(note, vintage) {
  const base = note || '';
  if (vintage) return base;
  return base
    ? `${base}; ${VINTAGE_NOT_PROVIDED_NOTE}`
    : VINTAGE_NOT_PROVIDED_NOTE;
}

/**
 * Flatten one export document (from `buildDossierExport`) into row arrays:
 * a header block (address, lat/lon, tract, generated timestamp, app
 * version), the column header, then one summary row per section (so a
 * needs-key or unavailable section with zero values still appears) plus one
 * row per metric.
 * @param {ReturnType<import('./export.js').buildDossierExport>} exportDoc
 * @param {{appVersion?:string}} [options]
 */
export function buildExportRows(exportDoc, { appVersion = '' } = {}) {
  const site = exportDoc?.site ?? {};
  const rows = [
    ['Gods Eye CRE dossier export'],
    ['Address', site.address ?? ''],
    ['Latitude', site.lat ?? '', 'Longitude', site.lon ?? ''],
    ['Census tract', site.tractGeoid ?? ''],
    ['Generated', exportDoc?.generatedAt ?? ''],
    ['App version', appVersion],
    [],
    [...COLUMNS],
  ];
  for (const section of exportDoc?.sections ?? []) {
    const sourceUrl = section.sourceUrls?.[0] || section.credit?.url || '';
    rows.push([
      section.label,
      'Section status',
      '',
      '',
      '',
      '',
      section.credit?.text || '',
      sourceUrl,
      section.retrievedAt || '',
      section.status,
      section.message || '',
    ]);
    for (const item of section.values || []) {
      const vintage = inferVintage(item);
      rows.push([
        section.label,
        item.label,
        typeof item.value === 'number' ? item.value : String(item.value ?? ''),
        item.unit || '',
        inferGeography(item),
        vintage,
        // A row can name its own single source (item.source) when one section
        // combines several providers; most rows still fall back to the
        // section's combined credit.
        item.source || section.credit?.text || '',
        (item.sourceUrls && item.sourceUrls[0]) || sourceUrl,
        section.retrievedAt || '',
        section.status,
        noteWithVintageFlag(item.note, vintage),
      ]);
    }
  }
  return rows;
}

/** Rows (from `buildExportRows`) to RFC 4180 text with a leading UTF-8 BOM. */
export function toCsvText(rows) {
  return '﻿' + rows.map(csvRow).join('\r\n') + '\r\n';
}

/**
 * The full CSV text for one export document.
 * @param {ReturnType<import('./export.js').buildDossierExport>} exportDoc
 * @param {{appVersion?:string}} [options]
 */
export function buildDossierCsv(exportDoc, options = {}) {
  return toCsvText(buildExportRows(exportDoc, options));
}
