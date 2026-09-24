// Shared, source-neutral map choices. The live globe and geometry export use
// these same layer IDs and visibility rules.
export const MAP_LAYER_OPTIONS = Object.freeze([
  ['schools', 'Named public schools'],
  ['retail', 'Grocery, pharmacy and major retail'],
  ['coffee', 'Named coffee shops'],
  ['parks', 'Named parks and trails'],
  ['attractions', 'Named attractions'],
  ['employers', 'Named workplaces (OSM candidates)'],
  ['restaurants', 'Restaurants'],
  ['amenities', 'Other everyday amenities'],
  ['routes', 'Named walking and driving routes'],
  ['crime', 'Reported offense records'],
  ['flood', 'FEMA flood hazard'],
  ['parcel', 'Parcel boundary'],
  ['zoning', 'Zoning districts'],
  ['hazards', 'Other environmental hazards'],
  ['roads', 'Major roads'],
  ['access', 'Drive area'],
  ['incentives', 'Housing incentives'],
  ['jobs', 'Employment clusters (area estimates)'],
  ['cameras', 'Public traffic cameras'],
  ['imports', 'Imported layers'],
]);

const ids = new Set(MAP_LAYER_OPTIONS.map(([id]) => id));
export const MAP_PRESETS = Object.freeze({
  investor: [
    'schools',
    'retail',
    'coffee',
    'parks',
    'attractions',
    'employers',
    'restaurants',
    'amenities',
    'routes',
    'crime',
    'hazards',
    'flood',
    'parcel',
  ],
  developer: [
    'schools',
    'retail',
    'parks',
    'employers',
    'restaurants',
    'amenities',
    'routes',
    'crime',
    'parcel',
    'zoning',
    'hazards',
    'flood',
    'roads',
    'access',
  ],
  presentation: [
    'schools',
    'retail',
    'coffee',
    'parks',
    'attractions',
    'parcel',
  ],
});

const defaults = () =>
  Object.fromEntries(
    MAP_LAYER_OPTIONS.map(([id]) => [id, MAP_PRESETS.investor.includes(id)]),
  );

export function normalizeMapSelection(value) {
  const preset = Object.hasOwn(MAP_PRESETS, value?.preset)
    ? value.preset
    : 'investor';
  const layers = { ...defaults() };
  for (const id of ids)
    if (typeof value?.layers?.[id] === 'boolean') layers[id] = value.layers[id];
  return {
    version: 1,
    preset,
    layers,
    labelDensity: ['key', 'all', 'off'].includes(value?.labelDensity)
      ? value.labelDensity
      : 'key',
    crimeMode: value?.crimeMode === 'density' ? 'density' : 'incidents',
    crimeCategory: String(value?.crimeCategory || 'all').slice(0, 90),
    overlaysVisible: value?.overlaysVisible !== false,
  };
}

export function createMapSelection() {
  let state = normalizeMapSelection();
  return {
    getSnapshot: () => ({ ...state, layers: { ...state.layers } }),
    restore(value) {
      state = normalizeMapSelection(value);
      return this.getSnapshot();
    },
    setPreset(preset) {
      if (!Object.hasOwn(MAP_PRESETS, preset)) return this.getSnapshot();
      state = {
        ...state,
        preset,
        layers: Object.fromEntries(
          MAP_LAYER_OPTIONS.map(([id]) => [
            id,
            MAP_PRESETS[preset].includes(id),
          ]),
        ),
      };
      return this.getSnapshot();
    },
    setLayer(id, visible) {
      if (!ids.has(id)) return this.getSnapshot();
      state = { ...state, layers: { ...state.layers, [id]: Boolean(visible) } };
      return this.getSnapshot();
    },
    setLabelDensity(value) {
      if (['key', 'all', 'off'].includes(value))
        state = { ...state, labelDensity: value };
      return this.getSnapshot();
    },
    setCrimeMode(value) {
      if (value === 'incidents' || value === 'density')
        state = { ...state, crimeMode: value };
      return this.getSnapshot();
    },
    setCrimeCategory(value) {
      state = { ...state, crimeCategory: String(value || 'all').slice(0, 90) };
      return this.getSnapshot();
    },
    setOverlaysVisible(value) {
      state = { ...state, overlaysVisible: Boolean(value) };
      return this.getSnapshot();
    },
  };
}

/** One normalized point/line maps to the same toggle on screen and in export. */
export function mapLayerForFeature(sectionId, overlayId, properties = {}) {
  if (properties.profile === 'foot' || properties.profile === 'car')
    return 'routes';
  if (overlayId === 'county-job-cluster') return 'jobs';
  if (overlayId === 'hazards-sfha') return 'flood';
  if (sectionId === 'hazards') return 'hazards';
  if (sectionId === 'schools') return 'schools';
  if (sectionId === 'destinations' || sectionId === 'amenities') {
    const category = String(properties.category || '').toLowerCase();
    if (category === 'coffee' || category === 'cafe') return 'coffee';
    if (category === 'parks' || category === 'park') return 'parks';
    if (category === 'attractions' || category === 'attraction')
      return 'attractions';
    if (category === 'employers' || category === 'workplace')
      return 'employers';
    if (category === 'restaurants') return 'restaurants';
    if (['grocery', 'pharmacy', 'retail', 'bigbox'].includes(category))
      return 'retail';
    return sectionId === 'amenities' ? 'amenities' : 'retail';
  }
  if (sectionId === 'neighborhood') return overlayId;
  return ids.has(sectionId) ? sectionId : sectionId;
}

/** Show source-reported offense rows or aggregate their mapped locations into fixed cells. */
export function crimeMapFeatures(features, selection = {}) {
  const category = String(selection?.crimeCategory || 'all');
  const selected = (features || []).filter(
    (feature) =>
      category === 'all' ||
      String(feature?.properties?.category || '') === category,
  );
  if (selection?.crimeMode !== 'density') return selected;
  const cells = new Map();
  for (const feature of selected) {
    const [lon, lat] = feature?.geometry?.coordinates || [];
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    // Approximate half-mile cells. Counts are mapped offense rows, not risk predictions.
    const x = Math.floor(lon / 0.006),
      y = Math.floor(lat / 0.006);
    const key = `${x}:${y}`;
    const cell = cells.get(key) || { x, y, count: 0 };
    cell.count++;
    cells.set(key, cell);
  }
  return [...cells.values()].map(({ x, y, count }) => ({
    type: 'Feature',
    properties: { count, category: 'reported-offense-rows', densityCell: true },
    geometry: {
      type: 'Point',
      coordinates: [(x + 0.5) * 0.006, (y + 0.5) * 0.006],
    },
  }));
}

/** A saved category disappears when the publisher changes its current window. */
export function availableCrimeCategory(category, available) {
  const chosen = String(category || 'all').slice(0, 90);
  return chosen === 'all' || (available || []).includes(chosen)
    ? chosen
    : 'all';
}

export function mapLayerVisible(selection, id) {
  if (selection?.overlaysVisible === false) return false;
  return selection?.layers?.[id] !== false;
}

export function namedLabelLimit(density) {
  return density === 'all' ? 80 : density === 'off' ? 0 : 3;
}
