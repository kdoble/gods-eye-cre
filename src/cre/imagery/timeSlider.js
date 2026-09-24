// Historical imagery time slider: steps only through the Wayback releases that changed at the site, swaps one overlay imagery layer at index 1 (never through the map stack controller), and offers a swipe compare of two dates.
import * as Cesium from 'cesium';
import {
  WAYBACK_ATTRIBUTION,
  WAYBACK_INFO_URL,
  createWaybackImageryProvider,
  displayDate,
  fetchReleaseMetadata,
  fetchWaybackChanges,
} from './waybackProvider.js';

const STYLE_ID = 'cre-timeslider-style';
const OVERLAY_INDEX = 1;

/**
 * Owns the slider's imagery layers on a viewer: one selected-release overlay
 * at index 1 and, in compare mode, one reference layer split to the left.
 * @param {object} viewer - Cesium Viewer (or a fake with imageryLayers/scene).
 * @param {{createProvider?: Function, Cesium?: object}} [options]
 */
export function createImageryOverlay(viewer, options = {}) {
  const C = options.Cesium || Cesium;
  const createProvider =
    options.createProvider ||
    ((change) => createWaybackImageryProvider(change, { Cesium: C }));
  const layers = viewer.imageryLayers;
  const scene = viewer.scene;
  let overlay = null;
  let reference = null;
  let compare = false;
  let splitPosition = 0.5;
  const savedSplit = scene?.splitPosition;

  const insertAt = () => Math.min(OVERLAY_INDEX, layers.length);

  function drop(layer) {
    if (layer && layers.contains(layer)) layers.remove(layer, true);
  }

  function applySplit() {
    if (overlay) {
      overlay.splitDirection = compare
        ? C.SplitDirection.RIGHT
        : C.SplitDirection.NONE;
    }
    if (reference) reference.splitDirection = C.SplitDirection.LEFT;
    if (scene) scene.splitPosition = compare ? splitPosition : savedSplit;
  }

  return {
    /** Show one release as the overlay, replacing the previous one. */
    show(change) {
      const next = layers.addImageryProvider(
        createProvider(change),
        insertAt(),
      );
      drop(overlay);
      overlay = next;
      applySplit();
      return overlay;
    },
    /** Compare on: `referenceChange` fills the left side, the overlay the right. */
    setCompare(on, referenceChange) {
      compare = Boolean(on);
      drop(reference);
      reference = null;
      if (compare && referenceChange) {
        reference = layers.addImageryProvider(
          createProvider(referenceChange),
          Math.min(OVERLAY_INDEX + 1, layers.length),
        );
      }
      applySplit();
    },
    /** Swipe divider position, 0 (left edge) to 1 (right edge). */
    setSplitPosition(value) {
      splitPosition = Math.min(1, Math.max(0, Number(value) || 0));
      if (compare && scene) scene.splitPosition = splitPosition;
    },
    get overlay() {
      return overlay;
    },
    get reference() {
      return reference;
    },
    /** Remove every layer this controller added and restore the split. */
    clear() {
      compare = false;
      drop(reference);
      drop(overlay);
      reference = null;
      overlay = null;
      if (scene) scene.splitPosition = savedSplit;
    },
  };
}

/**
 * Oldest-first list, so the slider reads left (old) to right (new).
 * @param {import('./waybackProvider.js').WaybackChange[]} releases - Newest first.
 */
export function orderOldestFirst(releases) {
  return [...releases].sort((a, b) =>
    a.releaseDate === b.releaseDate
      ? a.release - b.release
      : a.releaseDate < b.releaseDate
        ? -1
        : 1,
  );
}

/** One-line caption for a release. */
export function captionFor(change) {
  const parts = [];
  if (change.captureDate) parts.push(`captured ${change.captureDate}`);
  parts.push(`Wayback release ${change.releaseDate}`);
  if (Number.isFinite(change.resolutionM)) {
    parts.push(`${change.resolutionM} m source`);
  }
  if (change.provider) parts.push(change.provider);
  return parts.join(', ');
}

function injectStyle(doc) {
  if (!doc?.head || doc.getElementById(STYLE_ID)) return;
  const link = doc.createElement('link');
  link.id = STYLE_ID;
  link.rel = 'stylesheet';
  link.href = new URL('./timeSlider.css', import.meta.url).href;
  doc.head.appendChild(link);
}

