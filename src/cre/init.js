import { MAP_COLORS } from './mapColors.js';
// The single CRE entry point: in CRE mode it applies the mode policy, mounts the dossier panel, and runs the dossier whenever a location search finds a place.
import * as Cesium from 'cesium';
import './dossierPanel.css';
import { SECTIONS } from './sections.js';
import { resolveMode, startCreMode, CRE_MODE } from './mode.js';
import {
  createDossierController,
  buildSectionContext,
} from './dossierController.js';
import { createDossierPanel } from './dossierPanel.js';
import { createDossierOverlays } from './overlays.js';
import {
  buildDossierExport,
  downloadDossierJson,
  isoDate,
  slugify,
} from './export.js';
import { buildDossierCsv } from './exportCsv.js';
import { APP_VERSION } from './appVersion.js';
import {
  buildComparisonHtml,
  buildPrintHtml,
  openPrintPage,
} from './printPage.js';
import { governorRequestRender } from '../renderGovernor.js';
import { mountImagerySlider } from './sections/imagery.js';
import { RINGS_M } from './config.js';
import { destinationPoint } from './geo.js';
import { areaFramePlan, siteViewPlan, wideSiteScreenX } from './landing.js';
import { createUsFirstGeocode } from './usGeocode.js';
import { createMapLegend } from './legend.js';
import {
  createWorkspace,
  assertImportCapacity,
  candidateBackup,
  selectedCandidates,
  comparisonCsv,
  downloadText,
} from './workspace.js';
import { mountWorkspaceTools } from './workspaceTools.js';
import { usBounds } from './imports.js';
import { createResearchWorkspace } from './researchWorkspace.js';
import {
  availableCrimeCategory,
  createMapSelection,
  MAP_LAYER_OPTIONS,
} from './mapSelection.js';
import { buildMapPreviewHtml } from './printPage.js';
import { loadLocalBrandMarkOverrides } from './localBrandMarks.js';

function readStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function currentMode() {
  return resolveMode({
    search: globalThis.location?.search || '',
    storage: readStorage(),
  });
}

// Terrain is built while the scene is constructed, before initCre runs, so the
// flat-terrain request (SPEC 4.1: skip the rate-limited keyless mesh) has to be
// raised when this module is evaluated. src/maps/terrain.js reads it; it only
// matters on the keyless path, so an ion token still gets world terrain.
if (typeof window !== 'undefined' && currentMode() === CRE_MODE) {
  globalThis.__gevKeylessTerrain = 'ellipsoid';
}

/**
 * Wrap placeSearch.geocode so the dossier can read the matched place (lat,
 * lon, matched address, optional tract GEOID) that the search flight used.
 * The navigation code keeps calling the same object, so no upstream edit is
 * needed. Returns a lookup by query and a restore.
 * @param {object} placeSearch
 */
export function tapPlaceSearch(placeSearch, { fetchImpl } = {}) {
  const places = new Map();
  const outside = new Map();
  const mismatches = new Map();
  if (!placeSearch || typeof placeSearch.geocode !== 'function') {
    return {
      lookup: () => null,
      lookupOutsideUs: () => '',
      lookupCityMismatch: () => null,
      restore: () => {},
    };
  }
  const original = placeSearch.geocode;
  const usFirst = createUsFirstGeocode(
    (query, options) => original.call(placeSearch, query, options),
    fetchImpl ? { fetchImpl } : {},
  );
  const key = (query) =>
    String(query ?? '')
      .trim()
      .toLowerCase();
  const wrapped = async function creTappedGeocode(query, options) {
    const outcome = await usFirst(query, options);
    const place = outcome?.place;
    outside.delete(key(query));
    if (outcome?.cre?.outsideUs) outside.set(key(query), outcome.cre.outsideUs);
    while (outside.size > 32) outside.delete(outside.keys().next().value);
    mismatches.delete(key(query));
    if (outcome?.cre?.cityMismatch)
      mismatches.set(key(query), outcome.cre.cityMismatch);
    while (mismatches.size > 32)
      mismatches.delete(mismatches.keys().next().value);
    if (place && Number.isFinite(place.lat) && Number.isFinite(place.lng)) {
      places.set(key(query), {
        approximate: outcome?.cre?.approximate || '',
        otherMatches: outcome?.cre?.others || [],
        lat: place.lat,
        lon: place.lng,
        label: place.label || place.name || '',
        matchedAddress: place.matchedAddress || '',
        tractGeoid: place.tractGeoid || '',
        county: place.county || '',
        state: place.state || '',
        zip: place.zip || place.postalCode || '',
        groundElevation: Number.isFinite(place.groundElevation)
          ? place.groundElevation
          : null,
      });
      while (places.size > 32) places.delete(places.keys().next().value);
    }
    return outcome;
  };
  placeSearch.geocode = wrapped;
  return {
    lookup: (query) => places.get(key(query)) || null,
    lookupOutsideUs: (query) => outside.get(key(query)) || '',
    lookupCityMismatch: (query) => mismatches.get(key(query)) || null,
    restore() {
      if (placeSearch.geocode === wrapped) placeSearch.geocode = original;
    },
  };
}

