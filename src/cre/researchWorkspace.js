// Local Analysis workspace state. Network/provider work is supplied separately
// by the application integrator; this module never sends site data itself.
import { mountResearchTab } from './researchView.js';
import { RESEARCH_LAYER_DEFINITIONS } from './researchLayers.js';
import { safeSourceUrl } from './sourceUrls.js';

const LAYER_IDS = new Set(RESEARCH_LAYER_DEFINITIONS.map(({ id }) => id));
const STORAGE_KEY = 'gods-eye-cre-research-v1';
const MAX_SNAPSHOT_CHARS = 100_000;
const PRESETS = Object.freeze({
  Investor: ['crime', 'walking', 'retail', 'market'],
  Developer: ['crime', 'walking', 'retail', 'zoning', 'pipeline', 'utilities'],
});

function cleanString(value, limit = 500) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

/** Stable site identity; radius and jurisdiction are part of the research scope. */
export function researchContextKey(ctx) {
  if (!ctx || !Number.isFinite(ctx.lat) || !Number.isFinite(ctx.lon)) return '';
  return JSON.stringify({
    address: cleanString(ctx.address || ctx.matchedAddress, 240)
      .toLowerCase()
      .replace(/\s+/g, ' '),
    lat: Number(ctx.lat.toFixed(5)),
    lon: Number(ctx.lon.toFixed(5)),
    jurisdiction: cleanString(
      ctx.jurisdiction || ctx.county || ctx.state,
      160,
    ).toLowerCase(),
    radiusMiles: [1, 3, 5].includes(ctx.radiusMiles) ? ctx.radiusMiles : 1,
  });
}

function cleanEvidence(entry) {
  if (!entry || typeof entry !== 'object') return null;
  let sourceUrl;
  try {
    const url = new URL(safeSourceUrl(entry.sourceUrl || entry.url));
    if (url.protocol !== 'https:') return null;
    sourceUrl = url.href.slice(0, 1000);
  } catch {
    return null;
  }
  return {
    claim: cleanString(entry.claim, 500),
    sourceUrl,
    title: cleanString(entry.title, 180),
    geography: cleanString(entry.geography, 180),
    coveredPeriod: cleanString(entry.coveredPeriod, 120),
    limitations: cleanString(entry.limitations, 300),
  };
}

function cleanLayer(layer) {
  if (!layer || !LAYER_IDS.has(layer.id)) return null;
  const allowedStatus = new Set([
    'queued',
    'researching',
    'ready',
    'partial',
    'failed',
    'skipped',
  ]);
  const sources = Array.isArray(layer.sources)
    ? layer.sources.slice(0, 12).flatMap((source) => {
        if (!source || typeof source !== 'object') return [];
        try {
          const url = new URL(safeSourceUrl(source.url));
          return url.protocol === 'https:'
            ? [
                {
                  url: url.href.slice(0, 1000),
                  title: cleanString(source.title, 180),
                },
              ]
            : [];
        } catch {
          return [];
        }
      })
    : [];
  const evidence = Array.isArray(layer.evidence)
    ? layer.evidence.slice(0, 8).map(cleanEvidence).filter(Boolean)
    : [];
  return {
    id: layer.id,
    label: RESEARCH_LAYER_DEFINITIONS.find((item) => item.id === layer.id)
      .label,
    status: allowedStatus.has(layer.status) ? layer.status : 'skipped',
    summary: cleanString(layer.summary, 1200),
    evidence,
    sources,
    message: cleanString(layer.message, 400) || null,
    retrievedAt: cleanString(layer.retrievedAt, 40) || null,
    usage:
      layer.usage && typeof layer.usage === 'object'
        ? {
            inputTokens: Number.isFinite(layer.usage.inputTokens)
              ? Math.max(0, Math.floor(layer.usage.inputTokens))
              : null,
            outputTokens: Number.isFinite(layer.usage.outputTokens)
              ? Math.max(0, Math.floor(layer.usage.outputTokens))
              : null,
          }
        : null,
  };
}

function readStored(storage) {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw || raw.length > MAX_SNAPSHOT_CHARS * 2) return {};
    const value = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value
      : {};
  } catch {
    return {};
  }
}

