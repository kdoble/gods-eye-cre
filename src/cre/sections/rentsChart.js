// Rent trend sparkline for the rents section (feature 2): scales the last 36
// months of Zillow ZORI history into inline SVG line segments. A month with
// no published value (Zillow's file has gaps for thin ZIPs) breaks the line
// instead of being drawn as a false zero: contiguous known months form one
// path segment each, so a gap shows as a visible break, not a dip to $0.
export const CHART_WIDTH = 280;
export const CHART_HEIGHT = 72;
export const CHART_PAD_X = 4;
export const CHART_PAD_Y = 10;

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/** "Aug 2026" for an ISO month-end date, or '' when it cannot be parsed. */
export function monthLabel(iso) {
  const text = String(iso ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return '';
  return `${MONTHS[Number(text.slice(5, 7)) - 1]} ${text.slice(0, 4)}`;
}

const money = (n) =>
  `$${Math.round(n).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;

/**
 * Scale a `{date, value|null}[]` series to chart-space points, split into
 * contiguous runs at every gap so a run never bridges a missing month.
 * @param {Array<{date:string, value:number|null}>} history
 * @param {{width?:number, height?:number, padX?:number, padY?:number}} [dims]
 * @returns {{runs: Array<Array<{x:number,y:number,date:string,value:number}>>, min:number|null, max:number|null, width:number, height:number}}
 */
export function scaleZoriHistory(
  history,
  {
    width = CHART_WIDTH,
    height = CHART_HEIGHT,
    padX = CHART_PAD_X,
    padY = CHART_PAD_Y,
  } = {},
) {
  const points = Array.isArray(history) ? history : [];
  const known = points.filter((p) => Number.isFinite(p?.value));
  if (points.length < 2 || known.length < 2) {
    return { runs: [], min: null, max: null, width, height };
  }
  const min = Math.min(...known.map((p) => p.value));
  const max = Math.max(...known.map((p) => p.value));
  const span = points.length - 1;
  const x = (i) => padX + (i / span) * (width - 2 * padX);
  const y = (v) => {
    if (max === min) return height / 2;
    return padY + (1 - (v - min) / (max - min)) * (height - 2 * padY);
  };
  const runs = [];
  let current = [];
  points.forEach((p, i) => {
    if (Number.isFinite(p?.value)) {
      current.push({ x: x(i), y: y(p.value), date: p.date, value: p.value });
    } else if (current.length) {
      runs.push(current);
      current = [];
    }
  });
  if (current.length) runs.push(current);
  return { runs, min, max, width, height };
}

/**
 * One SVG path `d` string per contiguous run of at least two known points.
 * A lone point between two gaps cannot draw a line and is left out here; the
 * caller may still mark it with a dot.
 * @param {Array<{date:string, value:number|null}>} history
 * @param {{width?:number, height?:number, padX?:number, padY?:number}} [dims]
 * @returns {string[]}
 */
export function zoriSparklinePaths(history, dims) {
  const { runs } = scaleZoriHistory(history, dims);
  return runs
    .filter((run) => run.length > 1)
    .map(
      (run) =>
        'M' + run.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' L'),
    );
}

/**
 * One sentence summarizing the trend, for an aria-label and a visible text
 * fallback: latest level, and the 12 and 36 month change when available.
 * @param {{zip?:string, latest?:{date:string,value:number}, change12mPct?:number|null, change36mPct?:number|null}} meta
 */
export function zoriTrendSummary({
  zip,
  latest,
  change12mPct,
  change36mPct,
} = {}) {
  const parts = [
    `Zillow Observed Rent Index trend${zip ? `, ZIP ${zip}` : ''}`,
  ];
  if (Number.isFinite(latest?.value)) {
    parts.push(
      `latest ${money(latest.value)} per month${latest.date ? ` as of ${monthLabel(latest.date)}` : ''}`,
    );
  }
  const change = (label, pct) => {
    if (!Number.isFinite(pct)) return;
    parts.push(
      `${pct >= 0 ? 'up' : 'down'} ${Math.abs(pct).toFixed(1)}% over ${label}`,
    );
  };
  change('12 months', change12mPct);
  change('36 months', change36mPct);
  return `${parts.join(', ')}.`;
}

/**
 * Build the rent chart as an SVG element via the DOM API (never innerHTML),
 * plus a visually-hidden text fallback holding the same summary, so the
 * trend reaches a screen reader even where SVG aria-label support is patchy.
 * Returns null when there is not enough history to draw a line.
 * @param {Document} documentRef
 * @param {{history:Array<{date:string,value:number|null}>, zip?:string, latest?:object, change12mPct?:number|null, change36mPct?:number|null}} chart
 */
export function buildZoriChartNode(documentRef, chart) {
  const dims = scaleZoriHistory(chart?.history);
  if (!dims.runs.some((run) => run.length > 1)) return null;
  const NS = 'http://www.w3.org/2000/svg';
  const summary = zoriTrendSummary(chart);
  const wrap = documentRef.createElement('div');
  wrap.className = 'cre-rent-chart-wrap';
  const svg = documentRef.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'cre-rent-chart');
  svg.setAttribute('viewBox', `0 0 ${dims.width} ${dims.height}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  for (const run of dims.runs) {
    if (run.length < 2) continue;
    const path = documentRef.createElementNS(NS, 'path');
    path.setAttribute(
      'd',
      'M' + run.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' L'),
    );
    path.setAttribute('class', 'cre-rent-chart-line');
    svg.append(path);
  }
  const lastRun = [...dims.runs].reverse().find((run) => run.length);
  const last = lastRun?.at(-1);
  if (last) {
    const dot = documentRef.createElementNS(NS, 'circle');
    dot.setAttribute('cx', String(last.x));
    dot.setAttribute('cy', String(last.y));
    dot.setAttribute('r', '2.5');
    dot.setAttribute('class', 'cre-rent-chart-dot');
    svg.append(dot);
  }
  wrap.append(svg);
  const caption = documentRef.createElement('p');
  caption.className = 'cre-rent-chart-caption';
  const first = chart.history[0];
  const rangeText = first
    ? `${monthLabel(first.date)} to ${monthLabel(chart.history.at(-1).date)}`
    : '';
  caption.textContent = `${money(dims.min ?? 0)} to ${money(dims.max ?? 0)} per month, ${rangeText}. `;
  const hidden = documentRef.createElement('span');
  hidden.className = 'cre-visually-hidden';
  hidden.setAttribute('role', 'img');
  hidden.setAttribute('aria-label', summary);
  hidden.textContent = summary;
  caption.append(hidden);
  wrap.append(caption);
  return wrap;
}