/** Right edge of the dossier panel in canvas pixels on a wide screen, 0 when hidden. */
function panelRightPx(viewer) {
  const panelNode = globalThis.document?.getElementById?.('dossier-panel');
  if (!panelNode || !viewer.canvas?.getBoundingClientRect) return 0;
  const panelRect = panelNode.getBoundingClientRect();
  if (!(panelRect.width > 0)) return 0;
  return panelRect.right - viewer.canvas.getBoundingClientRect().left;
}

/**
 * Fly to a near top-down view that fits the 5 mile ring (B1-16), leaving the
 * building-centered landing of the search itself untouched.
 * @param {object} viewer
 * @param {{lat:number, lon:number}} site
 */
export function frameRings(viewer, site, CesiumRef = Cesium) {
  if (!viewer?.camera || !site) return;
  const radius = (site.radiusMiles || 5) * 1609.344 * 1.1;
  const width = viewer.canvas?.clientWidth || 0;
  const height = viewer.canvas?.clientHeight || 1;
  const plan = areaFramePlan(width, height, panelRightPx(viewer), radius);
  const aim =
    plan.westShiftM > 0
      ? destinationPoint(site.lat, site.lon, 270, plan.westShiftM)
      : { lat: site.lat, lon: site.lon };
  const center = CesiumRef.Cartesian3.fromDegrees(aim.lon, aim.lat, 0);
  viewer.camera.flyToBoundingSphere(
    new CesiumRef.BoundingSphere(center, plan.fitRadiusM),
    {
      offset: new CesiumRef.HeadingPitchRange(
        0,
        CesiumRef.Math.toRadians(-85),
        0,
      ),
      duration: 1.5,
    },
  );
}

/**
 * Height the ground is drawn at under the site: 0 on the flat ellipsoid CRE
 * uses without a terrain key, else the surveyed or sampled ground.
 */
function renderedGroundM(viewer, place, CesiumRef) {
  if (viewer.terrainProvider instanceof CesiumRef.EllipsoidTerrainProvider)
    return 0;
  if (Number.isFinite(place.groundElevation)) return place.groundElevation;
  const sampled = viewer.scene?.globe?.getHeight(
    CesiumRef.Cartographic.fromDegrees(place.lon, place.lat),
  );
  return Number.isFinite(sampled) ? sampled : 0;
}

/**
 * Fly to the straight-down site view. Replaces the oblique search flight,
 * which frames surveyed ground that the flat CRE globe does not draw.
 * @param {object} viewer
 * @param {{lat:number, lon:number, groundElevation?:number|null}} place
 */
export function flyToSiteView(viewer, place, CesiumRef = Cesium) {
  if (!viewer?.camera || !place) return;
  const width = viewer.canvas?.clientWidth || 0;
  const narrow = width <= 720;
  const panelRight = narrow ? 0 : panelRightPx(viewer);
  const plan = siteViewPlan(place, {
    groundM: renderedGroundM(viewer, place, CesiumRef),
    narrow,
    screenX: narrow ? 0.5 : wideSiteScreenX(width, panelRight),
    fovRad: viewer.camera.frustum?.fov,
  });
  viewer.camera.flyTo({
    destination: CesiumRef.Cartesian3.fromDegrees(
      plan.lon,
      plan.lat,
      plan.height,
    ),
    orientation: {
      heading: CesiumRef.Math.toRadians(plan.heading),
      pitch: CesiumRef.Math.toRadians(plan.pitchDeg),
      roll: 0,
    },
    duration: 2,
  });
}

/** Right edge of the dossier panel on a desktop layout, pixels (measured at 1440 px). */
const DESKTOP_PANEL_RIGHT_PX = 452;

/** Center of the lower 48 and the camera heights that show all of it. */
export const US_START = Object.freeze({
  lat: 38.5,
  lon: -96.5,
  heightWideM: 5_600_000,
  heightNarrowM: 9_000_000,
});