function saveStored(storage, value) {
  try {
    const serialized = JSON.stringify(value);
    if (serialized.length <= MAX_SNAPSHOT_CHARS)
      storage?.setItem(STORAGE_KEY, serialized);
    else
      storage?.setItem(
        STORAGE_KEY,
        JSON.stringify({
          preferences: value.preferences,
          role: value.role,
          snapshot: null,
        }),
      );
  } catch {
    /* Storage is optional. */
  }
}

/**
 * Create local research preferences and snapshot state. An injected provider
 * is intended for the separately reviewed application adapter and tests; no
 * provider is configured by default, so this module performs no network IO.
 */
export function createResearchWorkspace({
  documentRef = globalThis.document,
  storage = globalThis.localStorage,
  onChange,
  provider,
  now = () => new Date(),
} = {}) {
  const persisted = readStored(storage);
  let context = null;
  let contextKey = '';
  let generation = 0;
  let destroyed = false;
  let active = false;
  let selected = new Set(
    Array.isArray(persisted.preferences?.selected)
      ? persisted.preferences.selected.filter((id) => LAYER_IDS.has(id))
      : PRESETS.Investor,
  );
  const roleSelections = {
    investor: Array.isArray(persisted.roleSelections?.investor)
      ? new Set(
          persisted.roleSelections.investor.filter((id) => LAYER_IDS.has(id)),
        )
      : null,
    developer: Array.isArray(persisted.roleSelections?.developer)
      ? new Set(
          persisted.roleSelections.developer.filter((id) => LAYER_IDS.has(id)),
        )
      : null,
  };
  let preferences = {
    autoRun: persisted.preferences?.autoRun === true,
    budgetPerAddress: Math.max(
      1,
      Math.min(3, Number(persisted.preferences?.budgetPerAddress) || 3),
    ),
  };
  let role =
    String(persisted.role || '').toLowerCase() === 'developer'
      ? 'developer'
      : 'investor';
  let status = 'idle';
  let updatedAt = null;
  let layers = new Map();
  let addressCalls = 0;
  const subscribers = new Set();

  const emit = (type = 'state') => {
    if (destroyed) return;
    const snapshot = getSnapshot();
    if (typeof onChange === 'function')
      onChange(
        snapshot
          ? {
              ...snapshot,
              selectedIds: [...selected],
              results: snapshot.layers,
            }
          : { status, selectedIds: [...selected], results: [] },
        { type },
      );
    for (const subscriber of subscribers) subscriber(snapshot, { type });
  };
  const persist = () =>
    saveStored(storage, {
      preferences: { ...preferences, selected: [...selected] },
      role,
      roleSelections: Object.fromEntries(
        Object.entries(roleSelections).map(([key, set]) => [
          key,
          set ? [...set] : null,
        ]),
      ),
      snapshot: getSnapshot(),
    });
  const getSnapshot = () => {
    if (!context || !contextKey) return null;
    return {
      version: 1,
      contextKey,
      site: {
        address: cleanString(context.address || context.matchedAddress, 240),
        lat: context.lat,
        lon: context.lon,
        jurisdiction: cleanString(
          context.jurisdiction || context.county || context.state,
          160,
        ),
        radiusMiles: [1, 3, 5].includes(context.radiusMiles)
          ? context.radiusMiles
          : 1,
      },
      role,
      preferences: {
        autoRun: preferences.autoRun,
        selectedByRole: {
          investor: [...(roleSelections.investor || new Set(PRESETS.Investor))],
          developer: [
            ...(roleSelections.developer || new Set(PRESETS.Developer)),
          ],
        },
        budgetPerAddress: preferences.budgetPerAddress,
      },
      status,
      updatedAt,
      usage: {
        calls: addressCalls,
        inputTokens: [...layers.values()].some((layer) =>
          Number.isFinite(layer.usage?.inputTokens),
        )
          ? [...layers.values()].reduce(
              (total, layer) =>
                total +
                (Number.isFinite(layer.usage?.inputTokens)
                  ? layer.usage.inputTokens
                  : 0),
              0,
            )
          : null,
        outputTokens: [...layers.values()].some((layer) =>
          Number.isFinite(layer.usage?.outputTokens),
        )
          ? [...layers.values()].reduce(
              (total, layer) =>
                total +
                (Number.isFinite(layer.usage?.outputTokens)
                  ? layer.usage.outputTokens
                  : 0),
              0,
            )
          : null,
      },
      layers: [...layers.values()].map(cleanLayer).filter(Boolean),
    };
  };

  const restore = (snapshot, ctx = context) => {
    generation += 1;
    active = false;
    if (!ctx || !Number.isFinite(ctx.lat) || !Number.isFinite(ctx.lon))
      return false;
    const key = researchContextKey(ctx);
    if (!key) return false;
    context = { ...ctx };
    contextKey = key;
    if (
      !snapshot ||
      snapshot.version !== 1 ||
      snapshot.contextKey !== key ||
      !Array.isArray(snapshot.layers)
    ) {
      layers = new Map();
      status = 'idle';
      updatedAt = null;
      addressCalls = 0;
      emit('restore-empty');
      return true;
    }
    const next = new Map(
      snapshot.layers
        .map(cleanLayer)
        .filter(Boolean)
        .map((layer) => [layer.id, layer]),
    );
    layers = next;
    status = ['queued', 'researching'].includes(snapshot.status)
      ? 'partial'
      : snapshot.status || 'idle';
    updatedAt = cleanString(snapshot.updatedAt, 40) || null;
    addressCalls = Number.isFinite(snapshot.usage?.calls)
      ? Math.max(0, Math.floor(snapshot.usage.calls))
      : 0;
    role =
      String(snapshot.role || '').toLowerCase() === 'developer'
        ? 'developer'
        : 'investor';
    // Restoring is read-only: it never starts or overwrites provider work.
    emit('restore');
    return true;
  };

  const runSelected = async (ids = [...selected]) => {
    if (destroyed || active || !context || context.locationConfirmed !== true)
      return false;
    const remaining = Math.max(0, preferences.budgetPerAddress - addressCalls);
    const allowed = [...new Set(ids)]
      .filter((id) => {
        const prior = layers.get(id);
        return (
          LAYER_IDS.has(id) &&
          selected.has(id) &&
          !['ready', 'queued', 'researching'].includes(prior?.status)
        );
      })
      .slice(0, remaining);
    if (!allowed.length) return false;
    if (typeof provider !== 'function') {
      for (const id of allowed)
        layers.set(id, {
          id,
          status: 'skipped',
          summary: '',
          evidence: [],
          sources: [],
          message:
            'Optional source-discovery service is not connected in this build. No site information was sent. Existing dossier data remains available.',
          retrievedAt: now().toISOString(),
          usage: null,
        });
      status = 'partial';
      updatedAt = now().toISOString();
      persist();
      emit('unavailable');
      return false;
    }
    active = true;
    const runGeneration = generation;
    status = 'researching';
    for (const id of allowed)
      layers.set(id, {
        id,
        status: 'queued',
        summary: '',
        evidence: [],
        sources: [],
        message: null,
        retrievedAt: null,
        usage: null,
      });
    persist();
    emit('run-start');
    for (const id of allowed) {
      if (destroyed || runGeneration !== generation) break;
      layers.set(id, { ...layers.get(id), status: 'researching' });
      emit('layer-start');
      try {
        addressCalls += 1;
        persist();
        const result = await provider({
          context: { ...context },
          layer: id,
          signalGeneration: runGeneration,
        });
        if (
          destroyed ||
          runGeneration !== generation ||
          researchContextKey(context) !== contextKey
        )
          break;
        const clean = cleanLayer({
          ...result,
          id,
          retrievedAt: now().toISOString(),
        });
        layers.set(
          id,
          clean || {
            id,
            status: 'failed',
            summary: '',
            evidence: [],
            sources: [],
            message: 'Provider returned an invalid result.',
            retrievedAt: now().toISOString(),
            usage: null,
          },
        );
      } catch {
        if (destroyed || runGeneration !== generation) break;
        layers.set(id, {
          id,
          status: 'failed',
          summary: '',
          evidence: [],
          sources: [],
          message: 'Research did not complete. Retry this layer.',
          retrievedAt: now().toISOString(),
          usage: null,
        });
      }
      persist();
      emit('layer-complete');
    }
    if (runGeneration === generation) {
      active = false;
      status = [...layers.values()].some(
        (layer) =>
          layer.status === 'failed' ||
          layer.status === 'partial' ||
          layer.status === 'skipped',
      )
        ? 'partial'
        : 'ready';
      updatedAt = now().toISOString();
      persist();
      emit('run-complete');
    }
    return true;
  };

  const api = {
    get root() {
      return viewRoot;
    },
    setContext(ctx, { autoRun = true, snapshot } = {}) {
      if (!ctx || !Number.isFinite(ctx.lat) || !Number.isFinite(ctx.lon)) {
        generation += 1;
        active = false;
        context = null;
        contextKey = '';
        layers.clear();
        status = 'idle';
        updatedAt = null;
        addressCalls = 0;
        emit('context-clear');
        return false;
      }
      const key = researchContextKey(ctx);
      if (key === contextKey) {
        const wasConfirmed = context?.locationConfirmed === true;
        context = { ...ctx };
        if (
          !wasConfirmed &&
          ctx.locationConfirmed === true &&
          autoRun &&
          preferences.autoRun &&
          layers.size === 0
        )
          void runSelected();
        return true;
      }
      generation += 1;
      active = false;
      context = { ...ctx };
      contextKey = key;
      layers = new Map();
      status = 'idle';
      updatedAt = null;
      addressCalls = 0;
      if (snapshot) return restore(snapshot, ctx);
      const stored = readStored(storage).snapshot;
      if (stored && stored.contextKey === key) return restore(stored, ctx);
      persist();
      emit('context');
      if (autoRun && preferences.autoRun && ctx.locationConfirmed === true)
        void runSelected();
      return true;
    },
    getSnapshot,
    restore,
    setRole(value) {
      const next =
        String(value || '').toLowerCase() === 'developer'
          ? 'developer'
          : 'investor';
      if (next === role) return role;
      roleSelections[role] = new Set(selected);
      role = next;
      // Role presets only alter the saved checkbox set; they never start work.
      selected = new Set(
        roleSelections[next] ||
          PRESETS[next === 'developer' ? 'Developer' : 'Investor'],
      );
      roleSelections[next] = new Set(selected);
      persist();
      emit('role');
      return role;
    },
    getRole: () => role,
    setSelected(ids) {
      selected = new Set(
        Array.isArray(ids)
          ? ids.filter((id) => LAYER_IDS.has(id)).slice(0, 7)
          : [],
      );
      roleSelections[role] = new Set(selected);
      persist();
      emit('selection');
      return [...selected];
    },
    getSelected: () => [...selected],
    setPreferences(next = {}) {
      preferences = {
        autoRun:
          next.autoRun === undefined
            ? preferences.autoRun
            : next.autoRun === true,
        budgetPerAddress:
          next.budgetPerAddress === undefined
            ? preferences.budgetPerAddress
            : Math.max(1, Math.min(3, Number(next.budgetPerAddress) || 3)),
      };
      if (Array.isArray(next.selected)) api.setSelected(next.selected);
      persist();
      emit('preferences');
      return { ...preferences, selected: [...selected] };
    },
    getPreferences: () => ({ ...preferences, selected: [...selected] }),
    hasProvider: () => typeof provider === 'function',
    canRun: () =>
      Boolean(context?.locationConfirmed === true && !active && !destroyed),
    subscribe(listener) {
      if (typeof listener !== 'function') return () => {};
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },
    runSelected,
    retryLayer: (id) => {
      if (!LAYER_IDS.has(id)) return Promise.resolve(false);
      selected.add(id);
      roleSelections[role] = new Set(selected);
      persist();
      emit('selection');
      return runSelected([id]);
    },
    cancel() {
      if (!active) return false;
      generation += 1;
      active = false;
      status = 'partial';
      for (const [id, layer] of layers)
        if (layer.status === 'queued' || layer.status === 'researching')
          layers.set(id, {
            ...layer,
            status: 'skipped',
            message: 'Canceled before completion.',
          });
      persist();
      emit('cancel');
      return true;
    },
    destroy() {
      generation += 1;
      active = false;
      destroyed = true;
      subscribers.clear();
      unmountView?.();
      viewRoot?.remove?.();
    },
  };

  let viewRoot = null;
  let unmountView = null;
  if (documentRef?.createElement)
    viewRoot = documentRef.createElement('section');
  if (viewRoot)
    unmountView = mountResearchTab({
      container: viewRoot,
      controller: api,
      documentRef,
    });
  if (persisted.snapshot) restore(persisted.snapshot, context);
  return api;
}
