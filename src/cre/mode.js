// CRE mode boot policy: decides cre vs gev from ?mode= and a stored preference, then hides (never deletes) the spy chrome and layers and promotes the address box.
import { ADDRESS_PLACEHOLDER } from './config.js';

export const CRE_MODE = 'cre';
export const GEV_MODE = 'gev';
export const MODE_STORAGE_KEY = 'gev.cre.mode';
export const MODE_ATTR = 'data-cre-mode';

/**
 * Inherited layers turned off and removed from the Layers panel in CRE mode (SPEC 4.1).
 * They stay registered, so ?mode=gev and share links still reach them.
 */
export const CRE_HIDDEN_LAYER_IDS = Object.freeze([
  'flights',
  'military',
  'satellites',
  'rocket-launches',
  'ais-live-vessels',
  'military-installations',
  'military-awareness',
  'alpr-cameras',
  'local-datacenters',
  'local-dams',
  'radio',
  'local-firms',
  'bikeshare',
]);

/**
 * Upstream chrome a real estate user does not need, hidden (never removed)
 * while html carries data-cre-mode="cre": the voice dock and location tray,
 * visual presets, the DATA LAYERS and SCENES rails, the DISPLAY, CCTV and
 * CONTEXT rail, the top icon row, sync chips, radio, and the POWER UP pill
 * (the dossier's "Keys and settings" link opens the same dialog).
 */
export const CRE_HIDDEN_CHROME = Object.freeze([
  '#command-dock',
  '#gev-voice-control',
  '#control-panel',
  '#data-panel',
  '#scene-panel',
  '#right-context-rail',
  '#top-center-actions',
  '#key-setup-chip',
  '#traffic-sync-chip',
  '#cctv-sync-chip',
  '#radio-panel',
  '#context-radio-dock',
  '#style-indicator',
]);

export const CHROME_STYLE_ID = 'cre-chrome-hide';

/** CSS that hides CRE_HIDDEN_CHROME, scoped to CRE mode only. */
export function chromeHideCss(selectors = CRE_HIDDEN_CHROME) {
  const scoped = selectors
    .map((sel) => `html[${MODE_ATTR}='${CRE_MODE}'] ${sel}`)
    .join(',\n');
  return `${scoped} {\n  display: none !important;\n}\n`;
}

/**
 * Add the chrome-hiding style element. Returns a remove.
 * @param {Document} doc
 */
export function installChromeStyle(doc) {
  const host = doc.head || doc.body;
  if (!host) return () => {};
  const style = doc.createElement('style');
  style.id = CHROME_STYLE_ID;
  style.textContent = chromeHideCss();
  host.append(style);
  return () => style.remove();
}

/**
 * cre unless ?mode=gev, or no ?mode and a stored 'gev' preference.
 * @param {{search?: string, storage?: {getItem: Function}|null}} [input]
 * @returns {'cre'|'gev'}
 */
export function resolveMode({ search = '', storage = null } = {}) {
  const param = new URLSearchParams(search).get('mode');
  if (param === GEV_MODE) return GEV_MODE;
  if (param === CRE_MODE) return CRE_MODE;
  try {
    if (storage?.getItem(MODE_STORAGE_KEY) === GEV_MODE) return GEV_MODE;
  } catch {
    /* Blocked storage means the default. */
  }
  return CRE_MODE;
}

/**
 * Hide the CRE layer set: showInTogglePanel false and disabled. Returns a
 * function that puts the panel flags back (layers stay off).
 * @param {object} dataManager Has `layers` Map of { module }, isEnabled, setEnabled.
 * @param {ReadonlyArray<string>} [ids]
 */
export function hideLayers(dataManager, ids = CRE_HIDDEN_LAYER_IDS) {
  const previous = new Map();
  for (const id of ids) {
    const entry = dataManager?.layers?.get?.(id);
    if (!entry?.module) continue;
    if (!previous.has(id)) previous.set(id, entry.module.showInTogglePanel);
    entry.module.showInTogglePanel = false;
    if (dataManager.isEnabled?.(id)) {
      Promise.resolve(
        dataManager.setEnabled(id, false, { origin: 'programmatic' }),
      ).catch((error) => console.warn(`[cre] could not disable ${id}:`, error));
    }
  }
  return () => {
    for (const [id, value] of previous) {
      const module = dataManager.layers.get(id)?.module;
      if (!module) continue;
      if (value === undefined) delete module.showInTogglePanel;
      else module.showInTogglePanel = value;
    }
  };
}

/**
 * Turn the spy HUD and scope off through the visual settings owner, so the
 * DISPLAY controls stay in sync and can turn them back on.
 * @param {object} styleManager
 */
export function hideSpyVisuals(styleManager) {
  if (typeof styleManager?.applyVisualState === 'function') {
    void Promise.resolve(
      styleManager.applyVisualState({
        hud: { visible: false },
        scope: { enabled: false },
      }),
    ).catch((error) => console.warn('[cre] visual state not applied:', error));
  } else {
    styleManager?.hud?.setMode?.('off');
  }
}

/**
 * Move the existing address input into `slot`, give it the CRE placeholder
 * and focus it. Its listeners travel with the node. Returns a restore.
 * @param {HTMLInputElement|null} input
 * @param {HTMLElement|null} slot
 */