/**
 * Start view in CRE mode: straight down over the lower 48 (B1-10), in the
 * open map beside the dossier, in place of the upstream Austin fly-in.
 * Returns null outside CRE mode so the caller keeps its own start.
 * @param {object} viewer
 * @returns {null | (() => void)} A no-op cancel in CRE mode.
 */
export function startCreView(viewer, CesiumRef = Cesium) {
  if (currentMode() !== CRE_MODE || !viewer?.camera) return null;
  const width = viewer.canvas?.clientWidth || 0;
  const narrow = width > 0 && width <= 720;
  const height = narrow ? US_START.heightNarrowM : US_START.heightWideM;
  let at = { lat: US_START.lat, lon: US_START.lon };
  if (!narrow && width > 0) {
    // The panel is not mounted yet at boot; leave room for its desktop width.
    const span =
      2 * height * Math.tan((viewer.camera.frustum?.fov || Math.PI / 3) / 2);
    const shift = (wideSiteScreenX(width, DESKTOP_PANEL_RIGHT_PX) - 0.5) * span;
    if (shift > 0) at = destinationPoint(at.lat, at.lon, 270, shift);
  }
  viewer.camera.setView({
    destination: CesiumRef.Cartesian3.fromDegrees(at.lon, at.lat, height),
    orientation: { heading: 0, pitch: CesiumRef.Math.toRadians(-90), roll: 0 },
  });
  return () => {};
}

/**
 * Boot the CRE fork. Returns a teardown (pass it to the application's defer).
 * In ?mode=gev it does nothing and returns a no-op, so the upstream app runs
 * unchanged.
 * @param {object} deps
 * @param {object} deps.viewer Cesium viewer.
 * @param {object} deps.dataManager Layer lifecycle manager.
 * @param {object} deps.styleManager UI shell (subscribeLocationSearch, applyVisualState, hud).
 * @param {object} [deps.placeSearch] The instance the location bar searches with.
 * @param {{mount: Function}} [deps.layerPresentation] data.presentation, re-mounted after hiding layers.
 * @param {object} [deps.mapStackController] Reserved for the imagery slider package.
 * @param {ReadonlyArray<object>} [deps.sections] Defaults to the registry.
 * @param {Document} [deps.documentRef]
 * @returns {() => void}
 */