function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Mount the slider into a container (the dossier panel footer). Pass
 * `changes` when the imagery section already has them; otherwise it fetches
 * the shared /api/cre/wayback/changes answer for lat/lon.
 *
 * @param {object} options
 * @param {object} options.viewer - Cesium Viewer.
 * @param {HTMLElement} options.container
 * @param {number} options.lat
 * @param {number} options.lon
 * @param {import('./waybackProvider.js').WaybackChange[]} [options.changes]
 * @param {typeof fetch} [options.fetchImpl]
 * @returns {Promise<{select:(i:number)=>void, selectOldest:()=>void, selectNewest:()=>void, setCompare:(on:boolean)=>void, getState:()=>object, destroy:()=>void}>}
 */
export async function mountTimeSlider({
  viewer,
  container,
  lat,
  lon,
  changes,
  fetchImpl,
}) {
  const doc = container.ownerDocument || globalThis.document;
  injectStyle(doc);
  const root = el(doc, 'section', 'cre-timeslider');
  root.setAttribute('data-cre-timeslider', 'loading');
  root.appendChild(
    el(doc, 'div', 'cre-timeslider__title', 'Imagery over time'),
  );
  const status = el(doc, 'div', 'cre-timeslider__status', 'Loading dates...');
  root.appendChild(status);
  container.appendChild(root);

  let list = changes;
  if (!list) {
    try {
      list = (await fetchWaybackChanges(lat, lon, { fetchImpl })).releases;
    } catch {
      status.textContent =
        'Historical imagery dates are unavailable right now (Esri Wayback did not answer).';
      root.setAttribute('data-cre-timeslider', 'unavailable');
      return inertController(root);
    }
  }
  // Copies, so capture dates filled in later never touch the shared answer.
  const ordered = orderOldestFirst(list || []).map((c) => ({ ...c }));
  if (ordered.length === 0) {
    status.textContent = 'No historical imagery releases cover this site.';
    root.setAttribute('data-cre-timeslider', 'empty');
    return inertController(root);
  }

  const overlay = createImageryOverlay(viewer);
  const newestIndex = ordered.length - 1;
  let selected = -1;
  let compare = false;

  status.textContent = `${ordered.length} imagery releases changed this site, ${displayDate(ordered[0])} to ${displayDate(ordered[newestIndex])}.`;

  const dateLabel = el(doc, 'div', 'cre-timeslider__date', 'Current basemap');
  dateLabel.setAttribute('aria-live', 'polite');
  const caption = el(doc, 'div', 'cre-timeslider__caption', '');
  const range = el(doc, 'input', 'cre-timeslider__range');
  range.type = 'range';
  range.min = '0';
  range.max = String(newestIndex);
  range.step = '1';
  range.value = String(newestIndex);
  range.setAttribute('aria-label', 'Imagery date');
  const ends = el(doc, 'div', 'cre-timeslider__ends');
  ends.append(
    el(doc, 'span', '', displayDate(ordered[0])),
    el(doc, 'span', '', displayDate(ordered[newestIndex])),
  );

  const buttons = el(doc, 'div', 'cre-timeslider__buttons');
  const mkButton = (label, action) => {
    const button = el(doc, 'button', 'cre-timeslider__btn', label);
    button.type = 'button';
    button.dataset.action = action;
    buttons.appendChild(button);
    return button;
  };
  const oldestBtn = mkButton('Oldest', 'oldest');
  const newestBtn = mkButton('Newest', 'newest');
  const compareBtn = mkButton('Compare', 'compare');
  compareBtn.setAttribute('aria-pressed', 'false');
  const offBtn = mkButton('Current', 'off');

  const credit = el(doc, 'div', 'cre-timeslider__credit');
  const creditLink = el(doc, 'a', '', `Imagery: ${WAYBACK_ATTRIBUTION}`);
  creditLink.href = WAYBACK_INFO_URL;
  creditLink.target = '_blank';
  creditLink.rel = 'noopener noreferrer';
  credit.appendChild(creditLink);

  root.append(dateLabel, range, ends, buttons, caption, credit);
  root.setAttribute('data-cre-timeslider', 'ready');

  const divider = el(doc, 'div', 'cre-timeslider__divider');
  divider.hidden = true;
  divider.append(
    el(doc, 'span', 'cre-timeslider__side cre-timeslider__side--left', ''),
    el(doc, 'span', 'cre-timeslider__side cre-timeslider__side--right', ''),
  );
  viewer.container?.appendChild?.(divider);

  function render() {
    if (selected < 0) {
      dateLabel.textContent = 'Current basemap';
      caption.textContent = '';
      root.removeAttribute('data-cre-selected-release');
      return;
    }
    const change = ordered[selected];
    dateLabel.textContent = compare
      ? `${displayDate(ordered[newestIndex])} (left) vs ${displayDate(change)} (right)`
      : displayDate(change);
    caption.textContent = captionFor(change);
    root.setAttribute('data-cre-selected-release', String(change.release));
    root.setAttribute('data-cre-selected-date', displayDate(change));
    const [left, right] = divider.children;
    left.textContent = displayDate(ordered[newestIndex]);
    right.textContent = displayDate(change);
  }

  function select(index) {
    const i = Math.min(newestIndex, Math.max(0, Math.round(Number(index))));
    if (!Number.isFinite(i)) return;
    selected = i;
    range.value = String(i);
    overlay.show(ordered[i]);
    render();
    enrich(ordered[i]);
  }

  /** Fill in the capture date for a release the changes answer left blank. */
  const tried = new Set();
  function enrich(change) {
    if (change.captureDate || tried.has(change.release)) return;
    tried.add(change.release);
    fetchReleaseMetadata(change.release, lat, lon, { fetchImpl })
      .then((meta) => {
        if (!meta.captureDate) return;
        Object.assign(change, meta);
        render();
      })
      .catch(() => {});
  }

  function setCompare(on) {
    compare = Boolean(on);
    if (compare && (selected < 0 || selected === newestIndex)) {
      // One click compares the oldest date against the newest.
      select(0);
    }
    overlay.setCompare(compare, ordered[newestIndex]);
    compareBtn.setAttribute('aria-pressed', String(compare));
    divider.hidden = !compare;
    divider.style.left = '50%';
    overlay.setSplitPosition(0.5);
    render();
  }

  function off() {
    if (compare) setCompare(false);
    overlay.clear();
    selected = -1;
    range.value = String(newestIndex);
    render();
  }

  range.addEventListener('input', () => select(range.value));
  oldestBtn.addEventListener('click', () => select(0));
  newestBtn.addEventListener('click', () => select(newestIndex));
  compareBtn.addEventListener('click', () => setCompare(!compare));
  offBtn.addEventListener('click', off);

  // Swipe: drag the divider to move the split between the two dates.
  let dragging = false;
  const moveTo = (clientX) => {
    const box = viewer.container.getBoundingClientRect();
    const pos = Math.min(1, Math.max(0, (clientX - box.left) / box.width));
    divider.style.left = `${pos * 100}%`;
    overlay.setSplitPosition(pos);
  };
  divider.addEventListener('pointerdown', (event) => {
    dragging = true;
    divider.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  });
  divider.addEventListener('pointermove', (event) => {
    if (dragging) moveTo(event.clientX);
  });
  const stop = () => {
    dragging = false;
  };
  divider.addEventListener('pointerup', stop);
  divider.addEventListener('pointercancel', stop);

  render();

  return {
    select,
    selectOldest: () => select(0),
    selectNewest: () => select(newestIndex),
    setCompare,
    getState: () => ({
      count: ordered.length,
      selected,
      compare,
      release: selected >= 0 ? ordered[selected].release : null,
      date: selected >= 0 ? displayDate(ordered[selected]) : null,
    }),
    destroy() {
      overlay.clear();
      divider.remove();
      root.remove();
    },
  };
}

function inertController(root) {
  const noop = () => {};
  return {
    select: noop,
    selectOldest: noop,
    selectNewest: noop,
    setCompare: noop,
    getState: () => ({
      count: 0,
      selected: -1,
      compare: false,
      release: null,
      date: null,
    }),
    destroy: () => root.remove(),
  };
}
