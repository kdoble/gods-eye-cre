// Renders the site dossier (header, grouped sections, status badges, source credit) from a controller snapshot using only the fixed DOM contract attributes.
import {
  DOSSIER_ATTR,
  SECTION_STATUS,
  isPlaceholderValue,
} from './contract.js';
import { DOSSIER_STATE, SECTION_LOADING } from './dossierController.js';
import { buildRoleInsights, partitionGroups } from './roleInsights.js';
import { buildZoriChartNode } from './sections/rentsChart.js';
import { safeSourceUrl } from './workspace.js';
import { DEFAULT_MAX_AGE_MS, SECTION_MAX_AGE_MS } from './config.js';
import { buildSummaryTiles, formatTileValue, TILE_STATUS } from './summary.js';
import { formatLabeledValue } from './format.js';

export const DOSSIER_PANEL_ID = 'dossier-panel';

/** Human wording for each section status badge. */
export const STATUS_TEXT = Object.freeze({
  [SECTION_LOADING]: 'Loading',
  [SECTION_STATUS.READY]: 'Ready',
  [SECTION_STATUS.PARTIAL]: 'Partial coverage',
  [SECTION_STATUS.EMPTY]: 'None found',
  [SECTION_STATUS.UNAVAILABLE]: 'Unavailable',
  [SECTION_STATUS.NEEDS_KEY]: 'Needs key',
});

/**
 * Never cite the Chicago crime pilot's own data portal on a row for a city
 * that pilot does not cover. The provider falls back to the Chicago portal
 * URL for every "unsupported" city's crime row (there is no per-city crime
 * source to link instead), so the Details tab must not render it as if it
 * were this site's own source; a "published-not-connected" city keeps its
 * own official link, which is never the Chicago portal.
 * @param {string} status the value row's own status
 * @param {string} url a source URL already run through safeSourceUrl
 */
function isChicagoPilotPortal(status, url) {
  return (
    status !== 'published-not-connected' &&
    /cityofchicago\.org/i.test(String(url ?? ''))
  );
}

const IDLE_TITLE = 'Enter a property address';
const IDLE_HINT =
  'Type a street address above and press Enter. The dossier fills from free public sources: flood, demographics, jobs, schools, incentives, supply, rents and more.';

/**
 * Display text for one value, refusing placeholders. This is the render-time
 * negative: a section that slips a stand-in past the contract fails loudly.
 * @param {{label:string, value:number|string, unit?:string}} item
 */
export function formatValue(item) {
  if (isPlaceholderValue(item?.value)) {
    throw new TypeError(
      `Refusing to render placeholder value for "${item?.label ?? '?'}"`,
    );
  }
  return formatLabeledValue(item);
}

/**
 * "Jan 5, 3:08 PM" for a retrieved-at stamp, with the year whenever it is not
 * the current one. Without the year a value cached in 2022 and one fetched
 * this afternoon rendered identically (A-S3-4).
 * @param {string} iso
 * @param {Date} [now]
 */