export function initCre({
  viewer,
  dataManager,
  styleManager,
  placeSearch,
  layerPresentation,
  sections = SECTIONS,
  documentRef = globalThis.document,
} = {}) {
  if (currentMode() !== CRE_MODE) return () => {};
  const doc = documentRef;

  // Fire-and-forget: picks up any local-brand-marks/ file the user has
  // dropped in, in place of the bundled neutral labels. A missing route
  // (production build) or an offline dev server just leaves neutral labels.
  loadLocalBrandMarkOverrides().catch(() => {});

  const overlays = createDossierOverlays({
    viewer,
    Cesium,
    requestRender: () => governorRequestRender('cre-dossier'),
  });

  let controller = null;
  let site = null;
  let slider = null;
  let sliderRun = 0;
  const workspace = createWorkspace(readStorage());
  let activeCandidate = null;
  let savedDoc = null;
  let customResults = [];
  let toolsPanel = null;
  let research = null;
  let moveHandler = null;
  let moveGeneration = 0;
  const mapSelection = createMapSelection();
  function applyMapSelection() {
    const current = mapSelection.getSnapshot();
    overlays.setCrimeFilter?.(current);
    for (const [id] of MAP_LAYER_OPTIONS)
      overlays.setLayerVisible(
        id,
        current.layers[id] && current.overlaysVisible,
      );
    overlays.setLabelDensity(current.labelDensity);
    overlays.setSectionsVisible(current.overlaysVisible);
    legend?.setOverlaysVisible?.(current.overlaysVisible);
    panel?.setMapControls?.(current);
  }
  const notice = (text) => panel.setNotice?.(text);
  const cancelMove = () => {
    moveGeneration++;
    moveHandler?.destroy();
    moveHandler = null;
    panel.setWorkspaceState?.({ moving: false });
  };
  function syncCandidates() {
    panel.setCandidates?.(workspace.list(), activeCandidate);
  }
  function syncLayers() {
    const ids = new Set(overlays.layerIds());
    const current = mapSelection.getSnapshot();
    const crimeEntry = controller
      ?.getSnapshot()
      .sections.find((entry) => entry.id === 'neighborhood');
    const categories = (crimeEntry?.result?.overlays || [])
      .filter((overlay) => overlay.id === 'crime')
      .flatMap((overlay) => overlay.geojson?.features || [])
      .map((feature) => feature.properties?.category)
      .filter(Boolean);
    if (
      crimeEntry &&
      crimeEntry.status !== 'loading' &&
      availableCrimeCategory(current.crimeCategory, categories) !==
        current.crimeCategory
    ) {
      mapSelection.setCrimeCategory('all');
      redraw();
      return;
    }
    applyMapSelection();
    legend?.setLayers?.(
      new Set(
        [...ids].filter((id) => current.layers[id] && current.overlaysVisible),
      ),
      site?.radiusMiles || 1,
    );
    panel.setLayerOptions?.(
      MAP_LAYER_OPTIONS.map(([id, label]) => ({
        id,
        label,
        available: ids.has(id),
        visible: current.layers[id] && current.overlaysVisible,
        description:
          id === 'employers'
            ? ids.has(id)
              ? 'OpenStreetMap-named workplace candidates. Current operation, employer identity and employee counts are unverified.'
              : 'No named workplace candidates were returned. Area job estimates are separate.'
            : ids.has(id)
              ? 'Source details and coverage are in Details.'
              : 'No mapped geometry returned yet. Check Details for coverage.',
      })),
    );
    panel.setCrimeCategories?.(categories, current);
  }
  function redraw() {
    if (!site) return;
    overlays.setCrimeFilter?.(mapSelection.getSnapshot());
    overlays.drawSite(site.lat, site.lon, '', site.radiusMiles || 1);
    for (const entry of controller.getSnapshot().sections)
      if (entry.result && entry.id !== 'imports')
        overlays.drawSection(entry.result);
    for (const result of customResults) overlays.drawSection(result);
    syncLayers();
  }
  function updateSite() {
    if (!site || controller.getSnapshot().refreshing) return;
    savedDoc = null;
    void controller.run(site, { refresh: true });
  }
  function startSite(place, { fresh = true } = {}) {
    toolsPanel?.resetPendingImport();
    cancelMove();
    notice('');
    savedDoc = null;
    site = { ...place, ...buildSectionContext(place) };
    if (fresh) {
      activeCandidate = null;
      customResults = [];
      toolsPanel?.setAnalyst({});
      mapSelection.restore(null);
    }
    overlays.drawSite(site.lat, site.lon, '', site.radiusMiles);
    for (const result of customResults) overlays.drawSection(result);
    legend.setVisible(true);
    flyToSiteView(viewer, site);
    dropSlider();
    const run = sliderRun;
    mountImagerySlider({
      viewer,
      container: panel.imagerySlot,
      lat: site.lat,
      lon: site.lon,
    })
      .then((mounted) => {
        if (run === sliderRun) slider = mounted;
        else mounted.destroy();
      })
      .catch(() =>
        notice(
          'Historical imagery did not load. Other site data can still be used.',
        ),
      );
    panel.setWorkspaceState?.({
      radiusMiles: site.radiusMiles,
      confirmed: site.locationConfirmed === true,
      moving: false,
    });
    syncCandidates();
    syncLayers();
    research?.setContext(site);
    void controller.run(site);
  }
  function hasUnsavedEvidence() {
    if (!site) return false;
    const baseline = workspace
      .list()
      .find((item) => item.id === activeCandidate);
    const analyst = toolsPanel?.getAnalyst() || {};
    return (
      Object.entries(analyst).some(
        ([key, value]) => value !== String(baseline?.analyst?.[key] || ''),
      ) ||
      JSON.stringify(customResults) !==
        JSON.stringify(baseline?.imports || []) ||
      JSON.stringify(mapSelection.getSnapshot()) !==
        JSON.stringify(baseline?.mapSelection || mapSelection.getSnapshot())
    );
  }
  function allowDiscard() {
    return (
      !hasUnsavedEvidence() ||
      globalThis.confirm?.(
        'Discard unsaved analyst notes and imported evidence? Cancel to save this site first.',
      ) === true
    );
  }
  function chooseCandidate(id) {
    if (!allowDiscard()) return;
    const item = workspace.list().find((x) => x.id === id);
    if (!item) return;
    toolsPanel?.resetPendingImport();
    cancelMove();
    dropSlider();
    activeCandidate = id;
    savedDoc = item;
    site = { ...item.site, radiusMiles: item.radiusMiles || 1 };
    customResults = item.imports || [];
    mapSelection.restore(item.mapSelection);
    toolsPanel?.setAnalyst(item.analyst);
    controller.restore(item);
    if (item.role) panel.setRole?.(item.role);
    research?.restore(item.research, site);
    redraw();
    flyToSiteView(viewer, site);
    legend.setVisible(true);
    panel.setWorkspaceState?.({
      radiusMiles: site.radiusMiles,
      confirmed: site.locationConfirmed === true,
    });
    syncCandidates();
    if (addressInput) addressInput.value = item.site.address;
    notice('');
  }
  function beginMove() {
    if (!site || !allowDiscard()) return;
    cancelMove();
    const generation = moveGeneration;
    const original = { ...site };
    panel.setWorkspaceState?.({ moving: true });
    notice(
      'Click the property on the map. The new point will be checked against U.S. Census geography.',
    );
    moveHandler = new Cesium.ScreenSpaceEventHandler(viewer.canvas);
    moveHandler.setInputAction(async (event) => {
      const ray = viewer.camera.getPickRay(event.position);
      const hit = viewer.scene.globe.pick(ray, viewer.scene);
      if (!hit) return;
      const at = Cesium.Cartographic.fromCartesian(hit),
        lat = Cesium.Math.toDegrees(at.latitude),
        lon = Cesium.Math.toDegrees(at.longitude);
      if (!usBounds(lon, lat)) {
        notice('Choose a point in the United States.');
        return;
      }
      try {
        const res = await fetch(
          `/api/cre/census/tracts?lat=${lat}&lon=${lon}&radiusM=100`,
        );
        const body = await res.json();
        if (generation !== moveGeneration) return;
        if (!res.ok || !body.data?.siteTract) {
          notice(
            'Could not confirm U.S. Census geography for that point. Choose another point or try again.',
          );
          return;
        }
        const tract = body.data.siteTract;
        customResults = [];
        toolsPanel.setAnalyst({});
        activeCandidate = null;
        startSite(
          {
            ...original,
            address: `${original.address || 'Site'} (map point ${lat.toFixed(5)}, ${lon.toFixed(5)})`,
            matchedAddress: '',
            lat,
            lon,
            tractGeoid: typeof tract === 'string' ? tract : tract.geoid,
            state: '',
            county: '',
            zip: '',
            locationConfirmed: true,
            pointOrigin: 'User-selected map point',
          },
          { fresh: false },
        );
        notice(
          'New point confirmed. Analyst notes and imported evidence were cleared for the new point; previous saved candidates are unchanged.',
        );
      } catch {
        if (generation === moveGeneration)
          notice(
            'Point verification did not answer. Your original location is unchanged.',
          );
      }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }
  const dropSlider = () => {
    sliderRun += 1;
    slider?.destroy();
    slider = null;
  };
  const exportDoc = () => {
    const base = savedDoc || buildDossierExport(controller.getSnapshot());
    return {
      ...base,
      sections: [
        ...base.sections.filter((s) => s.id !== 'imports'),
        ...customResults,
      ],
      analyst: toolsPanel?.getAnalyst() || {},
      role: panel.getRole?.() || 'investor',
      research: research?.getSnapshot() || null,
      imports: customResults,
      mapSelection: mapSelection.getSnapshot(),
    };
  };
  const panel = createDossierPanel({
    documentRef: doc,
    onRoleChange: (role) => {
      try {
        readStorage()?.setItem('gods-eye-cre.role.v1', role);
      } catch {
        /* Preferences are optional. */
      }
      research?.setRole(role);
    },
    onUpdate: updateSite,
    onFrameSite: () => {
      if (site) flyToSiteView(viewer, site);
    },
    onExport: () => {
      try {
        downloadDossierJson(exportDoc(), { documentRef: doc });
      } catch (error) {
        notice(
          'Export could not be generated. Complete a valid search and try again.',
        );
      }
    },
    onExportCsv: () => {
      try {
        const exported = exportDoc();
        const csv = buildDossierCsv(exported, { appVersion: APP_VERSION });
        const name = `dossier-${slugify(exported.site.address)}-${isoDate(new Date(exported.generatedAt))}.csv`;
        downloadText(csv, name, 'text/csv;charset=utf-8', doc);
      } catch (error) {
        notice(
          'CSV export could not be generated. Complete a valid search and try again.',
        );
      }
    },
    onRadiusChange: (miles) => {
      if (site) startSite({ ...site, radiusMiles: miles }, { fresh: false });
    },
    onConfirmLocation: () => {
      if (site) {
        site = {
          ...site,
          locationConfirmed: true,
          pointOrigin: site.pointOrigin || 'User-confirmed address point',
        };
        startSite(site, { fresh: false });
        notice(
          'Point confirmed. Parcel identity and legal boundaries still require verification.',
        );
      }
    },
    onMoveLocation: beginMove,
    onSaveCandidate: () => {
      try {
        activeCandidate = workspace.save(
          exportDoc(),
          activeCandidate || undefined,
        );
        syncCandidates();
        notice(
          'Site snapshot and notes saved in this browser. Export a backup to keep a portable copy.',
        );
      } catch (e) {
        notice(e.message);
      }
    },
    onSelectCandidate: chooseCandidate,
    onDeleteCandidate: (id) => {
      try {
        workspace.remove(id);
        if (activeCandidate === id) activeCandidate = null;
        syncCandidates();
        notice('Saved candidate removed. The current map remains available.');
      } catch (e) {
        notice(e.message);
      }
    },
    onCompareCandidates: (ids) => {
      try {
        if (
          !openPrintPage(
            buildComparisonHtml(selectedCandidates(workspace.list(), ids), {
              role: panel.getRole?.() || 'investor',
            }),
          )
        )
          notice(
            'Popup blocked. Allow popups for this local app and try Report again.',
          );
      } catch (e) {
        notice(e.message);
      }
    },
    onExportCandidates: (ids, format) => {
      const chosen = selectedCandidates(workspace.list(), ids);
      if (!chosen.length) {
        notice('Select at least one saved site.');
        return;
      }
      if (format === 'csv')
        downloadText(
          comparisonCsv(chosen),
          'selected-sites.csv',
          'text/csv',
          doc,
        );
      else
        downloadText(
          JSON.stringify(candidateBackup(chosen), null, 2),
          'selected-sites.json',
          'application/json',
          doc,
        );
    },
    onToggleLayer: (id, visible) => {
      mapSelection.setLayer(id, visible);
      syncLayers();
    },
    onMapPresetChange: (preset) => {
      mapSelection.setPreset(preset);
      syncLayers();
    },
    onLabelDensityChange: (density) => {
      mapSelection.setLabelDensity(density);
      syncLayers();
    },
    onCrimeModeChange: (mode) => {
      mapSelection.setCrimeMode(mode);
      redraw();
    },
    onCrimeCategoryChange: (category) => {
      mapSelection.setCrimeCategory(category);
      redraw();
    },
    onMapPreview: () => {
      try {
        if (!openPrintPage(buildMapPreviewHtml(exportDoc())))
          notice('Popup blocked. Allow popups to preview the selected map.');
      } catch {
        notice(
          'Map preview could not be generated. Complete a valid search and try again.',
        );
      }
    },
    onFrameRings: () => frameRings(viewer, site),
    onToggleOverlays: (visible) => {
      mapSelection.setOverlaysVisible(visible);
      syncLayers();
    },
    canOpenKeys: () => Boolean(doc.getElementById('key-setup-chip')),
    onOpenKeys: () => doc.getElementById('key-setup-chip')?.click(),
    onPrint: () => {
      try {
        if (!openPrintPage(buildPrintHtml(exportDoc(), { autoPrint: false })))
          notice(
            'Popup blocked. Allow popups for this local app and try Report again.',
          );
      } catch (error) {
        notice(
          'Report could not be generated. Complete a valid search and try again.',
        );
      }
    },
    onUseCityCenter: (mismatch) => {
      const center = mismatch?.cityCenter;
      if (!Number.isFinite(center?.lat) || !Number.isFinite(center?.lng))
        return;
      const label = center.label || center.name || mismatch.typed || '';
      const input = doc.getElementById('location-search');
      if (input) input.value = label;
      startSite({
        lat: center.lat,
        lon: center.lng,
        address: label,
        locationConfirmed: false,
        pointOrigin: 'City center (no verified street match)',
        approximate: 'Approximate match: city center, not a street address',
      });
    },
    // N-2: the independent city check was unresolved (Photon unreachable),
    // not disagreeing -- build at the original geocoder match rather than
    // leaving "try another address" as the only way forward.
    onUseMatchedPin: (mismatch) => {
      const place = mismatch?.matchedPlace;
      if (!Number.isFinite(place?.lat) || !Number.isFinite(place?.lng)) return;
      const label = place.label || mismatch.matchLabel || mismatch.typed || '';
      const input = doc.getElementById('location-search');
      if (input) input.value = label;
      startSite({
        lat: place.lat,
        lon: place.lng,
        address: label,
        locationConfirmed: false,
        pointOrigin: 'Matched pin (city check unavailable)',
        approximate:
          'Approximate match: the city-check service was unreachable, so this match was not independently confirmed',
      });
    },
    onTryAnotherAddress: () => {
      const input = doc.getElementById('location-search');
      input?.focus?.();
      input?.select?.();
    },
  });

  controller = createDossierController({
    sections,
    onChange(snapshot, change) {
      try {
        panel.render(snapshot);
      } catch (error) {
        console.error('[cre] dossier render refused:', error);
      }
      if (change.type === 'section' && !snapshot.refreshing) {
        const entry = snapshot.sections.find((item) => item.id === change.id);
        if (entry?.result) overlays.drawSection(entry.result);
        syncLayers();
      }
      if (change.type === 'refresh-complete') redraw();
    },
  });

  research = createResearchWorkspace({
    documentRef: doc,
    storage: readStorage(),
    onChange: (snapshot) =>
      panel.setResearchProgress?.(
        snapshot
          ? { ...snapshot, providerAvailable: Boolean(research?.hasProvider()) }
          : null,
      ),
  });
  panel.analysisSlot?.append(research.root);
  try {
    panel.setRole?.(
      readStorage()?.getItem('gods-eye-cre.role.v1') || 'investor',
    );
  } catch {
    /* Default role remains available. */
  }
  research.setRole(panel.getRole?.() || 'investor');

  toolsPanel = mountWorkspaceTools({
    container: panel.workspaceSlot,
    documentRef: doc,
    onNotice: notice,
    onRefresh: () => {
      updateSite();
    },
    onBackup: (text) => {
      workspace.importBackup(text);
      syncCandidates();
      notice('Saved sites imported without replacing existing IDs.');
    },
    onImport: (item) => {
      if (!site)
        throw new Error('Search for a U.S. site before adding evidence.');
      assertImportCapacity(customResults);
      let result;
      if (item.type === 'geojson')
        result = {
          id: 'imports',
          label: item.name,
          status: 'ready',
          values: [
            { label: 'User-imported features', value: item.data.count },
            {
              label: 'Geometry-derived area',
              value: item.data.acres,
              unit: 'acres',
              note: 'Not surveyed; imported geometry does not recalculate public-source statistics.',
            },
          ],
          overlays: [
            {
              id: `import-${customResults.length}`,
              geojson: item.data.geojson,
              style: { stroke: MAP_COLORS.imports },
            },
          ],
          credit: {
            text: item.name,
            url: item.source,
            license: 'User-provided source; verify reuse rights',
          },
          sourceUrls: [item.source],
          retrievedAt: new Date().toISOString(),
          message: `User-supplied evidence as of ${item.asOf}. Not independently verified.`,
        };
      else
        result = {
          id: 'imports',
          label:
            item.type === 'comps'
              ? 'User rent comps'
              : 'User development pipeline',
          status: 'ready',
          values: item.rows.map((r) => ({
            label: r.name,
            value: item.type === 'comps' ? r.effective_rent : r.units,
            unit: item.type === 'comps' ? '$/mo' : 'units',
            note:
              item.type === 'comps'
                ? `${r.unit_type || 'Unit type unspecified'}; asking ${r.asking_rent}; ${r.lease_months}-month lease, total concession ${r.concession_total}; as of ${r.as_of}`
                : `${r.stage}; as of ${r.as_of}; expected ${r.expected_date || 'not supplied'}`,
          })),
          credit: {
            text: 'User-supplied CSV',
            url: '',
            license: 'User evidence',
          },
          sourceUrls: [
            ...new Set(item.rows.map((row) => row.source_url).filter(Boolean)),
          ],
          retrievedAt: new Date().toISOString(),
          message:
            'User-supplied, not independently verified. Original input rows retained in saved JSON.',
          inputRows: item.rows,
        };
      customResults.push(result);
      redraw();
      notice(`Added ${result.label}. Save the site to retain this evidence.`);
    },
  });
  syncCandidates();
  if (workspace.problem) notice(workspace.problem);
  const legend = createMapLegend({
    documentRef: doc,
    narrow: (globalThis.innerWidth || 1440) <= 720,
  });
  doc.body.append(legend.root);
  let resizeTimer;
  let viewportWidth = globalThis.innerWidth;
  const onResize = () => {
    if (globalThis.innerWidth === viewportWidth) return;
    viewportWidth = globalThis.innerWidth;
    clearTimeout(resizeTimer);
    if (viewportWidth <= 720) legend.setOpen(false);
    resizeTimer = setTimeout(() => {
      if (site) flyToSiteView(viewer, site);
    }, 200);
  };
  globalThis.addEventListener?.('resize', onResize);

  const stack = doc.getElementById('left-panel-stack');
  if (stack) stack.prepend(panel.root);
  else doc.body.append(panel.root);

  const teardownMode =
    startCreMode({
      search: globalThis.location?.search || '',
      storage: readStorage(),
      documentRef: doc,
      styleManager,
      dataManager,
      layerPresentation,
      addressSlot: panel.searchSlot,
    }) || (() => {});

  const tap = tapPlaceSearch(placeSearch);
  let lastTyped = '';
  const addressInput = doc.getElementById('location-search');
  const onTyped = () => {
    lastTyped = addressInput.value;
  };
  addressInput?.addEventListener('input', onTyped);
  let rejectedSearch = false;
  const onSearch = ({ change }) => {
    if (!change) return;
    if (change.type === 'started') rejectedSearch = !allowDiscard();
    if (rejectedSearch) {
      if (change.type === 'found' || change.type === 'settled') {
        if (site) {
          flyToSiteView(viewer, site);
          if (addressInput) addressInput.value = site.address;
        }
        notice(
          'Search cancelled. Save the current notes and evidence before switching sites.',
        );
      }
      return;
    }
    if (change.type === 'started') {
      toolsPanel.resetPendingImport();
      cancelMove();
      overlays.clear();
      dropSlider();
      site = null;
      research?.setContext(null);
      savedDoc = null;
      activeCandidate = null;
      customResults = [];
      toolsPanel.setAnalyst({});
      syncCandidates();
      syncLayers();
      legend.setVisible(false);
      // Drop the previous dossier now and abort its loads (B1-07).
      controller.searching(change.query);
    } else if (change.type === 'settled') {
      // The upstream search box empties itself when a search settles; keep
      // what was typed so a typo can be fixed in place (B1-08).
      // lastTyped is what was in the box when upstream cleared it: the query,
      // or an edit already under way for the next search.
      const input = doc.getElementById('location-search');
      const keep = lastTyped || change.query;
      if (input && keep && !input.value) input.value = keep;
    } else if (change.type === 'found') {
      const place = tap.lookup(change.query);
      if (!place) {
        controller.fail('Could not read the matched location. Search again.');
        return;
      }
      startSite({
        ...place,
        address: place.matchedAddress || place.label || change.query,
        locationConfirmed: false,
        pointOrigin: 'Estimated address search point',
      });
    } else if (change.type === 'missing') {
      overlays.clear();
      dropSlider();
      const mismatch = tap.lookupCityMismatch(change.query);
      const outsideUs = tap.lookupOutsideUs(change.query);
      if (mismatch) controller.cityMismatch(mismatch);
      else if (outsideUs) controller.outsideUs(outsideUs);
      else controller.noMatch(change.query);
    } else if (change.type === 'failed') {
      overlays.clear();
      dropSlider();
      controller.fail();
    }
  };
  const unsubscribe =
    styleManager?.subscribeLocationSearch?.(onSearch, {
      emitCurrent: false,
    }) || (() => {});

  const handle = {
    controller,
    panel,
    overlays,
    getSnapshot: () => controller.getSnapshot(),
    getImagerySlider: () => slider,
    frameRings: () => frameRings(viewer, site),
    run: (place) => startSite(place),
    getCandidates: () => workspace.list(),
    getExport: exportDoc,
    research,
  };
  globalThis.__creDossier = handle;
  const onBeforeUnload = (event) => {
    if (hasUnsavedEvidence()) {
      event.preventDefault();
      event.returnValue = '';
    }
  };
  globalThis.addEventListener?.('beforeunload', onBeforeUnload);

  return () => {
    cancelMove();
    globalThis.removeEventListener?.('beforeunload', onBeforeUnload);
    toolsPanel.destroy();
    research?.destroy();
    unsubscribe();
    addressInput?.removeEventListener('input', onTyped);
    globalThis.removeEventListener?.('resize', onResize);
    clearTimeout(resizeTimer);
    legend.destroy();
    dropSlider();
    tap.restore();
    controller.destroy();
    overlays.destroy();
    teardownMode();
    panel.destroy();
    if (globalThis.__creDossier === handle) delete globalThis.__creDossier;
  };
}
