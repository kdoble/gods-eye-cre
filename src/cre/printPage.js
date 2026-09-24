// Builds the standalone, asset-free print page for a dossier export (letter portrait, attribution block last) and opens it in a new tab to print.
import { validResearchSnapshot } from './reportEvidence.js';
import { buildRoleInsights } from './roleInsights.js';
import { buildReportContext } from './reportContext.js';
import { mapLinks, safeSourceUrl } from './workspace.js';
import { buildSummaryTiles, formatTileValue } from './summary.js';
import { FLOOD_LABELS } from './sections/hazards.js';
import { isPlaceholderValue } from './contract.js';
import { formatLabeledValue, formatMoney } from './format.js';
import {
  scaleZoriHistory,
  zoriTrendSummary,
  monthLabel,
} from './sections/rentsChart.js';

const STATUS_WORDS = Object.freeze({
  ready: 'Ready',
  partial: 'Partial coverage',
  empty: 'None found',
  unavailable: 'Unavailable',
  'needs-key': 'Needs key',
});

/** Escape text for HTML element and attribute contexts. */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const displayValue = (item) => formatLabeledValue(item);

const safeUrl = safeSourceUrl;
const sourceLabel = (url) => {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname}`.slice(0, 130);
  } catch {
    return 'Source reference';
  }
};

// SEC-06: this page is opened from a same-origin blob: URL with no server to
// send response headers, so the CSP has to travel as a <meta> tag instead.
// `script-src 'unsafe-inline'` used to allow ANY inline script to run,
// including one smuggled in through an injected attribute (e.g. an
// `<img onerror=...>` in printed content) — that is not "capping" an
// injection to this page's own scripts, it is not restricting scripts at
// all. Every <script> this page ships now carries a random per-render
// nonce, script-src allows only that nonce, and no code runs from an
// element attribute (onclick etc.) since those are never nonce-checked.
// style-src stays 'unsafe-inline': only inline <style>/style= is at risk
// there, which cannot execute script or navigate the page.
function makeNonce() {
  const bytes = new Uint8Array(18);
  globalThis.crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function printPageCsp(nonce) {
  return `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src 'self' data: blob:; base-uri 'none'; form-action 'none'">`;
}