export function formatRetrieved(iso, now = new Date()) {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return '';
  const at = new Date(time);
  return at.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(at.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * How stale a section's data is, in plain words, once it is past the cache TTL
 * behind that section. Empty while the data is inside its own window.
 * @param {string} sectionId
 * @param {string} iso
 * @param {Date} [now]
 */
export function formatAge(sectionId, iso, now = new Date()) {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return '';
  const ageMs = now.getTime() - time;
  const limit = SECTION_MAX_AGE_MS[sectionId] ?? DEFAULT_MAX_AGE_MS;
  if (!(ageMs > limit)) return '';
  const days = Math.floor(ageMs / 86_400_000);
  return `${days} day${days === 1 ? '' : 's'} old, past this section's ${Math.round(limit / 86_400_000)} day refresh window`;
}

/** "36.32069, -82.34251" */
export function formatLatLon(lat, lon) {
  return `${Number(lat).toFixed(5)}, ${Number(lon).toFixed(5)}`;
}

/**
 * Create the dossier panel element tree. Nothing is attached to the page;
 * the caller mounts `root`.
 * @param {object} options
 * @param {Document} options.documentRef
 * @param {() => void} [options.onExport]
 * @param {() => void} [options.onExportCsv]
 * @param {() => void} [options.onPrint]
 * @param {() => void} [options.onFrameRings] Fly out so the 1, 3, 5 mile rings fit.
 * @param {(collapsed:boolean) => void} [options.onToggle]
 * @param {(visible:boolean) => void} [options.onToggleOverlays] Show or hide the section map overlays.
 * @param {() => boolean} [options.canOpenKeys] True when the key and settings dialog exists.
 * @param {() => void} [options.onOpenKeys] Open the key and settings dialog.
 * @param {(miles:number)=>void} [options.onRadiusChange]
 * @param {() => void} [options.onConfirmLocation]
 * @param {() => void} [options.onMoveLocation]
 * @param {() => void} [options.onSaveCandidate]
 * @param {(id:string)=>void} [options.onSelectCandidate]
 * @param {(id:string)=>void} [options.onDeleteCandidate]
 * @param {(ids:string[])=>void} [options.onCompareCandidates]
 * @param {(ids:string[])=>void} [options.onExportCandidates]
 * @param {(id:string,visible:boolean)=>void} [options.onToggleLayer]
 * @param {(preset:string)=>void} [options.onMapPresetChange]
 * @param {(density:string)=>void} [options.onLabelDensityChange]
 * @param {()=>void} [options.onMapPreview]
 * @param {(mismatch:{typed:string,matchLabel:string,milesOff:number,cityCenter:object})=>void} [options.onUseCityCenter] Build the dossier at the typed city's center after a city-mismatch stop.
 * @param {(mismatch:{typed:string,matchLabel:string,matchedPlace:object})=>void} [options.onUseMatchedPin] N-2: build the dossier at the original geocoder match anyway, when the independent city check could not run (Photon unreachable) -- an unresolved check is not proof the match is wrong.
 * @param {()=>void} [options.onTryAnotherAddress] Focus the search box again after a city-mismatch stop.
 */
export function createDossierPanel({
  documentRef,
  onExport,
  onExportCsv,
  onPrint,
  onFrameRings,
  onFrameSite,
  onToggle,
  onToggleOverlays,
  canOpenKeys = () => false,
  onOpenKeys,
  onRadiusChange,
  onConfirmLocation,
  onMoveLocation,
  onSaveCandidate,
  onSelectCandidate,
  onDeleteCandidate,
  onCompareCandidates,
  onExportCandidates,
  onToggleLayer,
  onMapPresetChange,
  onLabelDensityChange,
  onMapPreview,
  onRoleChange,
  onUpdate,
  onCrimeModeChange,
  onCrimeCategoryChange,
  onUseCityCenter,
  onUseMatchedPin,
  onTryAnotherAddress,
}) {
  const doc = documentRef;
  const el = (tag, className, text) => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const listeners = [];
  const on = (node, type, handler) => {
    node.addEventListener(type, handler);
    listeners.push(() => node.removeEventListener(type, handler));
  };

  const root = el('section', 'panel-collapsible cre-dossier');
  root.id = DOSSIER_PANEL_ID;
  root.setAttribute('data-panel-id', DOSSIER_PANEL_ID);
  root.setAttribute('aria-label', 'Site dossier');
  root.setAttribute(DOSSIER_ATTR.STATE, DOSSIER_STATE.IDLE);

  const head = el('header', 'cre-dossier-head');
  const titleRow = el('div', 'cre-dossier-title-row');
  const kicker = el('span', 'cre-dossier-kicker', 'Site dossier');
  const collapse = el('button', 'cre-dossier-collapse', 'Hide');
  collapse.type = 'button';
  collapse.setAttribute('aria-expanded', 'true');
  collapse.setAttribute('title', 'Hide or show the dossier');
  const keysBtn = el('button', 'cre-dossier-keys', 'Keys and settings');
  keysBtn.type = 'button';
  keysBtn.setAttribute('title', 'Add or check data source keys');
  const titleTools = el('span', 'cre-dossier-title-tools');
  titleTools.append(keysBtn, collapse);
  titleRow.append(kicker, titleTools);

  const searchSlot = el('div', 'cre-dossier-search');
  // Mobile compact bar: once a site is loaded, this toggles the full header
  // (search box, meta and action buttons) open and closed, so the compact
  // bar is just the address plus this control until the reader asks for more.
  const mobileSearchToggle = el('button', 'cre-mobile-search-toggle', 'Search');
  mobileSearchToggle.type = 'button';
  mobileSearchToggle.setAttribute('aria-expanded', 'false');
  mobileSearchToggle.setAttribute(
    'aria-label',
    'Show the search box and site actions',
  );
  on(mobileSearchToggle, 'click', () => {
    const open = !head.classList.contains('cre-head-expanded');
    head.classList.toggle('cre-head-expanded', open);
    mobileSearchToggle.setAttribute('aria-expanded', String(open));
  });
  const address = el('h2', 'cre-dossier-address', IDLE_TITLE);
  // Shown when the place is not a Census street match (ZIP, name, PO Box).
  const approx = el('p', 'cre-dossier-approx', '');
  approx.setAttribute('data-cre-approximate', '');
  approx.setAttribute('role', 'note');
  approx.hidden = true;
  const meta = el('dl', 'cre-dossier-meta');
  const actions = el('div', 'cre-dossier-actions');
  const exportBtn = el('button', 'cre-btn', 'Export JSON');
  exportBtn.type = 'button';
  const exportCsvBtn = el('button', 'cre-btn', 'Export CSV');
  exportCsvBtn.type = 'button';
  exportCsvBtn.setAttribute(
    'title',
    'One row per metric, Excel-ready (RFC 4180, UTF-8 BOM)',
  );
  const printBtn = el('button', 'cre-btn cre-btn-primary', 'Report');
  printBtn.type = 'button';
  const updateBtn = el('button', 'cre-btn cre-btn-update', 'Update');
  updateBtn.type = 'button';
  updateBtn.setAttribute('data-cre-update', '');
  const frameSiteBtn = el('button', 'cre-btn', 'Frame site');
  frameSiteBtn.type = 'button';
  frameSiteBtn.setAttribute('data-cre-frame-site', '');
  const ringsBtn = el('button', 'cre-workspace-btn', 'Frame selected area');
  ringsBtn.type = 'button';
  ringsBtn.setAttribute('title', 'Frame the current 1, 3 or 5 mile radius');
  const overlaysBtn = el('button', 'cre-workspace-btn', 'Hide overlays');
  overlaysBtn.type = 'button';
  overlaysBtn.setAttribute('aria-pressed', 'true');
  overlaysBtn.setAttribute(
    'title',
    'Show or hide flood, incentive, school and other section shapes on the map',
  );
  const progress = el('span', 'cre-dossier-progress', '');
  progress.setAttribute('role', 'status');
  actions.append(
    progress,
    updateBtn,
    frameSiteBtn,
    printBtn,
    exportBtn,
    exportCsvBtn,
  );
  head.append(
    titleRow,
    searchSlot,
    address,
    mobileSearchToggle,
    approx,
    meta,
    actions,
  );

  const body = el('div', 'cre-dossier-body');
  const message = el('p', 'cre-dossier-message', IDLE_HINT);
  const mismatchActions = el('div', 'cre-mismatch-actions');
  const useCityCenterBtn = el('button', 'cre-mismatch-btn', 'Use city center');
  useCityCenterBtn.type = 'button';
  // N-2: when the independent city check is unresolved (Photon down), the
  // typed city never disagreed with anything -- the check simply could not
  // run. That is not proof of a wrong match, so the original pin is still
  // offered rather than leaving "try another address" as the only way out.
  const useMatchedPinBtn = el(
    'button',
    'cre-mismatch-btn',
    'Use this pin anyway',
  );
  useMatchedPinBtn.type = 'button';
  const tryAnotherBtn = el(
    'button',
    'cre-mismatch-btn cre-mismatch-btn-secondary',
    'Try another address',
  );
  tryAnotherBtn.type = 'button';
  mismatchActions.append(useCityCenterBtn, useMatchedPinBtn, tryAnotherBtn);
  mismatchActions.hidden = true;
  const viewNav = el('nav', 'cre-dossier-views');
  viewNav.setAttribute('aria-label', 'Dossier views');
  const viewButtons = new Map();
  for (const [id, label] of [
    ['investor', 'Investor'],
    ['developer', 'Developer'],
    ['analysis', 'Refresh log'],
    ['news', 'News & market'],
    ['details', 'Details'],
    ['map', 'Map'],
  ]) {
    const button = el('button', 'cre-view-btn', label);
    button.type = 'button';
    button.setAttribute('aria-pressed', String(id === 'investor'));
    button.setAttribute('data-view', id);
    viewButtons.set(id, button);
    viewNav.append(button);
  }
  const researchProgress = el('button', 'cre-research-progress');
  researchProgress.type = 'button';
  researchProgress.hidden = true;
  researchProgress.setAttribute('aria-live', 'polite');
  researchProgress.setAttribute('aria-label', 'Open address research progress');
  // Headline tiles: the strongest evidence, above every role tab's cards, so
  // it never hides behind a "no data" card further down. Not a section: no
  // data-dossier-* contract attributes, so the harness never counts it.
  const tiles = el('section', 'cre-tiles');
  tiles.setAttribute('data-cre-tiles', '');
  tiles.setAttribute('data-cre-view-content', 'insights');
  tiles.setAttribute('aria-label', 'Headline figures');
  const tilesGrid = el('div', 'cre-tiles-grid');
  tiles.append(tilesGrid);
  tiles.hidden = true;
  // The At a glance card is not a section: it carries none of the
  // data-dossier-* contract attributes, so the harness never counts it.
  const glance = el('section', 'cre-glance');
  glance.setAttribute('data-cre-glance', '');
  glance.setAttribute('data-cre-view-content', 'insights');
  glance.setAttribute('aria-label', 'Investor evidence');
  const glanceTitle = el(
    'h3',
    'cre-glance-title',
    'Acquisition and operating context',
  );
  const sharedContext = el('p', 'cre-insight-context', '');
  const glanceList = el('div', 'cre-insight-grid');
  glance.append(glanceTitle, sharedContext, glanceList);
  glance.hidden = true;
  const list = el('div', 'cre-dossier-sections');
  list.setAttribute('data-cre-view-content', 'details');
  const workspace = el('section', 'cre-dossier-workspace');
  workspace.setAttribute('data-cre-view-content', 'map');
  workspace.setAttribute('aria-label', 'Map and site workspace');
  const analysisPane = el('section', 'cre-analysis-pane');
  analysisPane.setAttribute('data-cre-view-content', 'analysis');
  analysisPane.setAttribute('aria-label', 'Public-source updates');
  analysisPane.hidden = true;
  const analysisTitle = el(
    'h3',
    'cre-workspace-title',
    'Update public sources',
  );
  const analysisHint = el(
    'p',
    'cre-analysis-hint',
    'Check current public sources for this site. Existing findings remain visible while each topic updates.',
  );
  const updateAction = el(
    'button',
    'cre-workspace-btn cre-update-action',
    'Update this site',
  );
  updateAction.type = 'button';
  updateAction.setAttribute('data-cre-update-action', '');
  const updateList = el('div', 'cre-update-list');
  updateList.setAttribute('data-cre-update-list', '');
  const deeper = el('details', 'cre-optional-research');
  const deeperSummary = el('summary', '', 'Optional deeper research');
  const analysisSlot = el('div', 'cre-analysis-slot');
  analysisSlot.setAttribute('data-cre-analysis-mount', '');
  deeper.append(deeperSummary, analysisSlot);
  analysisPane.append(
    analysisTitle,
    analysisHint,
    updateAction,
    updateList,
    deeper,
  );
  const newsPane = el('section', 'cre-news-pane');
  newsPane.setAttribute('data-cre-view-content', 'news');
  newsPane.setAttribute('aria-label', 'Local news, market and development');
  newsPane.hidden = true;
  newsPane.append(
    el('h3', 'cre-workspace-title', 'News, market and development'),
  );
  const newsList = el('div', 'cre-news-list');
  newsPane.append(newsList);
  const workspaceTitle = el(
    'h3',
    'cre-workspace-title',
    'Map and site workspace',
  );
  const mapTools = el('div', 'cre-workspace-actions');
  mapTools.append(ringsBtn, overlaysBtn);
  const locationState = el(
    'p',
    'cre-location-state',
    'Location has not been searched.',
  );
  locationState.setAttribute('role', 'status');
  const radiusRow = el('div', 'cre-control-row');
  const radiusLabel = el('label', 'cre-control-label', 'Analysis radius');
  const radius = el('select', 'cre-radius');
  radius.setAttribute('aria-label', 'Analysis radius, 1, 3 or 5 miles');
  for (const miles of [1, 3, 5]) {
    const option = el('option', '', `${miles} mile${miles === 1 ? '' : 's'}`);
    option.value = String(miles);
    radius.append(option);
  }
  radiusLabel.append(radius);
  const radiusScope = el(
    'p',
    'cre-radius-scope',
    'Retail is checked near the site; hospitals within 3 mi. Demographics use published areas. Supported police records and FEMA flood geometry use this selected radius.',
  );
  radiusRow.append(radiusLabel);
  radiusRow.append(radiusScope);
  const locationActions = el('div', 'cre-workspace-actions');
  const confirmLocation = el('button', 'cre-workspace-btn', 'Confirm location');
  confirmLocation.type = 'button';
  const moveLocation = el(
    'button',
    'cre-workspace-btn',
    'Move location on map',
  );
  moveLocation.type = 'button';
  locationActions.append(confirmLocation, moveLocation);
  const groundLinks = el('div', 'cre-ground-links');
  const layersTitle = el('h4', 'cre-workspace-subtitle', 'Map layers');
  const mapOptions = el('div', 'cre-map-options');
  const presetLabel = el('label', 'cre-control-label', 'Layer preset');
  const presetSelect = el('select');
  presetSelect.setAttribute('data-cre-map-preset', '');
  for (const [id, label] of [
    ['investor', 'Investor'],
    ['developer', 'Developer'],
    ['presentation', 'Presentation'],
  ]) {
    const option = el('option', '', label);
    option.value = id;
    presetSelect.append(option);
  }
  presetLabel.append(presetSelect);
  const densityLabel = el('label', 'cre-control-label', 'Place labels');
  const densitySelect = el('select');
  densitySelect.setAttribute('data-cre-label-density', '');
  for (const [id, label] of [
    ['key', 'Key names'],
    ['all', 'More names'],
    ['off', 'No names'],
  ]) {
    const option = el('option', '', label);
    option.value = id;
    densitySelect.append(option);
  }
  densityLabel.append(densitySelect);
  const crimeModeLabel = el('label', 'cre-control-label', 'Crime map');
  const crimeMode = el('select');
  crimeMode.setAttribute('data-cre-crime-mode', '');
  for (const [value, label] of [
    ['incidents', 'Offense record locations'],
    ['density', 'Mapped records by cell'],
  ]) {
    const option = el('option', '', label);
    option.value = value;
    crimeMode.append(option);
  }
  crimeModeLabel.append(crimeMode);
  const crimeCategoryLabel = el(
    'label',
    'cre-control-label',
    'Offense category',
  );
  const crimeCategory = el('select');
  crimeCategory.setAttribute('data-cre-crime-category', '');
  crimeCategoryLabel.append(crimeCategory);
  mapOptions.append(
    presetLabel,
    densityLabel,
    crimeModeLabel,
    crimeCategoryLabel,
  );
  const mapPreview = el(
    'button',
    'cre-workspace-btn',
    'Preview map / export PNG or PDF',
  );
  mapPreview.type = 'button';
  mapPreview.setAttribute('data-cre-map-preview', '');
  const mapExtent = el(
    'p',
    'cre-radius-scope',
    'Export shows the selected study radius centered on this location. It is not the current camera view.',
  );
  const layerList = el('div', 'cre-layer-list');
  const candidatesTitle = el('h4', 'cre-workspace-subtitle', 'Saved sites');
  const candidateTools = el('div', 'cre-candidate-tools');
  const saveCandidate = el('button', 'cre-workspace-btn', 'Save this site');
  saveCandidate.type = 'button';
  const compareCandidates = el(
    'button',
    'cre-workspace-btn',
    'Compare selected',
  );
  compareCandidates.type = 'button';
  const exportCandidates = el(
    'button',
    'cre-workspace-btn',
    'Backup selected (JSON)',
  );
  exportCandidates.type = 'button';
  const exportCsv = el('button', 'cre-workspace-btn', 'Table selected (CSV)');
  exportCsv.type = 'button';
  candidateTools.append(
    saveCandidate,
    compareCandidates,
    exportCandidates,
    exportCsv,
  );
  const candidatesList = el('ul', 'cre-candidate-list');
  const notice = el('p', 'cre-workspace-notice', '');
  notice.setAttribute('role', 'status');
  const workspaceSlot = el('div', 'cre-dossier-workspace-slot');
  workspaceSlot.setAttribute('data-cre-workspace-mount', '');
  workspace.append(
    workspaceTitle,
    mapTools,
    locationState,
    radiusRow,
    locationActions,
    groundLinks,
    layersTitle,
    mapOptions,
    layerList,
    mapPreview,
    mapExtent,
    candidatesTitle,
    candidateTools,
    candidatesList,
    workspaceSlot,
  );
  // Sections are re-rendered wholesale; the imagery slider lives beside them.
  const imagerySlot = el('div', 'cre-dossier-imagery');
  const backToTop = el('button', 'cre-back-to-top', 'Back to top');
  backToTop.type = 'button';
  backToTop.setAttribute('data-cre-back-to-top', '');
  body.append(
    message,
    mismatchActions,
    notice,
    viewNav,
    researchProgress,
    tiles,
    glance,
    analysisPane,
    newsPane,
    list,
    workspace,
    imagerySlot,
    backToTop,
  );
  root.append(head, body);

  on(useCityCenterBtn, 'click', () =>
    onUseCityCenter?.(lastSnapshot?.mismatch),
  );
  on(useMatchedPinBtn, 'click', () =>
    onUseMatchedPin?.(lastSnapshot?.mismatch),
  );
  on(tryAnotherBtn, 'click', () => onTryAnotherAddress?.());
  on(exportBtn, 'click', () => onExport?.());
  on(exportCsvBtn, 'click', () => onExportCsv?.());
  const doUpdate = () => {
    setView('analysis');
    onUpdate?.();
  };
  on(updateBtn, 'click', doUpdate);
  on(frameSiteBtn, 'click', () => onFrameSite?.());
  on(updateAction, 'click', doUpdate);
  on(backToTop, 'click', () => body.scrollTo?.({ top: 0, behavior: 'smooth' }));
  on(presetSelect, 'change', () => onMapPresetChange?.(presetSelect.value));
  on(densitySelect, 'change', () =>
    onLabelDensityChange?.(densitySelect.value),
  );
  on(crimeMode, 'change', () => onCrimeModeChange?.(crimeMode.value));
  on(crimeCategory, 'change', () =>
    onCrimeCategoryChange?.(crimeCategory.value),
  );
  on(mapPreview, 'click', () => onMapPreview?.());
  on(printBtn, 'click', () => onPrint?.());
  on(ringsBtn, 'click', () => onFrameRings?.());
  let overlaysVisible = true;
  on(overlaysBtn, 'click', () => {
    overlaysVisible = !overlaysVisible;
    overlaysBtn.textContent = overlaysVisible
      ? 'Hide overlays'
      : 'Show overlays';
    overlaysBtn.setAttribute('aria-pressed', String(overlaysVisible));
    onToggleOverlays?.(overlaysVisible);
  });
  on(keysBtn, 'click', () => onOpenKeys?.());
  let activeView = 'investor';
  let activeRole = 'investor';
  const setView = (view, notifyRole = true) => {
    if (!viewButtons.has(view)) return;
    activeView = view;
    if (view === 'investor' || view === 'developer') {
      const roleChanged = activeRole !== view;
      activeRole = view;
      glance.setAttribute(
        'aria-label',
        `${view === 'investor' ? 'Investor' : 'Developer'} evidence`,
      );
      glanceTitle.textContent =
        view === 'investor'
          ? 'Acquisition and operating context'
          : 'Parcel and concept feasibility context';
      renderGlance(lastSnapshot);
      if (notifyRole && roleChanged) onRoleChange?.(activeRole);
    }
    for (const [id, button] of viewButtons)
      button.setAttribute('aria-pressed', String(id === view));
    for (const node of root.querySelectorAll('[data-cre-view-content]')) {
      const content = node.getAttribute('data-cre-view-content');
      const isActive =
        content === 'insights'
          ? view === 'investor' || view === 'developer'
          : content === view;
      node.hidden =
        !isActive || ((node === glance || node === tiles) && !hasGlanceContent);
    }
    glance.hidden =
      !(view === 'investor' || view === 'developer') || !hasGlanceContent;
    tiles.hidden =
      !(view === 'investor' || view === 'developer') || !hasGlanceContent;
  };
  for (const [view, button] of viewButtons)
    on(button, 'click', () => setView(view));
  on(researchProgress, 'click', () => setView('analysis'));
  on(radius, 'change', () => onRadiusChange?.(Number(radius.value)));
  on(confirmLocation, 'click', () => onConfirmLocation?.());
  on(moveLocation, 'click', () => onMoveLocation?.());
  on(saveCandidate, 'click', () => onSaveCandidate?.());
  const selectedCandidateIds = () => [...selectedIds];
  on(compareCandidates, 'click', () =>
    onCompareCandidates?.(selectedCandidateIds()),
  );
  on(exportCandidates, 'click', () =>
    onExportCandidates?.(selectedCandidateIds(), 'json'),
  );
  on(exportCsv, 'click', () =>
    onExportCandidates?.(selectedCandidateIds(), 'csv'),
  );
  on(collapse, 'click', () => {
    const collapsed = !root.classList.contains('collapsed');
    setCollapsed(collapsed);
    onToggle?.(collapsed);
  });

  /** @type {Map<string, boolean>} section id -> user collapsed */
  const closed = new Map();
  let currentContext = null;
  let currentLocationKey = null;
  let workspaceState = { radiusMiles: 3, confirmed: false, moving: false };
  const selectedIds = new Set();
  let savedCandidates = [];
  let hasGlanceContent = false;
  let lastSnapshot = { ctx: null, sections: [] };

  function keyProvider(sectionId, message = '') {
    const text = String(message);
    if (sectionId === 'demographics' || /CENSUS_API_KEY/i.test(text))
      return 'Census';
    if (sectionId === 'rents' || /HUD_API_TOKEN/i.test(text)) return 'HUD';
    return 'provider';
  }

  function appendKeyNotice(
    host,
    provider,
    description,
    className = 'cre-key-notice',
  ) {
    const row = el('div', className);
    if (description) row.append(el('span', 'cre-key-notice-text', description));
    const action = el('button', 'cre-key-action', `Add ${provider} key`);
    action.type = 'button';
    action.disabled = !canOpenKeys();
    action.setAttribute(
      'aria-label',
      `Open provider settings to add the ${provider} key`,
    );
    action.addEventListener('click', () => onOpenKeys?.());
    row.append(action);
    host.append(row);
  }

  function setCollapsed(collapsed) {
    root.classList.toggle('collapsed', collapsed);
    collapse.textContent = collapsed ? 'Show' : 'Hide';
    collapse.setAttribute('aria-expanded', String(!collapsed));
  }

  function renderMeta(ctx, jurisdiction) {
    meta.replaceChildren();
    if (!ctx) return;
    const add = (label, value) => {
      if (!value) return;
      const row = el('div', 'cre-meta-item');
      row.append(el('dt', '', label), el('dd', '', value));
      meta.append(row);
    };
    add('County', ctx.county);
    if (jurisdiction?.status === 'resolved')
      add('Local jurisdiction', jurisdiction.name);
    else if (jurisdiction?.status === 'uncovered')
      add(
        'Dallas/Atlanta package',
        'Extra local data: available in Dallas and Atlanta',
      );
    add('Census tract', ctx.tractGeoid);
  }

  /** Scroll to a section and open it if the user had closed it. */
  function showSection(id) {
    setView('details');
    const target = [...list.querySelectorAll(`[${DOSSIER_ATTR.SECTION}]`)].find(
      (node) => node.getAttribute(DOSSIER_ATTR.SECTION) === id,
    );
    if (!target) return;
    closed.set(id, false);
    target.classList.remove('closed');
    target
      .querySelector('.cre-section-head')
      ?.setAttribute('aria-expanded', 'true');
    target.scrollIntoView?.({ block: 'start' });
  }

  /** The headline tiles: 6-8 figures readable at 375px (2 col) and desktop (4 col). */
  function renderTiles(snapshot) {
    if (!snapshot.ctx) {
      tilesGrid.replaceChildren();
      return;
    }
    const items = buildSummaryTiles(snapshot);
    tilesGrid.replaceChildren(
      ...items.map((tile) => {
        const card = el('article', `cre-tile cre-tile-${tile.status}`);
        card.setAttribute('data-cre-tile', tile.key);
        card.setAttribute('data-cre-tile-status', tile.status);
        card.append(el('span', 'cre-tile-label', tile.label));
        if (tile.status === TILE_STATUS.NEEDS_KEY) {
          const action = el(
            'button',
            'cre-tile-key-action',
            'Add free Census key',
          );
          action.type = 'button';
          action.disabled = !canOpenKeys();
          action.setAttribute(
            'aria-label',
            `${tile.needsKeyMessage || 'Needs a free key'}. Open provider settings.`,
          );
          action.addEventListener('click', () => onOpenKeys?.());
          card.append(action);
        } else if (tile.status === TILE_STATUS.UNAVAILABLE) {
          card.append(
            el('span', 'cre-tile-value cre-tile-value-muted', 'Not reported'),
          );
        } else {
          const value = el('span', 'cre-tile-value', formatTileValue(tile));
          if (tile.status === TILE_STATUS.PARTIAL)
            value.append(el('span', 'cre-tile-partial-badge', 'Partial'));
          card.append(value);
        }
        const metaParts = [tile.geography, tile.date, tile.changeLabel].filter(
          Boolean,
        );
        if (metaParts.length)
          card.append(el('span', 'cre-tile-meta', metaParts.join(' · ')));
        return card;
      }),
    );
  }

  function renderGlance(snapshot) {
    hasGlanceContent = Boolean(snapshot.ctx);
    glance.hidden = !hasGlanceContent;
    if (!snapshot.ctx) {
      sharedContext.textContent = '';
      glanceList.replaceChildren();
      return;
    }
    const ctx = snapshot.ctx;
    const radiusMiles = [1, 3, 5].includes(Number(ctx.radiusMiles))
      ? Number(ctx.radiusMiles)
      : null;
    sharedContext.textContent = `${ctx.locationConfirmed ? 'Point confirmed' : 'Estimated address point'}${ctx.county ? ` · ${ctx.county}` : ''}${ctx.state ? `, ${ctx.state}` : ''}${radiusMiles ? ` · Map area ${radiusMiles} mi` : ''}. Source geographies and dates vary; this point is not a parcel boundary.`;
    const insights = buildRoleInsights(snapshot, activeRole);
    glanceTitle.textContent = insights.title;
    const sectionFor = {
      crime: 'neighborhood',
      walkability: 'amenities',
      'retail-access': 'neighborhood',
      market: 'demographics',
      competition: 'supply',
      exposure: 'hazards',
      parcel: 'neighborhood',
      access: 'access',
      constraints: 'hazards',
      demand: 'jobs',
      program: 'schools',
    };
    const keyGroups = new Set();
    const rendered = [];
    if (ctx.approximate) {
      const warning = el('div', 'cre-glance-warning');
      warning.setAttribute('data-cre-glance-line', 'match');
      warning.setAttribute('data-cre-glance-kind', 'warning');
      warning.append(
        el('span', 'cre-glance-label', 'Location match'),
        el(
          'span',
          'cre-glance-text',
          `${ctx.approximate}. Nearby figures describe this point, not a confirmed property.`,
        ),
      );
      rendered.push(warning);
    }
    /** One evidence card for a role-insight group. `isPrimary` marks the strongest visible signal. */
    const buildGroupCard = (group, isPrimary) => {
      const card = el(
        'article',
        `cre-insight-card${isPrimary ? ' is-primary' : ''}`,
      );
      card.setAttribute('data-cre-insight', group.id);
      card.setAttribute('data-cre-glance-line', group.id);
      card.setAttribute('data-cre-glance-kind', 'evidence');
      card.append(
        el('h4', 'cre-insight-title', group.title),
        el('p', 'cre-insight-question', group.question),
      );
      const entries = el('div', 'cre-insight-items');
      /** @type {Map<string, {text:string, url:string, date:string}>} distinct sources for this card's "Sources (N)" disclosure. */
      const cardSources = new Map();
      for (const item of group.items) {
        if (item.status === SECTION_STATUS.NEEDS_KEY) {
          const provider = keyProvider(sectionFor[group.id] || group.id);
          if (keyGroups.has(provider)) continue;
          keyGroups.add(provider);
        }
        const row = el(
          'div',
          `cre-insight-item cre-insight-${item.status || 'unknown'}`,
        );
        if (item.status === SECTION_STATUS.NEEDS_KEY)
          row.setAttribute(
            'data-cre-glance-key-provider',
            keyProvider(sectionFor[group.id] || group.id),
          );
        row.append(el('span', 'cre-insight-label', item.label));
        row.append(el('span', 'cre-insight-text', item.text));
        const status = el(
          'span',
          `cre-insight-status cre-insight-status-${item.status || 'unknown'}`,
          {
            ready: 'Source returned data',
            empty: 'No matching records',
            loading: 'Researching',
            'needs-key': 'Key required',
            unavailable: 'Unavailable',
            partial: 'Partial coverage',
            'published-not-connected':
              'Official source available; feed offline',
            unsupported: 'Coverage not connected',
            stale: 'Cached source result',
          }[item.status] || 'Unknown',
        );
        row.append(status);
        if (item.status === SECTION_STATUS.NEEDS_KEY && canOpenKeys()) {
          const provider = keyProvider(sectionFor[group.id] || group.id);
          const action = el(
            'button',
            'cre-insight-key-action',
            `Add ${provider} key`,
          );
          action.type = 'button';
          action.addEventListener('click', () => onOpenKeys?.());
          row.append(action);
        }
        // Every distinct source this item cites (name, link, date) is
        // collected once for the card's single "Sources (N)" disclosure
        // below, instead of repeating a 5-6 line source block under each
        // row (measured at 6,287px of scroll for the Atlanta Investor tab
        // before this change).
        const links = [
          ...new Set(
            (item.sourceUrls || []).map(safeSourceUrl).filter(Boolean),
          ),
        ];
        if (item.source || links.length) {
          const url = links[0] || '';
          const key = `${item.source || ''}|${url}`;
          if (!cardSources.has(key)) {
            cardSources.set(key, {
              text: item.source || new URL(url).hostname.replace(/^www\./, ''),
              url,
              date: item.retrievedAt ? formatRetrieved(item.retrievedAt) : '',
            });
          }
        }
        entries.append(row);
      }
      card.append(entries);
      if (cardSources.size) {
        const disclosure = el('details', 'cre-insight-sources-summary');
        const summary = el('summary', '', `Sources (${cardSources.size})`);
        const list = el('ul', 'cre-insight-source-list');
        for (const source of cardSources.values()) {
          const li = el('li', '');
          if (source.url) {
            const link = el('a', '', source.text);
            link.setAttribute('href', source.url);
            link.setAttribute('target', '_blank');
            link.setAttribute('rel', 'noopener noreferrer');
            li.append(link);
          } else {
            li.append(el('span', '', source.text));
          }
          if (source.date)
            li.append(
              el('span', 'cre-insight-source-date', ` · ${source.date}`),
            );
          list.append(li);
        }
        disclosure.append(summary, list);
        card.append(disclosure);
      }
      const target = sectionFor[group.id];
      if (target) {
        const detail = el('button', 'cre-insight-detail', 'See source details');
        detail.type = 'button';
        detail.setAttribute('data-cre-insight-target', target);
        detail.addEventListener('click', () => showSection(target));
        card.append(detail);
      }
      return card;
    };
    const { visible, hidden } = partitionGroups(insights.groups);
    rendered.push(
      ...visible.map((group, index) => buildGroupCard(group, index === 0)),
    );
    if (hidden.length) {
      const noData = el('details', 'cre-insight-nodata');
      const summary = el(
        'summary',
        '',
        `No data for this location (${hidden.length})`,
      );
      const hiddenGrid = el('div', 'cre-insight-grid');
      hiddenGrid.append(...hidden.map((group) => buildGroupCard(group, false)));
      noData.append(summary, hiddenGrid);
      rendered.push(noData);
    }
    const next = el('section', 'cre-insight-next');
    next.append(
      el(
        'h4',
        '',
        activeRole === 'investor'
          ? 'Next diligence checks'
          : 'Next site checks',
      ),
    );
    const tasks = el('ul', 'cre-insight-tasks');
    for (const question of insights.questions)
      tasks.append(el('li', '', question));
    next.append(tasks);
    glanceList.replaceChildren(...rendered, next);
  }

  function renderSection(entry) {
    const { id, status, result } = entry;
    const block = el('section', `cre-section cre-status-${status}`);
    block.setAttribute(DOSSIER_ATTR.SECTION, id);
    block.setAttribute(DOSSIER_ATTR.STATUS, status);
    const isClosed = closed.get(id) === true;
    if (isClosed) block.classList.add('closed');

    const header = el('button', 'cre-section-head');
    header.type = 'button';
    header.setAttribute('aria-expanded', String(!isClosed));
    const name = el('span', 'cre-section-label', entry.label);
    const badge = el(
      'span',
      `cre-badge cre-badge-${status}`,
      STATUS_TEXT[status] || status,
    );
    header.append(name, badge);
    // Section nodes are rebuilt on every render, so their listeners die with them.
    header.addEventListener('click', () => {
      const next = !block.classList.contains('closed');
      closed.set(id, next);
      block.classList.toggle('closed', next);
      header.setAttribute('aria-expanded', String(!next));
    });
    block.append(header);

    const content = el('div', 'cre-section-body');
    if (status === SECTION_LOADING)
      content.append(
        el(
          'p',
          'cre-section-note',
          result
            ? `Updating source; showing data retrieved ${formatRetrieved(result.retrievedAt) || 'at an unknown time'}.`
            : 'Querying the source.',
        ),
      );
    if (
      entry.refresh?.status === 'failed' ||
      entry.refresh?.status === 'throttled'
    ) {
      const reason =
        entry.refresh.status === 'failed'
          ? 'Refresh failed'
          : 'Refresh was rate limited';
      const existing = result && result.status !== SECTION_STATUS.UNAVAILABLE;
      content.append(
        el(
          'p',
          'cre-refresh-warning',
          existing
            ? `${reason}; showing data retrieved ${formatRetrieved(entry.refresh.dataRetrievedAt || result.retrievedAt) || 'at an unknown time'}.`
            : `${reason}; no current result is available.`,
        ),
      );
    }
    if (result) {
      if (result.values.length) {
        const values = el('dl', 'cre-values');
        for (const item of result.values) {
          const row = el('div', 'cre-value-row');
          const dt = el('dt', '', item.label);
          const dd = el('dd', '');
          const cell = el('span', 'cre-value', formatValue(item));
          cell.setAttribute(DOSSIER_ATTR.VALUE, '');
          dd.append(cell);
          if (item.note) dd.append(el('span', 'cre-value-note', item.note));
          for (const rawUrl of (item.sourceUrls || []).slice(0, 3)) {
            const url = safeSourceUrl(rawUrl);
            if (!url) continue;
            if (isChicagoPilotPortal(item.status, url)) continue;
            const sourceLink = el('a', 'cre-value-source', 'Open record');
            sourceLink.href = url;
            sourceLink.target = '_blank';
            sourceLink.rel = 'noopener noreferrer';
            dd.append(sourceLink);
          }
          row.append(dt, dd);
          values.append(row);
        }
        content.append(values);
      }
      if (result.id === 'rents' && result.rentsChart) {
        const chart = buildZoriChartNode(doc, result.rentsChart);
        if (chart) content.append(chart);
      }
      if (status === SECTION_STATUS.NEEDS_KEY) {
        const provider = keyProvider(id, result.message);
        appendKeyNotice(
          content,
          provider,
          `${provider} data needs a key. Add it in provider settings to load this section.`,
          'cre-section-key-notice',
        );
      } else if (result.message) {
        content.append(el('p', 'cre-section-note', result.message));
      }
      const source = el('p', 'cre-section-source');
      const creditText = result.credit?.text || 'Unknown source';
      if (result.credit?.url && /^https?:\/\//i.test(result.credit.url)) {
        const link = el('a', '', creditText);
        link.setAttribute('href', result.credit.url);
        link.setAttribute('target', '_blank');
        link.setAttribute('rel', 'noopener noreferrer');
        source.append(el('span', '', 'Source: '), link);
      } else {
        source.append(el('span', '', `Source: ${creditText}`));
      }
      const when = formatRetrieved(result.retrievedAt);
      if (when) source.append(el('span', 'cre-retrieved', ` · ${when}`));
      const age = formatAge(result.id, result.retrievedAt);
      if (age) source.append(el('span', 'cre-stale', ` · ${age}`));
      content.append(source);
    }
    block.append(content);
    return block;
  }

  function renderTopicCard(entry, compact = false) {
    const card = el('article', 'cre-topic-card');
    card.setAttribute('data-cre-topic', entry.id);
    const heading = el('h4', 'cre-topic-title', entry.label);
    const status =
      entry.refresh?.status === 'loading' || entry.status === SECTION_LOADING
        ? 'Updating'
        : entry.refresh?.status === 'failed'
          ? 'Refresh failed'
          : entry.refresh?.status === 'throttled'
            ? 'Rate limited'
            : entry.refresh?.status === 'succeeded'
              ? 'Updated'
              : entry.refresh?.status === 'partial'
                ? 'Partial coverage after update'
                : entry.refresh?.status === 'joined-existing'
                  ? 'Checked with another request'
                  : entry.refresh?.status === 'checked'
                    ? 'Checked (may use cached data)'
                    : STATUS_TEXT[entry.status] || entry.status;
    const badge = el('span', 'cre-topic-status', status);
    card.append(heading, badge);
    if (
      entry.refresh?.status === 'failed' ||
      entry.refresh?.status === 'throttled'
    )
      card.append(
        el(
          'p',
          'cre-refresh-warning',
          entry.result && entry.result.status !== SECTION_STATUS.UNAVAILABLE
            ? `Showing earlier data from ${formatRetrieved(entry.refresh.dataRetrievedAt || entry.result.retrievedAt) || 'an unknown retrieval date'}.`
            : 'No current result is available from this source.',
        ),
      );
    if (entry.result) {
      const date = formatRetrieved(entry.result.retrievedAt);
      if (date)
        card.append(el('p', 'cre-topic-date', `Data retrieved ${date}`));
      const rows = compact
        ? entry.result.values.slice(0, 5)
        : entry.result.values.slice(0, 2);
      for (const value of rows) {
        const row = el('p', 'cre-topic-finding');
        const title = formatValue(value);
        const directUrl = safeSourceUrl(value.externalUrl);
        const text = directUrl
          ? el('a', 'cre-topic-direct', title)
          : el('span', '', title);
        if (directUrl) {
          text.setAttribute('href', directUrl);
          text.setAttribute('target', '_blank');
          text.setAttribute('rel', 'noopener noreferrer');
        }
        row.append(el('strong', '', `${value.label}: `), text);
        if (value.note)
          row.append(el('span', 'cre-topic-note', ` ${value.note}`));
        card.append(row);
      }
      if (compact && entry.result.values.length > rows.length) {
        const more = el(
          'button',
          'cre-insight-detail',
          `Showing ${rows.length} of ${entry.result.values.length} findings. View all source details`,
        );
        more.type = 'button';
        more.addEventListener('click', () => showSection(entry.id));
        card.append(more);
      }
      if (!rows.length && entry.result.message)
        card.append(el('p', 'cre-topic-note', entry.result.message));
      const links = [
        ...new Set(
          [
            ...(entry.result.sourceUrls || []),
            ...(entry.result.values || []).flatMap((v) => v.sourceUrls || []),
          ]
            .map(safeSourceUrl)
            .filter(Boolean),
        ),
      ].slice(0, 3);
      if (links.length) {
        const linkRow = el('p', 'cre-topic-links');
        for (const url of links) {
          const link = el('a', '', new URL(url).hostname.replace(/^www\./, ''));
          link.href = url;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          linkRow.append(link);
        }
        card.append(linkRow);
      }
    }
    return card;
  }

  /**
   * Render a controller snapshot. Throws when a value is a placeholder.
   * @param {import('./dossierController.js').DossierSnapshot} snapshot
   */
  function render(snapshot) {
    lastSnapshot = snapshot;
    const blocks = snapshot.sections.map(renderSection);
    renderTiles(snapshot);
    renderGlance(snapshot);
    updateList.replaceChildren(
      ...snapshot.sections.map((entry) => renderTopicCard(entry)),
    );
    const newsEntries = snapshot.sections.filter((entry) =>
      ['local-news', 'market', 'development'].includes(entry.id),
    );
    newsList.replaceChildren(
      ...(newsEntries.length
        ? newsEntries.map((entry) => renderTopicCard(entry, true))
        : [
            el(
              'p',
              'cre-topic-note',
              'Local news and market sources are not connected for this site yet.',
            ),
          ]),
    );
    root.setAttribute(DOSSIER_ATTR.STATE, snapshot.state);
    const ctx = snapshot.ctx;
    currentContext = ctx || null;
    const locationKey = ctx ? `${Number(ctx.lat)}:${Number(ctx.lon)}` : null;
    if (locationKey !== currentLocationKey) {
      currentLocationKey = locationKey;
      workspaceState.confirmed = Boolean(ctx?.locationConfirmed);
    } else if (ctx?.locationConfirmed !== undefined) {
      workspaceState.confirmed = Boolean(ctx.locationConfirmed);
    }
    address.textContent = ctx
      ? ctx.address || formatLatLon(ctx.lat, ctx.lon)
      : IDLE_TITLE;
    address.hidden = !ctx;
    const others = ctx?.otherMatches?.length
      ? ` Other US matches: ${ctx.otherMatches.join('; ')}.`
      : '';
    approx.textContent = ctx?.approximate
      ? `${ctx.approximate}. Enter the street address for the property itself.${others}`
      : '';
    approx.hidden = !approx.textContent;
    const jurisdiction = snapshot.sections.find(
      (entry) => entry.id === 'neighborhood',
    )?.result?.jurisdiction;
    renderMeta(ctx, jurisdiction);
    const approximateLocation = Boolean(ctx && !workspaceState.confirmed);
    locationState.textContent = !ctx
      ? 'Search for a site to open its map and nearby context.'
      : approximateLocation
        ? 'Estimated location. Confirm the pin before relying on nearby results.'
        : 'Location confirmed for this site.';
    confirmLocation.disabled = !ctx || workspaceState.confirmed;
    moveLocation.disabled = !ctx;
    groundLinks.replaceChildren();
    if (
      ctx &&
      Number.isFinite(Number(ctx.lat)) &&
      Number.isFinite(Number(ctx.lon))
    ) {
      const lat = Number(ctx.lat);
      const lon = Number(ctx.lon);
      for (const [label, href] of [
        [
          'Open in Google Maps',
          `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`,
        ],
        [
          'Street View coverage',
          `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat},${lon}`,
        ],
        [
          'Open in OpenStreetMap',
          `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=16/${lat}/${lon}`,
        ],
      ]) {
        const link = el('a', 'cre-ground-link', label);
        link.setAttribute('href', href);
        link.setAttribute('target', '_blank');
        link.setAttribute('rel', 'noopener noreferrer');
        groundLinks.append(link);
      }
    }
    const hasDossier = Boolean(ctx);
    // Mobile only (see CSS): once a site has loaded, the header block
    // (search box, address, buttons) collapses to a single compact bar so
    // data is visible in the first screen at 375x812, instead of pushing
    // every result below a full header's worth of chrome.
    root.classList.toggle('cre-site-loaded', hasDossier);
    exportBtn.disabled = !hasDossier;
    exportCsvBtn.disabled = !hasDossier;
    printBtn.disabled = !hasDossier;
    updateBtn.disabled = !hasDossier || Boolean(snapshot.refreshing);
    frameSiteBtn.disabled = !hasDossier;
    updateAction.disabled = updateBtn.disabled;
    updateAction.textContent = snapshot.refreshing
      ? 'Updating sources…'
      : 'Update this site';
    ringsBtn.disabled = !hasDossier;
    saveCandidate.disabled = !hasDossier;
    keysBtn.hidden = !canOpenKeys();

    const total = snapshot.sections.length;
    const ready = snapshot.sections.filter(
      (entry) => entry.status === SECTION_STATUS.READY,
    ).length;
    const pending = snapshot.sections.filter(
      (entry) => entry.status === SECTION_LOADING,
    ).length;
    // N-1: a section that returned data with partial coverage is not the
    // same gap as one with no feed at all -- it answered, just not fully.
    // Count it separately so "not available" only ever means empty,
    // unavailable, or needs-key, never a partial result mislabeled as a
    // total miss.
    const partial = snapshot.sections.filter(
      (entry) => entry.status === SECTION_STATUS.PARTIAL,
    ).length;
    // Every non-loading, non-ready, non-partial section (none found,
    // unavailable, needs a key) is a settled gap, never still-fetching --
    // pending counts only SECTION_LOADING above, so a permanently-partial
    // or no-feed section is never mistaken for "will finish shortly." Once
    // nothing is left loading, say so explicitly instead of leaving the
    // reader to guess whether "18 of 21" means 3 more are still coming.
    const notAvailable = total - ready - pending - partial;
    const gapsSuffix = [
      partial ? `${partial} partial` : null,
      notAvailable ? `${notAvailable} not available here` : null,
    ]
      .filter(Boolean)
      .join(', ');
    progress.textContent = !hasDossier
      ? ''
      : total === 0
        ? 'No sections installed'
        : pending
          ? `Loading, ${ready} of ${total} ready`
          : gapsSuffix
            ? `Ready: ${ready} of ${total} (${gapsSuffix})`
            : `${ready} of ${total} sections ready`;

    if (snapshot.state === DOSSIER_STATE.IDLE) message.textContent = IDLE_HINT;
    else message.textContent = snapshot.message || '';
    message.hidden = !message.textContent;
    message.className = `cre-dossier-message cre-message-${snapshot.state}`;
    const isMismatch = snapshot.state === DOSSIER_STATE.CITY_MISMATCH;
    mismatchActions.hidden = !isMismatch;
    if (isMismatch) {
      const center = snapshot.mismatch?.cityCenter;
      const typedCity = String(center?.city || center?.name || '').trim();
      useCityCenterBtn.textContent = typedCity
        ? `Use ${typedCity} city center`
        : 'Use city center';
      useCityCenterBtn.disabled = !center;
      // N-2: only offered when the check was unresolved (Photon down) and
      // the original geocoder match is available -- a real disagreement
      // (cityCenter present, unresolved false) still has no "anyway" out.
      const matchedPlace = snapshot.mismatch?.matchedPlace;
      useMatchedPinBtn.hidden = !snapshot.mismatch?.unresolved;
      useMatchedPinBtn.disabled = !matchedPlace;
    }
    list.replaceChildren(...blocks);
    setView(activeView);
  }

  function setCandidates(candidates = [], activeId = null) {
    savedCandidates = Array.isArray(candidates) ? candidates.slice(0, 5) : [];
    candidatesList.replaceChildren();
    for (const candidate of savedCandidates) {
      const id = String(candidate?.id ?? '');
      if (!id) continue;
      const site = candidate.site || {};
      const item = el('li', 'cre-candidate');
      const checkbox = el('input');
      checkbox.type = 'checkbox';
      checkbox.value = id;
      checkbox.checked = selectedIds.has(id);
      checkbox.setAttribute('data-candidate-select', '');
      checkbox.setAttribute(
        'aria-label',
        `Select ${site.address || 'saved site'} for comparison or export`,
      );
      const select = el(
        'button',
        'cre-candidate-select',
        site.address || `Saved site ${id}`,
      );
      select.type = 'button';
      select.setAttribute('data-candidate-action', 'select');
      select.setAttribute('data-candidate-id', id);
      select.setAttribute('aria-pressed', String(id === activeId));
      const remove = el('button', 'cre-candidate-delete', 'Remove');
      remove.type = 'button';
      remove.setAttribute('data-candidate-action', 'delete');
      remove.setAttribute('data-candidate-id', id);
      item.append(checkbox, select, remove);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) selectedIds.add(id);
        else selectedIds.delete(id);
        updateCandidateActions();
      });
      select.addEventListener('click', () => onSelectCandidate?.(id));
      remove.addEventListener('click', () => onDeleteCandidate?.(id));
      candidatesList.append(item);
    }
    if (!savedCandidates.length)
      candidatesList.append(
        el(
          'li',
          'cre-empty-candidates',
          'Save a site to compare it with other locations.',
        ),
      );
    for (const id of [...selectedIds])
      if (!savedCandidates.some((c) => String(c?.id ?? '') === id))
        selectedIds.delete(id);
    updateCandidateActions();
  }

  function updateCandidateActions() {
    compareCandidates.disabled = selectedIds.size < 2 || selectedIds.size > 5;
    exportCandidates.disabled = selectedIds.size === 0;
    exportCsv.disabled = selectedIds.size === 0;
  }

  function setLayerOptions(options = []) {
    layerList.replaceChildren();
    for (const option of Array.isArray(options) ? options : []) {
      if (!option?.id || !option?.label) continue;
      const label = el(
        'label',
        `cre-layer${option.available ? '' : ' is-unavailable'}`,
      );
      const input = el('input');
      input.type = 'checkbox';
      input.setAttribute('data-layer-id', String(option.id));
      input.checked = Boolean(option.visible);
      input.disabled = !option.available;
      input.setAttribute('aria-label', String(option.label));
      input.addEventListener('change', () =>
        onToggleLayer?.(String(option.id), input.checked),
      );
      label.append(input, el('span', 'cre-layer-label', String(option.label)));
      if (option.description) label.title = String(option.description);
      if (!option.available)
        label.append(el('span', 'cre-layer-state', 'Unavailable'));
      layerList.append(label);
    }
    layersTitle.hidden = !layerList.children.length;
  }

  function setMapControls(selection = {}) {
    presetSelect.value = selection.preset || 'investor';
    densitySelect.value = selection.labelDensity || 'key';
    crimeMode.value = selection.crimeMode || 'incidents';
    crimeCategory.value = selection.crimeCategory || 'all';
    const shown = selection.overlaysVisible !== false;
    overlaysVisible = shown;
    overlaysBtn.textContent = shown ? 'Hide overlays' : 'Show overlays';
    overlaysBtn.setAttribute('aria-pressed', String(shown));
  }

  function setCrimeCategories(categories = [], selection = {}) {
    const current = selection.crimeCategory || 'all';
    crimeCategory.replaceChildren();
    const all = el('option', '', 'All reported categories');
    all.value = 'all';
    crimeCategory.append(all);
    for (const category of [
      ...new Set(categories.map(String).filter(Boolean)),
    ].sort()) {
      const option = el('option', '', category);
      option.value = category;
      crimeCategory.append(option);
    }
    crimeCategory.value = [...crimeCategory.options].some(
      (option) => option.value === current,
    )
      ? current
      : 'all';
    crimeMode.disabled = categories.length === 0;
    crimeCategory.disabled = categories.length === 0;
  }

  function setWorkspaceState(next = {}) {
    workspaceState = { ...workspaceState, ...next };
    const miles = [1, 3, 5].includes(Number(workspaceState.radiusMiles))
      ? Number(workspaceState.radiusMiles)
      : 3;
    radius.value = String(miles);
    confirmLocation.disabled =
      !currentContext || Boolean(workspaceState.confirmed);
    confirmLocation.textContent = workspaceState.confirmed
      ? 'Location confirmed'
      : 'Confirm location';
    locationState.textContent = !currentContext
      ? 'Search for a site to open its map and nearby context.'
      : workspaceState.confirmed
        ? 'Location confirmed for this site.'
        : 'Estimated location. Confirm the pin before relying on nearby results.';
    moveLocation.textContent = workspaceState.moving
      ? 'Click the map to place site pin'
      : 'Move location on map';
    locationState.setAttribute(
      'data-moving',
      String(Boolean(workspaceState.moving)),
    );
  }

  function setNotice(text) {
    notice.textContent = text == null ? '' : String(text);
    notice.hidden = !notice.textContent;
  }

  render({ state: DOSSIER_STATE.IDLE, ctx: null, sections: [] });

  return {
    root,
    searchSlot,
    imagerySlot,
    workspaceSlot,
    analysisSlot,
    render,
    setCollapsed,
    setCandidates,
    setLayerOptions,
    setMapControls,
    setCrimeCategories,
    setNotice,
    setWorkspaceState,
    setResearchProgress(state = null) {
      if (state?.providerAvailable === false) {
        researchProgress.hidden = true;
        researchProgress.textContent = '';
        return;
      }
      const results = Array.isArray(state?.layers)
        ? state.layers
        : Array.isArray(state?.results)
          ? state.results
          : [];
      const roleName = activeRole === 'developer' ? 'Developer' : 'Investor';
      const selectionByRole = state?.preferences?.selectedByRole;
      const roleSelection =
        selectionByRole?.[activeRole] || selectionByRole?.[roleName];
      const selected = Array.isArray(roleSelection)
        ? roleSelection
        : Array.isArray(state?.selectedIds)
          ? state.selectedIds
          : results.map((item) => item.id).filter(Boolean);
      const relevant = results.filter(
        (item) => !item.id || selected.includes(item.id),
      );
      if (!state || (!selected.length && !relevant.length)) {
        researchProgress.hidden = true;
        researchProgress.textContent = '';
        return;
      }
      const ready = relevant.filter((item) => item.status === 'ready').length;
      const partial = relevant.filter(
        (item) => item.status === 'partial',
      ).length;
      const active = relevant.filter(
        (item) => item.status === 'queued' || item.status === 'researching',
      ).length;
      const failed = relevant.filter((item) => item.status === 'failed').length;
      const total = selected.length || relevant.length;
      const status = `${ready} of ${total} ready${active ? ` · ${active} researching` : ''}${partial ? ` · ${partial} partial` : ''}${failed ? ` · ${failed} failed` : ''}`;
      researchProgress.textContent = `Address research · ${status}`;
      researchProgress.hidden = false;
      researchProgress.setAttribute(
        'aria-label',
        `Open address research. ${status} selected layers.`,
      );
    },
    setRole(role) {
      if (role !== 'investor' && role !== 'developer') return;
      setView(role, false);
    },
    getRole: () => activeRole,
    getActiveView: () => activeView,
    destroy() {
      for (const remove of listeners.splice(0)) remove();
      root.remove?.();
    },
  };
}