export function promoteAddressBox(input, slot) {
  if (!input) return () => {};
  const parent = input.parentNode;
  const next = input.nextSibling;
  const placeholder = input.getAttribute('placeholder');
  const label = input.getAttribute('aria-label');
  input.setAttribute('placeholder', ADDRESS_PLACEHOLDER);
  input.setAttribute('aria-label', 'Property address');
  input.classList.add('expanded', 'cre-address-input');
  if (slot) slot.append(input);
  // The box keeps the last address (B1-08), so a click selects it all, like
  // a browser address bar: typing replaces it, a second click places the caret.
  let selectOnMouseUp = false;
  const onFocus = () => {
    selectOnMouseUp = true;
    input.select?.();
  };
  const onMouseUp = (event) => {
    if (!selectOnMouseUp) return;
    selectOnMouseUp = false;
    event.preventDefault?.();
    input.select?.();
  };
  input.addEventListener?.('focus', onFocus);
  input.addEventListener?.('mouseup', onMouseUp);
  try {
    input.focus({ preventScroll: true });
  } catch {
    input.focus?.();
  }
  return () => {
    input.removeEventListener?.('focus', onFocus);
    input.removeEventListener?.('mouseup', onMouseUp);
    input.classList.remove('cre-address-input');
    if (placeholder === null) input.removeAttribute('placeholder');
    else input.setAttribute('placeholder', placeholder);
    if (label === null) input.removeAttribute('aria-label');
    else input.setAttribute('aria-label', label);
    if (parent) parent.insertBefore(input, next);
  };
}

export const CRE_TITLE = 'GODS EYE';
export const CRE_TITLE_ACCENT = 'CRE';
export const CRE_SUBTITLE = 'SITE INTELLIGENCE FOR MULTIFAMILY';
export const CRE_DOC_TITLE = 'Gods Eye CRE: site dossier';

/**
 * Swap the header wording for the CRE brand (logo kept). The accent span
 * keeps its upstream class, so styling is unchanged. Returns a restore.
 * @param {Document} doc
 */
export function rebrandTitle(doc) {
  const bar = doc.getElementById?.('title-bar');
  const heading = bar?.querySelector?.('h1');
  const words = heading?.querySelector?.('.title-accent')?.parentNode;
  const subtitle = bar?.querySelector?.('.subtitle');
  const saved = {
    words: words ? [...words.childNodes] : null,
    subtitle: subtitle ? subtitle.textContent : null,
    title: doc.title,
  };
  if (words) {
    const accent = doc.createElement('span');
    accent.className = 'title-accent';
    accent.textContent = CRE_TITLE_ACCENT;
    words.replaceChildren(doc.createTextNode(`${CRE_TITLE} `), accent);
  }
  if (subtitle) subtitle.textContent = CRE_SUBTITLE;
  doc.title = CRE_DOC_TITLE;
  return () => {
    if (words && saved.words) words.replaceChildren(...saved.words);
    if (subtitle && saved.subtitle !== null)
      subtitle.textContent = saved.subtitle;
    doc.title = saved.title;
  };
}

/**
 * Apply CRE mode. Call only when resolveMode returned 'cre'.
 * @param {object} deps
 * @param {Document} deps.documentRef
 * @param {object} [deps.styleManager]
 * @param {object} [deps.dataManager]
 * @param {{mount: Function}} [deps.layerPresentation] Re-rendered so hidden rows drop out.
 * @param {HTMLElement} [deps.addressSlot] Where the address box moves to.
 * @returns {() => void} Teardown that restores what can be restored.
 */
export function applyCreMode({
  documentRef,
  styleManager,
  dataManager,
  layerPresentation,
  addressSlot = null,
}) {
  const doc = documentRef;
  doc.documentElement.setAttribute(MODE_ATTR, CRE_MODE);
  // The launcher reads its root by id; with the node gone it never shows.
  const launcher = doc.getElementById('first-run-launcher');
  if (launcher) {
    launcher.hidden = true;
    launcher.remove();
  }
  hideSpyVisuals(styleManager);
  const removeChromeStyle = installChromeStyle(doc);
  const restoreTitle = rebrandTitle(doc);

  const remount = () => {
    const container = doc.getElementById('data-toggles');
    if (container && layerPresentation?.mount)
      layerPresentation.mount(container);
  };
  const restoreLayers = hideLayers(dataManager);
  remount();

  const restoreAddress = promoteAddressBox(
    doc.getElementById('location-search'),
    addressSlot,
  );

  // Share-link and saved-state restoration run after boot and can switch the
  // HUD or a hidden layer back on; apply the policy once more after them.
  let disposed = false;
  void Promise.resolve(styleManager?.initialRestorePromise)
    .catch(() => {})
    .then(() => {
      if (disposed) return;
      hideSpyVisuals(styleManager);
      hideLayers(dataManager);
      remount();
    });

  return () => {
    disposed = true;
    removeChromeStyle();
    restoreTitle();
    restoreAddress();
    restoreLayers();
    remount();
    doc.documentElement.removeAttribute(MODE_ATTR);
  };
}

/**
 * The mode gate plus the policy: in gev mode it returns null and touches
 * nothing; in cre mode it applies the policy and returns its teardown.
 * @param {{search?: string, storage?: object|null} & Parameters<typeof applyCreMode>[0]} options
 * @returns {(() => void)|null}
 */
export function startCreMode({ search = '', storage = null, ...deps }) {
  if (resolveMode({ search, storage }) !== CRE_MODE) return null;
  return applyCreMode(deps);
}