const PRINT_CSS = `
@page { size: letter portrait; margin: 0.6in; }
* { box-sizing: border-box; }
body { margin: 0; color: #111827; background: #fff; font: 10.5pt/1.4 -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; }
header { border-bottom: 2px solid #0f2a4a; padding-bottom: 10px; margin-bottom: 14px; }
.kicker { color: #8a6d1d; font-size: 8.5pt; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
h1 { margin: 2px 0 6px; font: 600 17pt/1.2 Georgia, "Times New Roman", serif; color: #0f2a4a; }
.meta { display: flex; flex-wrap: wrap; gap: 4px 18px; font-size: 9pt; color: #374151; }
.meta b { color: #111827; font-weight: 600; }
section { margin: 0 0 12px; border: 1px solid #d1d5db; border-radius: 4px; }
tr, h2, h3 { break-inside: avoid; } thead { display: table-header-group; } h2, h3 { break-after: avoid; } a { overflow-wrap: anywhere; } .screening { padding: 14px; margin-bottom: 22px; } .screening h2 { background: none; padding: 0 0 12px; font-size: 14pt; } .screening p { margin: 8px 0; } .screening ul { padding-left: 20px; } .brief-map { float: right; margin: 0 0 12px 18px; } .appendix-title { break-before: page; } .compare { table-layout: fixed; } .compare th { text-align:left; padding:8px; background:#edf3f7; overflow-wrap:anywhere; } .compare td { overflow-wrap:anywhere; } .print-controls { padding:12px; background:#edf3f7; } @media print { .print-controls {display:none} }
section h2 { margin: 0; padding: 6px 10px; background: #f3f4f6; font-size: 10.5pt; display: flex; justify-content: space-between; }
.status { font-size: 8.5pt; font-weight: 600; color: #374151; }
.status.ready { color: #166534; } .status.unavailable { color: #92400e; } .status.needs-key { color: #1e40af; }
table { width: 100%; border-collapse: collapse; }
td { padding: 4px 10px; border-top: 1px solid #eef0f3; vertical-align: top; }
td.k { width: 46%; color: #4b5563; }
td.v { font-weight: 600; font-variant-numeric: tabular-nums; }
.note { color: #6b7280; font-weight: 400; margin-left: 6px; }
.msg, .src { margin: 0; padding: 4px 10px 6px; font-size: 8.5pt; color: #4b5563; }
.src a { color: #1e40af; }
.attrib { break-inside: avoid; margin-top: 18px; border-top: 1px solid #9ca3af; padding-top: 8px; font-size: 8.5pt; color: #374151; }
.attrib li { margin: 2px 0; }
.context-map { margin:16px 0; break-inside:avoid; } .context-map svg { display:block; width:100%; max-height:470px; } figcaption { font-size:8pt; color:#374151; } .decision-group { margin:16px 0; } .decision-group h3 { margin:0 0 5px; } .decision-group p { font-size:9pt; color:#374151; } .research-report { padding:12px; } .research-report li { margin:6px 0; } .screening table { table-layout:fixed; } .screening td { overflow-wrap:anywhere; } .print-controls button { padding:9px 15px; font:inherit; cursor:pointer; } @media screen { body { max-width:980px; margin:24px auto; padding:0 24px; } } @media print { .compare-wrap { overflow:visible !important; } .compare { min-width:0 !important; } .comparison-block + .comparison-block { break-before:page; } }
.foot { margin-top: 10px; font-size: 8pt; color: #6b7280; }
.brief-page1 { border: none; padding: 0; margin: 0 0 14px; }
.brief-page1 h2 { margin: 0 0 8px; padding: 0; background: none; font: 600 13pt/1.2 Georgia, "Times New Roman", serif; color: #0f2a4a; }
.brief-table { margin-bottom: 10px; }
.brief-table th { text-align: left; padding: 4px 8px; background: #edf3f7; font-size: 8.5pt; color: #0f2a4a; }
.brief-table td { padding: 4px 8px; border-top: 1px solid #eef0f3; font-size: 9pt; vertical-align: top; }
.brief-hazards { font-size: 9pt; margin: 8px 0; }
.brief-confirm { font-size: 9pt; margin: 8px 0; padding: 8px 10px; background: #fff7e6; border: 1px solid #e9d8a6; border-radius: 4px; }
.brief-confirm ul { margin: 4px 0 0; padding-left: 18px; }
.rent-trend { margin: 16px 0; break-inside: avoid; } .rent-trend h3 { margin: 0 0 4px; } .rent-trend svg { display: block; width: 280px; max-width: 100%; height: 72px; } .rent-trend-caption { margin: 4px 0 0; font-size: 8.5pt; color: #4b5563; }
.page2 { break-before: page; }
@media print { .brief-page1 { break-after: page; } }
`;

/**
 * Standalone HTML for a dossier export. Every value is escaped; there are no
 * external assets (no fonts, images, or scripts from another origin).
 * @param {object} exportDoc From buildDossierExport.
 * @param {{autoPrint?: boolean}} [options]
 */
