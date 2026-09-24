// Builds the dossier JSON export (address, coordinates, every settled section with status, values, sources, retrieved-at) and downloads it as dossier-<slug>-<date>.json.
import { safeSourceUrl } from './workspace.js';
import { validateSectionResult } from './contract.js';

export const EXPORT_SCHEMA = 'gods-eye-cre/dossier@1';

const bounded = (value, limit = 300) =>
  typeof value === 'string' ? value.slice(0, limit) : null;

/** Retain reviewed jurisdiction fields without copying arbitrary provider data. */
export function exportJurisdiction(value) {
  if (!value || typeof value !== 'object') return null;
  const data = {};
  for (const key of [
    'status',
    'id',
    'name',
    'planningAgency',
    'policeAgency',
    'policeAgencyStatus',
    'county',
    'countyStatus',
    'boundaryCheckedAt',
    'source',
    'packageVersion',
    'staleAt',
  ])
    data[key] =
      key === 'source' ? safeSourceUrl(value[key]) : bounded(value[key]);
  data.crossesBoundary =
    typeof value.crossesBoundary === 'boolean' ? value.crossesBoundary : null;
  data.stale = value.stale === true;
  data.sourceUrls = Array.isArray(value.sourceUrls)
    ? value.sourceUrls.slice(0, 8).map(safeSourceUrl).filter(Boolean)
    : [];
  return data;
}

export function exportEvidence(value) {
  if (!value || typeof value !== 'object') return null;
  const data = {
    packageVersion: bounded(value.packageVersion),
    boundarySource: safeSourceUrl(value.boundarySource),
    boundaryCheckedAt: bounded(value.boundaryCheckedAt),
    boundaryStale: value.boundaryStale === true,
    boundaryStaleAt: bounded(value.boundaryStaleAt),
    crossesBoundary:
      typeof value.crossesBoundary === 'boolean' ? value.crossesBoundary : null,
    floodMapStatus: bounded(value.floodMapStatus),
    floodMapRadiusM: Number.isFinite(value.floodMapRadiusM)
      ? value.floodMapRadiusM
      : null,
    floodMapFeatureCount: Number.isFinite(value.floodMapFeatureCount)
      ? value.floodMapFeatureCount
      : null,
    floodPanelCount: Number.isFinite(value.floodPanelCount)
      ? value.floodPanelCount
      : null,
  };
  for (const topic of ['crime', 'zoning', 'flood']) {
    const original = value[topic];
    if (!original || typeof original !== 'object') continue;
    data[topic] = {};
    for (const key of [
      'publisher',
      'coverage',
      'recordDate',
      'recordDateStatus',
      'checkedAt',
      'packageVersion',
      'periodStart',
      'periodEnd',
      'rightsStatus',
      'siteDeterminationMethod',
      'panelEffectiveDate',
      'floodMapRecordDate',
    ])
      data[topic][key] = bounded(original[key]);
    if (topic === 'crime')
      data[topic].parentDataset = safeSourceUrl(original.parentDataset);
    if (topic === 'flood') data[topic].source = safeSourceUrl(original.source);
  }
  return data;
}

/** Lowercase dash slug of an address, at most 60 characters. */
export function slugify(text) {
  const slug = String(text || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return slug || 'site';
}

/** Local calendar date as YYYY-MM-DD. */
export function isoDate(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** dossier-<slug>-<date>.json */
export function exportFileName(address, date = new Date()) {
  return `dossier-${slugify(address)}-${isoDate(date)}.json`;
}

/**
 * Serializable dossier document from a controller snapshot. Sections still
 * loading are listed under `pending`, never given a made-up status.
 * Throws when a settled section breaks the contract (for example, no
 * retrievedAt), so a broken export can never be written.
 * @param {import('./dossierController.js').DossierSnapshot} snapshot
 * @param {{now?: Date}} [options]
 */
export function buildDossierExport(snapshot, { now = new Date() } = {}) {
  const ctx = snapshot?.ctx;
  if (!ctx) throw new TypeError('No dossier to export');
  const sections = [];
  const pending = [];
  for (const entry of snapshot.sections) {
    if (entry.status === 'loading') pending.push(entry.id);
    if (!entry.result) {
      continue;
    }
    const result = validateSectionResult(entry.result);
    const section = {
      id: result.id,
      label: result.label,
      status: result.status,
      values: result.values.map((item) => ({ ...item })),
      credit: { ...result.credit, url: safeSourceUrl(result.credit.url) },
      sourceUrls: result.sourceUrls.map(safeSourceUrl).filter(Boolean),
      retrievedAt: result.retrievedAt,
    };
    if (result.message) section.message = result.message;
    if (result.jurisdiction)
      section.jurisdiction = exportJurisdiction(result.jurisdiction);
    if (result.evidence) section.evidence = exportEvidence(result.evidence);
    if (entry.refresh)
      section.refresh = {
        status: bounded(entry.refresh.status, 40),
        attemptedAt: bounded(entry.refresh.attemptedAt, 40),
        dataRetrievedAt: bounded(entry.refresh.dataRetrievedAt, 40),
      };
    if (result.overlays) {
      section.overlays = result.overlays.map((overlay) => ({
        id: overlay.id,
        geojson: overlay.geojson,
        style: { ...overlay.style },
      }));
    }
    // The rents section's ZORI sparkline data (36 months of history plus
    // the latest level and 12/36-month changes), so the printed report can
    // draw the same rent trend chart the dossier panel shows.
    if (result.rentsChart) section.rentsChart = result.rentsChart;
    sections.push(section);
  }
  const site = {
    address: ctx.address,
    lat: ctx.lat,
    lon: ctx.lon,
  };
  for (const key of [
    'jurisdiction',
    'county',
    'state',
    'zip',
    'tractGeoid',
    'approximate',
    'pointOrigin',
  ]) {
    if (ctx[key]) site[key] = ctx[key];
  }
  return {
    schema: EXPORT_SCHEMA,
    radiusMiles: ctx.radiusMiles || 1,
    generatedAt: now.toISOString(),
    state: snapshot.state,
    site: { ...site, locationConfirmed: ctx.locationConfirmed === true },
    rings: { ...ctx.rings },
    sections,
    pending,
    refreshing: snapshot.refreshing === true,
  };
}

/**
 * Trigger a browser download of the export document.
 * @param {object} exportDoc From buildDossierExport.
 * @param {{documentRef?: Document, URLRef?: typeof URL, BlobRef?: typeof Blob}} [deps]
 * @returns {string} The file name used.
 */
export function downloadDossierJson(
  exportDoc,
  {
    documentRef = globalThis.document,
    URLRef = globalThis.URL,
    BlobRef = globalThis.Blob,
  } = {},
) {
  const name = exportFileName(
    exportDoc.site.address,
    new Date(exportDoc.generatedAt),
  );
  const blob = new BlobRef([JSON.stringify(exportDoc, null, 2)], {
    type: 'application/json',
  });
  const url = URLRef.createObjectURL(blob);
  const link = documentRef.createElement('a');
  link.href = url;
  link.download = name;
  link.style.display = 'none';
  documentRef.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URLRef.revokeObjectURL(url), 1000);
  return name;
}
