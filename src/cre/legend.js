// Compact map key for CRE mode: what the site pin, the rings and each overlay color mean, shown while a dossier is on the map and folded to one button on a phone.
import { LEGEND_ITEMS } from './mapColors.js';

export const LEGEND_ID = 'cre-map-legend';

/**
 * Create the map key. It starts hidden; show it once a site is drawn.
 * @param {{documentRef?: Document, items?: ReadonlyArray<typeof LEGEND_ITEMS[number]>, narrow?: boolean}} [options]
 */
export function createMapLegend({
  documentRef = globalThis.document,
  items = LEGEND_ITEMS,
  narrow = false,
} = {}) {
  const doc = documentRef;
  const el = (tag, className, text) => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const root = el('aside', 'cre-legend');
  root.id = LEGEND_ID;
  root.setAttribute('aria-label', 'Map key');
  root.hidden = true;
  const toggle = el('button', 'cre-legend-toggle', 'Map key');
  toggle.type = 'button';
  const list = el('ul', 'cre-legend-list');
  list.id = `${LEGEND_ID}-list`;
  toggle.setAttribute('aria-controls', list.id);
  const rows = [];
  for (const item of items) {
    const row = el('li', 'cre-legend-item');
    row.setAttribute('data-cre-legend', item.key);
    const swatch = el('span', `cre-legend-swatch cre-legend-${item.kind}`);
    swatch.setAttribute('aria-hidden', 'true');
    swatch.style?.setProperty?.('--swatch', item.color);
    row.append(swatch, el('span', 'cre-legend-label', item.label));
    list.append(row);
    rows.push({ row, item });
  }
  root.append(toggle, list);

  let visibleLayers = null;
  let overlaysVisible = true;
  const layerFor = {
    drive: 'access',
    flood: 'flood',
    wetland: 'hazards',
    epa: 'hazards',
    zones: 'incentives',
    lihtc: 'incentives',
    'public-housing': 'incentives',
    school: 'schools',
    jobs: 'jobs',
    camera: 'cameras',
    retail: 'retail',
    coffee: 'coffee',
    parks: 'parks',
    attractions: 'attractions',
    restaurants: 'restaurants',
    amenities: 'amenities',
    employers: 'employers',
    routes: 'routes',
    roads: 'roads',
    crime: 'crime',
    parcel: 'parcel',
    zoning: 'zoning',
    imports: 'imports',
  };
  const filter = () => {
    for (const { row, item } of rows)
      row.hidden =
        !!layerFor[item.key] &&
        (!overlaysVisible ||
          (visibleLayers && !visibleLayers.has(layerFor[item.key])));
  };
  let open = !narrow;
  const apply = () => {
    list.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    root.classList.toggle('open', open);
  };
  apply();
  const onToggle = () => {
    open = !open;
    apply();
  };
  toggle.addEventListener('click', onToggle);

  return {
    root,
    /** @param {boolean} visible */
    setVisible(visible) {
      root.hidden = !visible;
    },
    /** @param {boolean} value */
    setOpen(value) {
      open = Boolean(value);
      apply();
    },
    setLayers(layers, radiusMiles = 1) {
      visibleLayers = layers;
      const ring = rows.find(({ item }) => item.key === 'rings');
      if (ring)
        ring.row.querySelector('.cre-legend-label').textContent =
          `Selected ${radiusMiles}-mile area`;
      filter();
    },
    setOverlaysVisible(value) {
      overlaysVisible = Boolean(value);
      filter();
    },
    isOpen: () => open,
    destroy() {
      toggle.removeEventListener('click', onToggle);
      root.remove?.();
    },
  };
}