export function buildPrintHtml(exportDoc, { autoPrint = true } = {}) {
  const site = exportDoc.site;
  const meta = [
    site.county && ['County', site.county],
    site.tractGeoid && ['Tract', site.tractGeoid],
    ['Lat, lon', `${site.lat.toFixed(5)}, ${site.lon.toFixed(5)}`],
    ['Generated', new Date(exportDoc.generatedAt).toLocaleString('en-US')],
  ]
    .filter(Boolean)
    .map(([k, v]) => `<span>${escapeHtml(k)}: <b>${escapeHtml(v)}</b></span>`)
    .join('');

  const sections = exportDoc.sections
    .map((section) => {
      const rows = section.values
        .map(
          (item) =>
            `<tr><td class="k">${escapeHtml(item.label)}</td><td class="v">${escapeHtml(displayValue(item))}${item.note ? `<span class="note">${escapeHtml(item.note)}</span>` : ''}</td></tr>`,
        )
        .join('');
      const url = safeUrl(section.credit?.url);
      const credit = url
        ? `<a href="${escapeHtml(url)}">${escapeHtml(section.credit.text)}</a>`
        : escapeHtml(section.credit?.text);
      const refs = (section.sourceUrls || [])
        .map(safeUrl)
        .filter(Boolean)
        .map(
          (u) =>
            `<li><a href="${escapeHtml(u)}">${escapeHtml(sourceLabel(u))}</a></li>`,
        )
        .join('');
      return `<section data-dossier-section="${escapeHtml(section.id)}"><h2><span>${escapeHtml(section.label)}</span><span class="status ${escapeHtml(section.status)}">${escapeHtml(STATUS_WORDS[section.status] || section.status)}</span></h2>${rows ? `<table>${rows}</table>` : ''}${section.message ? `<p class="msg">${escapeHtml(section.message)}</p>` : ''}<p class="src">Source: ${credit}, retrieved ${escapeHtml(new Date(section.retrievedAt).toLocaleString('en-US'))}</p>${refs ? `<div class="src"><strong>Source query references</strong><ul>${refs}</ul></div>` : ''}</section>`;
    })
    .join('');

  const seen = new Set();
  const attributions = exportDoc.sections
    .filter((section) => {
      const key = `${section.credit?.text}|${section.credit?.url}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((section) => {
      const url = safeUrl(section.credit?.url);
      const license = section.credit?.license
        ? ` (${escapeHtml(section.credit.license)})`
        : '';
      return `<li>${escapeHtml(section.credit?.text)}${license}${url ? `, ${escapeHtml(url)}` : ''}</li>`;
    })
    .join('');

  const approximate = site.approximate
    ? `<p class="msg">${escapeHtml(site.approximate)}.</p>`
    : '';
  const pending = exportDoc.pending?.length
    ? `<p class="msg">Still loading when printed: ${escapeHtml(exportDoc.pending.join(', '))}</p>`
    : '';

  const nonce = makeNonce();
  const printBinding =
    '<script nonce="' +
    nonce +
    '">document.querySelectorAll("[data-cre-print]").forEach(function(b){b.addEventListener("click",function(){window.print()})})' +
    (autoPrint
      ? ';addEventListener("load",function(){setTimeout(function(){print()},150)})'
      : '') +
    '</script>';

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${printPageCsp(nonce)}<title>Site dossier: ${escapeHtml(site.address)}</title><style>${PRINT_CSS}</style></head><body><div class="print-controls"><button type="button" data-cre-print>Print / Save PDF</button> Full dossier and dated source appendix included.</div><header><div class="kicker">Gods Eye CRE · Site screening</div><h1>${escapeHtml(site.address || `${site.lat}, ${site.lon}`)}</h1><div class="meta">${meta}</div></header>${buildScreeningBrief(exportDoc)}${approximate}${pending}<h2 class="appendix-title">Full dossier and source appendix</h2>${sections}<div class="attrib" id="attribution"><strong>Data sources and attribution</strong><ul>${attributions}</ul><div class="foot">Public data as retrieved on the dates shown. Verify before relying on any figure. Built with God's Eye View (MIT) by Bilawal Sidhu and Sameh Khamis.</div></div>${printBinding}</body></html>`;
}

function mapPngScript(nonce) {
  return String.raw`<script nonce="${nonce}">
document.querySelectorAll('[data-cre-print]').forEach(function (b) { b.addEventListener('click', function () { print(); }); });
document.querySelector('[data-cre-map-png]').addEventListener('click', async function () {
  const button = this;
  const svg = document.querySelector('.context-map svg');
  const caption = document.querySelector('.context-map figcaption');
  if (!svg) return;
  const svgUrl = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml' }));
  try {
    const image = new Image();
    image.src = svgUrl;
    await image.decode();
    const legendNodes = [...(caption?.querySelectorAll('span') || [])];
    const legendItems = legendNodes.map((node) => ({
      label: node.textContent.replace('■', '').trim(),
      color: node.querySelector('b')?.style.color || '#374151',
    })).filter((item) => item.label);
    const sourceText = (legendNodes.length
      ? legendNodes.at(-1).nextSibling?.textContent || ''
      : caption?.textContent || 'No source caption provided.').replace(/^\.\s*/, '');
    const title = document.querySelector('h1')?.textContent || 'Selected site';
    const scope = document.querySelector('header .meta')?.textContent || '';
    const measure = document.createElement('canvas').getContext('2d');
    measure.font = '20px Arial, sans-serif';
    const legendRows = [];
    let legendRow = [], legendWidth = 0;
    for (const item of legendItems) {
      const width = measure.measureText(item.label).width + 48;
      if (legendRow.length && legendWidth + width > 1120) {
        legendRows.push(legendRow);
        legendRow = []; legendWidth = 0;
      }
      legendRow.push({ ...item, width });
      legendWidth += width;
    }
    if (legendRow.length) legendRows.push(legendRow);
    measure.font = '22px Arial, sans-serif';
    const words = sourceText.split(/\s+/);
    const lines = [];
    let line = '';
    for (const word of words) {
      const next = line ? line + ' ' + word : word;
      if (line && measure.measureText(next).width > 1120) {
        lines.push(line);
        line = word;
      } else line = next;
    }
    if (line) lines.push(line);
    const maximumLines = 230;
    if (lines.length > maximumLines) {
      lines.length = maximumLines;
      lines.push('Source detail truncated in PNG. Use Print / Save PDF for the full caption.');
    }
    const canvas = document.createElement('canvas');
    canvas.width = 1200;
    const footerStart = 1090 + legendRows.length * 38;
    canvas.height = footerStart + lines.length * 31 + 28;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#0f2a4a';
    ctx.font = 'bold 30px Arial, sans-serif';
    let shortTitle = title;
    while (ctx.measureText(shortTitle).width > 1140 && shortTitle.length > 4)
      shortTitle = shortTitle.slice(0, -2);
    if (shortTitle !== title) shortTitle = shortTitle.slice(0, -1) + '…';
    ctx.fillText(shortTitle, 24, 46);
    ctx.font = '20px Arial, sans-serif';
    ctx.fillText(scope.slice(0, 120), 24, 81);
    ctx.drawImage(image, 0, 115, 1200, 940);
    ctx.font = '20px Arial, sans-serif';
    legendRows.forEach((row, index) => {
      let x = 28;
      for (const item of row) {
        ctx.fillStyle = item.color;
        ctx.fillRect(x, 1070 + index * 38, 17, 17);
        ctx.fillStyle = '#172b38';
        ctx.fillText(item.label, x + 25, 1086 + index * 38);
        x += item.width;
      }
    });
    ctx.fillStyle = '#172b38';
    ctx.font = '22px Arial, sans-serif';
    lines.forEach((item, index) => ctx.fillText(item, 28, footerStart + index * 31));
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('PNG encoding failed');
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'selected-site-map.png';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch {
    button.insertAdjacentText('afterend', ' PNG could not be created. Print / Save PDF remains available.');
  } finally { URL.revokeObjectURL(svgUrl); }
});
</script>`;
}

/** A separate, geometry-only map preview with the same selected layers as the globe. */
export function buildMapPreviewHtml(exportDoc) {
  const map = buildReportContext(exportDoc);
  const title = escapeHtml(exportDoc.site?.address || 'Selected site');
  const nonce = makeNonce();
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${printPageCsp(nonce)}<title>Map preview: ${title}</title><style>${PRINT_CSS}body{max-width:900px;margin:24px auto;padding:0 18px}.context-map svg{max-height:none}.context-map figcaption{font-size:10pt;line-height:1.4}.print-controls{display:flex;gap:10px;align-items:center;flex-wrap:wrap}@media print{body{margin:0;padding:0}.print-controls{display:none}}</style></head><body><div class="print-controls"><button type="button" data-cre-map-png>Download labeled PNG</button><button type="button" data-cre-print>Print / Save PDF</button></div><header><div class="kicker">Gods Eye CRE · Selected map</div><h1>${title}</h1><div class="meta"><span>Study radius: <b>${escapeHtml(exportDoc.radiusMiles || 1)} mile(s)</b></span> · <span>Location: ${escapeHtml(Number(exportDoc.site?.lat).toFixed(5))}, ${escapeHtml(Number(exportDoc.site?.lon).toFixed(5))}</span> · <span>Geometry only. No aerial imagery.</span></div></header>${map}${mapPngScript(nonce)}</body></html>`;
}

/** doc.sections (raw SectionResult[]) -> the {sections:[{id,label,status,result}]} shape buildSummaryTiles expects. */
function tileSnapshot(doc) {
  return {
    sections: (doc.sections || []).map((result) => ({
      id: result.id,
      label: result.label,
      status: result.status,
      result,
    })),
  };
}

/**
 * The report brief's headline table: one row per tile (Metric, Value,
 * Geography, Date, Source), even for a tile with no answer, so page one
 * names the gap instead of leaving a blank cell.
 * @param {object} doc exportDoc (buildDossierExport shape)
 */
export function briefTableRows(doc) {
  const tiles = buildSummaryTiles(tileSnapshot(doc));
  const bySection = new Map((doc.sections || []).map((s) => [s.id, s]));
  return tiles.map((tile) => {
    const section = bySection.get(tile.section);
    const value =
      tile.status === 'needs-key'
        ? 'Needs free key'
        : tile.status === 'unavailable'
          ? 'Not reported'
          : `${formatTileValue(tile)}${tile.changeLabel ? ` (${tile.changeLabel})` : ''}`;
    return {
      metric: tile.label,
      value,
      geography: tile.geography || '',
      // The data's own vintage or observation date only -- never a
      // retrieval timestamp. Retrieval dates belong in the appendix
      // (per section, next to that section's full source list), so a
      // metric with no known vintage shows blank here rather than the
      // date this snapshot happened to be fetched.
      date: tile.date || '',
      // The single named source for this metric (tile.source), not the
      // whole section's combined credit string, which often names two or
      // three providers only one of which produced this figure.
      source: tile.source || section?.credit?.text || '',
      status: tile.status,
    };
  });
}

/**
 * Flood zone and top NRI perils for the brief, straight from the hazards
 * section; empty when hazards has nothing real to say (never a placeholder).
 * @param {object} doc
 */
export function hazardFlags(doc) {
  const hazards = (doc.sections || []).find((s) => s.id === 'hazards');
  const values = hazards?.values || [];
  const flags = [];
  const zone = values.find(
    (v) => v.label === FLOOD_LABELS.zone && !isPlaceholderValue(v.value),
  );
  if (zone) {
    const name = /^zone\b/i.test(String(zone.value))
      ? zone.value
      : `Zone ${zone.value}`;
    flags.push(`FEMA flood zone: ${name}`);
  }
  const perils = values.find(
    (v) => v.label === 'Top natural hazards' && !isPlaceholderValue(v.value),
  );
  if (perils && String(perils.value).trim())
    flags.push(`Top natural hazards: ${perils.value}`);
  return flags;
}

/**
 * The top 3 things to confirm before relying on this brief: an approximate
 * geocode first (the point itself may be wrong), then sections still needing
 * a key, then partial coverage, then outright unavailable, then an
 * unconfirmed location pin. Never more than 3, so the brief stays a brief.
 * @param {object} doc
 */
export function confirmItems(doc) {
  const items = [];
  if (doc.site?.approximate)
    items.push(`Approximate geocode: ${doc.site.approximate}.`);
  const byStatus = (status) =>
    (doc.sections || []).filter((s) => s.status === status);
  const needsKey = byStatus('needs-key');
  if (needsKey.length)
    items.push(
      `${needsKey.length} section${needsKey.length === 1 ? '' : 's'} need${needsKey.length === 1 ? 's' : ''} a free key: ${needsKey.map((s) => s.label).join(', ')}.`,
    );
  const partial = byStatus('partial');
  if (partial.length)
    items.push(
      `${partial.length} section${partial.length === 1 ? '' : 's'} partial coverage: ${partial.map((s) => s.label).join(', ')}.`,
    );
  const unavailable = byStatus('unavailable');
  if (unavailable.length)
    items.push(
      `${unavailable.length} section${unavailable.length === 1 ? '' : 's'} unavailable: ${unavailable.map((s) => s.label).join(', ')}.`,
    );
  if (!doc.site?.locationConfirmed)
    items.push('Location point is estimated, not user-confirmed.');
  return items.slice(0, 3);
}

/** Page one: a one-page site brief the reader can act on without turning a page. */
export function buildBrief(doc) {
  const role = doc.role === 'developer' ? 'developer' : 'investor';
  const rows = briefTableRows(doc);
  const table = rows
    .map(
      (row) =>
        `<tr><td>${escapeHtml(row.metric)}</td><td>${escapeHtml(row.value)}</td><td>${escapeHtml(row.geography)}</td><td>${escapeHtml(row.date)}</td><td>${escapeHtml(row.source)}</td></tr>`,
    )
    .join('');
  const flags = hazardFlags(doc);
  const confirm = confirmItems(doc);
  // The one-page brief has real white space below its table on most sites
  // (the table and caveat boxes rarely fill a Letter page); the rent trend
  // chart is small and already break-inside:avoid, so it uses that space
  // when there is one, instead of leaving it blank while the same chart
  // repeats identically on page two.
  const rentTrend = buildRentTrendChart(doc);
  return `<section class="brief-page1"><h2>${role === 'developer' ? 'Developer' : 'Investor'} site brief</h2><table class="brief-table"><thead><tr><th scope="col">Metric</th><th scope="col">Value</th><th scope="col">Geography</th><th scope="col">Date</th><th scope="col">Source</th></tr></thead><tbody>${table}</tbody></table>${flags.length ? `<p class="brief-hazards"><b>Hazard flags:</b> ${flags.map(escapeHtml).join(' &middot; ')}</p>` : ''}${confirm.length ? `<div class="brief-confirm"><b>Confirm before relying on this:</b><ul>${confirm.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul></div>` : ''}${rentTrend}</section>`;
}

/**
 * The same rent trend (Zillow ZORI) sparkline the dossier panel shows, drawn
 * as static inline SVG for the printed report, when the snapshot has one.
 * @param {object} doc exportDoc
 */
export function buildRentTrendChart(doc) {
  const rents = (doc.sections || []).find((s) => s.id === 'rents');
  const chart = rents?.rentsChart;
  if (!chart?.history?.length) return '';
  const dims = scaleZoriHistory(chart.history);
  const lines = dims.runs.filter((run) => run.length > 1);
  if (!lines.length) return '';
  const paths = lines
    .map(
      (run) =>
        `<path d="M${run.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' L')}" fill="none" stroke="#0f2a4a" stroke-width="2"/>`,
    )
    .join('');
  const lastRun = [...dims.runs].reverse().find((run) => run.length);
  const last = lastRun?.at(-1);
  const dot = last
    ? `<circle cx="${last.x.toFixed(2)}" cy="${last.y.toFixed(2)}" r="2.5" fill="#c9a227"/>`
    : '';
  const first = chart.history[0];
  const rangeText = first
    ? `${monthLabel(first.date)} to ${monthLabel(chart.history.at(-1).date)}`
    : '';
  const caption = `${formatMoney(dims.min ?? 0)} to ${formatMoney(dims.max ?? 0)} per month, ${rangeText}.`;
  const summary = zoriTrendSummary(chart);
  return `<section class="rent-trend"><h3>Rent trend${chart.zip ? `, ZIP ${escapeHtml(chart.zip)}` : ''}</h3><svg viewBox="0 0 ${dims.width} ${dims.height}" preserveAspectRatio="none" role="img" aria-label="${escapeHtml(summary)}">${paths}${dot}</svg><p class="rent-trend-caption">${escapeHtml(caption)}</p></section>`;
}

function scopedResearch(doc) {
  return validResearchSnapshot(doc.research, {
    ...doc.site,
    radiusMiles: doc.radiusMiles || 1,
  })
    ? buildResearchReport(doc.research)
    : '<section class="research-report"><h2>Additional research</h2><p>Research does not match this address and selected area. Re-run research for this scope.</p></section>';
}

export function buildScreeningBrief(doc) {
  const role = doc.role === 'developer' ? 'developer' : 'investor';
  const model = buildRoleInsights(
    {
      ctx: doc.site,
      sections: doc.sections.map((result) => ({
        id: result.id,
        status: result.status,
        result,
      })),
    },
    role,
  );
  const links = mapLinks(doc.site),
    notes = doc.analyst || {};
  const labels = {
    strategy: 'Investment or development thesis',
    nextStep: 'Next diligence action',
    risks: 'Analyst concerns',
    notes: 'Analyst notes',
  };
  const analyst = Object.entries(notes)
    .filter(([, value]) => value)
    .map(
      ([key, value]) =>
        `<li><b>${escapeHtml(labels[key] || key)}:</b> ${escapeHtml(value)}</li>`,
    )
    .join('');
  const groups = model.groups
    .map(
      (group) =>
        `<div class="decision-group"><h3>${escapeHtml(group.title)}</h3><p>${escapeHtml(group.question)}</p><table>${group.items.map((item) => `<tr><td class="k">${escapeHtml(item.label)}</td><td>${escapeHtml(item.text)}</td></tr>`).join('')}</table></div>`,
    )
    .join('');
  // Page one is the one-page brief (buildBrief); everything below it -- the
  // location caveats, the geometry-only dot map, the full role evidence
  // tables, analyst inputs and open questions -- starts page two, so the
  // brief a reader needs in 10 seconds is never buried under caveats first.
  return `${buildBrief(doc)}<section class="screening page2"><h2>${role === 'developer' ? 'Developer' : 'Investor'} location brief, in detail</h2><p><b>${escapeHtml(model.title)}</b></p><p><b>Location:</b> ${doc.site.locationConfirmed ? 'Point confirmed by the user' : 'Estimated address point. Property location needs confirmation.'} ${escapeHtml(doc.site.pointOrigin || 'Census/address search')}</p><p><b>Selected area:</b> ${[1, 3, 5].includes(doc.radiusMiles) ? doc.radiusMiles : 1} mile(s). Each source keeps its own geography and period; a ring does not convert city, tract or county totals into site-level findings. Read the coverage notes in the appendix.</p><p><a href="${escapeHtml(links.street)}">Inspect Street View</a> · <a href="${escapeHtml(links.map)}">Open map</a> · <a href="${escapeHtml(links.directions)}">Road directions</a></p>${buildReportContext(doc)}${groups}<h3>Analyst inputs</h3>${analyst ? `<ul>${analyst}</ul>` : '<p>No strategy or investment conclusion has been entered.</p>'}<h3>Questions to resolve before underwriting</h3><ul>${model.questions.map((q) => `<li>${escapeHtml(q)}</li>`).join('')}</ul><p>Source facts are separate from analyst inputs and AI research. This screening does not determine investment suitability, legal access, utility capacity or development entitlement.</p></section>${scopedResearch(doc)}`;
}

export function buildResearchReport(research) {
  // No research saved, and no completed layers below, are both "nothing to
  // show" -- print omits the section entirely rather than giving it a page
  // (or most of one) for a box that says only that nothing was saved. The
  // live dossier panel already communicates this in the app itself; the
  // printed report just should not spend paper on it.
  if (!research) return '';
  // The research controller supplies the serializable, source-labeled snapshot.
  const layers = Array.isArray(research.layers)
    ? research.layers
    : Object.values(research.layers || research.results || {});
  const rows = layers
    .slice(0, 12)
    .map((layer) => {
      const result = layer.result || layer;
      const citations = (result.sources || result.citations || [])
        .slice(0, 20)
        .map((source) => {
          const url = safeUrl(typeof source === 'string' ? source : source.url);
          return url
            ? `<li><a href="${escapeHtml(url)}">${escapeHtml(source.title || sourceLabel(url))}</a></li>`
            : '';
        })
        .join('');
      const text = result.summary || result.text || layer.message || '';
      const evidence = (result.evidence || [])
        .slice(0, 30)
        .map(
          (item) =>
            `<li>${escapeHtml(item.claim)} <small>${escapeHtml([item.geography, item.coveredPeriod, item.limitations].filter(Boolean).join(' · '))}</small>${safeUrl(item.sourceUrl) ? ` <a href="${escapeHtml(safeUrl(item.sourceUrl))}">${escapeHtml(item.title || 'Evidence source')}</a>` : ''}</li>`,
        )
        .join('');
      return `<div class="decision-group"><h3>${escapeHtml(layer.label || layer.id || 'Selected layer')} · ${escapeHtml(layer.status || 'Not completed')}</h3><p>${escapeHtml(text)}</p>${evidence ? `<ul>${evidence}</ul>` : ''}${citations ? `<ul>${citations}</ul>` : ''}</div>`;
    })
    .join('');
  if (!rows) return '';
  return `<section class="research-report"><h2>Additional research, sources and gaps</h2><p>AI-assisted research is separate from verified property diligence. Unfinished, failed or skipped layers remain gaps. Source dates and geographies may differ. ${Number.isFinite(research.usage?.calls) ? `Requests recorded: ${research.usage.calls}.` : ''}</p>${rows}</section>`;
}

function comparisonFact(group, item) {
  const category = /^(Grocery|Pharmacy|Retail):/i.exec(item.label)?.[1];
  const driving = /^Drive to /i.test(item.label);
  const label = category || (driving ? 'Drive to major retail' : item.label);
  return {
    label: `${group.title}: ${label}`,
    text:
      category || driving
        ? `${item.label.replace(/^Drive to /i, '')}: ${item.text}`
        : item.text,
  };
}

export function buildComparisonHtml(
  candidates,
  { role = candidates[0]?.role || 'investor' } = {},
) {
  if (candidates.length < 2 || candidates.length > 5)
    throw new Error('Choose two to five saved sites to compare.');
  role = role === 'developer' ? 'developer' : 'investor';
  const tables =
    candidates.length > 3
      ? [candidates.slice(0, 3), [candidates[0], ...candidates.slice(3)]]
      : [candidates];
  const content = tables
    .map((group) => {
      const lines = group.map((c) =>
        buildRoleInsights(
          {
            ctx: c.site,
            sections: c.sections.map((result) => ({
              id: result.id,
              status: result.status,
              result,
            })),
          },
          role,
        ).groups.flatMap((g) => g.items.map((item) => comparisonFact(g, item))),
      );
      const labels = [
        ...new Set(lines.flatMap((items) => items.map((x) => x.label))),
      ];
      const cells = (fn) =>
        group.map((c, i) => `<td>${fn(c, i)}</td>`).join('');
      const rows = labels
        .map(
          (label) =>
            `<tr><th scope="row">${escapeHtml(label)}</th>${cells((c, i) => escapeHtml(lines[i].find((x) => x.label === label)?.text || 'No result saved'))}</tr>`,
        )
        .join('');
      const meta = `<tr><th scope="row">Selected area</th>${cells((c) => `${[1, 3, 5].includes(c.radiusMiles) ? c.radiusMiles : 1} mi; ${c.site.locationConfirmed ? 'point confirmed' : 'point estimated'}`)}</tr><tr><th scope="row">Snapshot</th>${cells((c) => escapeHtml(c.generatedAt))}</tr><tr><th scope="row">Analyst next step</th>${cells((c) => escapeHtml(c.analyst?.nextStep || 'Not entered'))}</tr>`;
      return `<div class="comparison-block"><h2>${role === 'developer' ? 'Developer' : 'Investor'} comparison</h2><div class="compare-wrap"><table class="compare"><thead><tr><th scope="col">Screening question</th>${group.map((c) => `<th scope="col">${escapeHtml(c.site.address)}</th>`).join('')}</tr></thead><tbody>${meta}${rows}</tbody></table></div></div>`;
    })
    .join('');
  const appendix = candidates
    .map(
      (c) =>
        `<section class="research-report"><h2>${escapeHtml(c.site.address)}</h2><p>Snapshot ${escapeHtml(c.generatedAt)}. ${c.pending?.length ? `Pending: ${escapeHtml(c.pending.join(', '))}` : ''}</p>${c.sections
          .map(
            (s) =>
              `<p><b>${escapeHtml(s.label)}:</b> ${escapeHtml(s.status)}; fetched ${escapeHtml(s.retrievedAt)}. ${escapeHtml(s.message || '')} <a href="${escapeHtml(safeUrl(s.credit?.url))}">${escapeHtml(s.credit?.text)}</a> ${(
                s.sourceUrls || []
              )
                .map(safeUrl)
                .filter(Boolean)
                .map(
                  (url) =>
                    `<a href="${escapeHtml(url)}">${escapeHtml(new URL(url).hostname)}</a>`,
                )
                .join(' · ')}</p>`,
          )
          .join('')}${scopedResearch(c)}</section>`,
    )
    .join('');
  const nonce = makeNonce();
  const printBinding = `<script nonce="${nonce}">document.querySelectorAll("[data-cre-print]").forEach(function(b){b.addEventListener("click",function(){print()})})</script>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${printPageCsp(nonce)}<title>Selected site comparison</title><style>${PRINT_CSS}@page{size:letter landscape}body{padding:20px}.compare-wrap{overflow-x:auto}.compare{min-width:700px}</style></head><body><div class="print-controls"><button type="button" data-cre-print>Print / Save PDF</button></div><header><h1>Selected site comparison</h1><p>${candidates.length} saved snapshots, viewed as ${escapeHtml(role)}. Periods and geographies may differ; compare only compatible evidence. No automatic investment ranking.${candidates.length > 3 ? ' The first site repeats as the reference so every printed table remains readable.' : ''}</p></header>${content}<h2 class="appendix-title">Sources, coverage and research by site</h2>${appendix}${printBinding}</body></html>`;
}

/**
 * Open the print page in a new tab from a blob URL. Returns the window, or
 * null when a popup blocker refused it.
 * @param {string} html
 * @param {{windowRef?: Window, URLRef?: typeof URL, BlobRef?: typeof Blob}} [deps]
 */
export function openPrintPage(
  html,
  {
    windowRef = globalThis.window,
    URLRef = globalThis.URL,
    BlobRef = globalThis.Blob,
  } = {},
) {
  const url = URLRef.createObjectURL(
    new BlobRef([html], { type: 'text/html' }),
  );
  // SEC-06: a same-origin blob page still gets `window.opener` back to this
  // tab by default, which would let a future escaping slip in the printed
  // content reach back into the app window. The `noopener` feature makes
  // `window.open` return null on success in spec-compliant browsers (real
  // Chrome included), which made every caller wrongly report "Popup
  // blocked" even though the tab opened. So open WITHOUT `noopener` and
  // sever the opener reference by hand afterward instead: this gives a
  // truthful, non-null return value on success while still leaving the new
  // tab with no way back into this one.
  const opened = windowRef.open(url, '_blank');
  if (opened) {
    try {
      opened.opener = null;
    } catch {
      /* cross-origin or already-closed handle; nothing to sever */
    }
  }
  setTimeout(() => URLRef.revokeObjectURL(url), 60_000);
  return opened || null;
}
