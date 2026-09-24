// Runs every registered dossier section in parallel for one place, isolates failures per section, and derives the panel state the DOM contract reports.
import { RINGS_M } from './config.js';
import { SECTION_STATUS, validateSectionResult } from './contract.js';

/** Panel-level states carried on data-dossier-state (SPEC 4.3). */
export const DOSSIER_STATE = Object.freeze({
  IDLE: 'idle',
  LOADING: 'loading',
  READY: 'ready',
  PARTIAL: 'partial',
  NO_MATCH: 'no-match',
  OUTSIDE_US: 'outside-us',
  CITY_MISMATCH: 'city-mismatch',
  ERROR: 'error',
});

/** A section that has not answered in this long is shown unavailable (B1-21). */
export const SECTION_TIMEOUT_MS = 30_000;

/** Section status while its load is in flight. Not a SectionResult status. */
export const SECTION_LOADING = 'loading';

export const NO_MATCH_MESSAGE =
  'No match for that address. Try adding the city and state.';
/** @param {string} where What the geocoder found outside the US. */
export const outsideUsMessage = (where) =>
  `US addresses only. The match (${where}) is outside the United States, so no US data was loaded.`;

/**
 * @param {string} typed What was typed.
 * @param {string} matchLabel Where the geocoder actually matched.
 * @param {number} milesOff Whole miles between the typed city and the match.
 */
export const cityMismatchMessage = (typed, matchLabel, milesOff) =>
  `No street match for ${typed}. Closest result: ${matchLabel}, ${milesOff} mile${milesOff === 1 ? '' : 's'} away.`;

/** S4/N-2: the city check disagreed with the match but could not be confirmed (Photon unreachable) -- fail closed, never build silently, but still offer the original match as an override rather than a dead end. */
export const cityUnresolvedMessage = (typed) =>
  `Could not confirm the city for ${typed} (the city-check service is unreachable). Use the matched pin anyway, or try another address.`;

/** @param {string} query */
export const searchingMessage = (query) =>
  `Looking up ${query ? `"${query}"` : 'the address'}...`;

export const LOOKUP_ERROR_MESSAGE =
  'Address lookup failed. Check the connection and try again.';

const STATE_ZIP =
  /,\s*([A-Z]{2})\s*,?\s*(\d{5})(?:-\d{4})?\s*(?:,\s*(?:USA|United States))?\s*$/i;

/**
 * Build the SectionContext for a geocoded place. Tract GEOID, county and the
 * matched address are optional (another package adds them to the geocoder).
 * @param {object} place
 * @param {number} place.lat
 * @param {number} place.lon
 * @param {string} [place.address]
 * @param {string} [place.matchedAddress]
 * @param {string} [place.label]
 * @param {string} [place.tractGeoid]
 * @param {string} [place.county]
 * @param {string} [place.state]
 * @param {string} [place.zip]
 * @returns {import('./contract.js').SectionContext}
 */
export function buildSectionContext(place) {
  const lat = Number(place?.lat);
  const lon = Number(place?.lon ?? place?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new RangeError('place needs a finite lat and lon');
  }
  const address = String(
    place.matchedAddress || place.address || place.label || '',
  ).trim();
  const parsed = STATE_ZIP.exec(address);
  /** @type {import('./contract.js').SectionContext} */
  const ctx = {
    lat,
    lon,
    address,
    rings: { ...RINGS_M },
    radiusMiles: [1, 3, 5].includes(place.radiusMiles) ? place.radiusMiles : 1,
    locationConfirmed: place.locationConfirmed === true,
  };
  if (place.pointOrigin) ctx.pointOrigin = String(place.pointOrigin);
  const tract = place.tractGeoid ? String(place.tractGeoid) : '';
  if (tract) ctx.tractGeoid = tract;
  if (place.county) ctx.county = String(place.county);
  const state = place.state || parsed?.[1];
  if (state) ctx.state = String(state).toUpperCase();
  const zip = place.zip || parsed?.[2];
  if (zip) ctx.zip = String(zip);
  if (place.approximate) ctx.approximate = String(place.approximate);
  if (Array.isArray(place.otherMatches) && place.otherMatches.length)
    ctx.otherMatches = place.otherMatches.map(String).slice(0, 3);
  return ctx;
}

/**
 * Turn a thrown load into an honest unavailable result. The message names the
 * section, never the upstream error text.
 * @param {{id:string, label:string}} section
 * @returns {import('./contract.js').SectionResult}
 */
export function unavailableResult(section, now = () => new Date()) {
  return {
    id: section.id,
    label: section.label,
    status: SECTION_STATUS.UNAVAILABLE,
    values: [],
    credit: { text: section.label, url: '', license: '' },
    sourceUrls: [],
    retrievedAt: now().toISOString(),
    message: `${section.label} did not answer. Try again in a minute.`,
  };
}

/**
 * Panel state from the per-section statuses.
 * @param {Array<string>} statuses
 */
export function derivePanelState(statuses) {
  if (statuses.length === 0) return DOSSIER_STATE.READY;
  if (statuses.includes(SECTION_LOADING)) return DOSSIER_STATE.LOADING;
  return statuses.some((status) =>
    [SECTION_STATUS.UNAVAILABLE, SECTION_STATUS.PARTIAL].includes(status),
  )
    ? DOSSIER_STATE.PARTIAL
    : DOSSIER_STATE.READY;
}

/**
 * @typedef {object} DossierSnapshot
 * @property {string} state
 * @property {import('./contract.js').SectionContext|null} ctx
 * @property {string} [message]
 * @property {Array<{id:string, label:string, order:number, status:string, result:import('./contract.js').SectionResult|null}>} sections
 */

/**
 * Create the dossier controller.
 * @param {object} options
 * @param {ReadonlyArray<import('./contract.js').SectionModule>} options.sections
 * @param {(snapshot:DossierSnapshot, change:{type:string, id?:string}) => void} [options.onChange]
 * @param {() => Date} [options.now]
 */
export function createDossierController({
  sections,
  onChange,
  now,
  fetchImpl = globalThis.fetch,
  timeoutMs = SECTION_TIMEOUT_MS,
} = {}) {
  const clock = typeof now === 'function' ? now : () => new Date();
  const ordered = [...(sections || [])].sort(
    (a, b) => (a.order ?? 0) - (b.order ?? 0),
  );
  let generation = 0;
  let abort = null;
  /** @type {DossierSnapshot} */
  let snapshot = { state: DOSSIER_STATE.IDLE, ctx: null, sections: [] };

  const emit = (change) => {
    try {
      onChange?.(snapshot, change);
    } catch (error) {
      console.error('[cre] dossier listener failed:', error);
    }
  };

  const settle = (runId, index, result, refresh = null) => {
    if (runId !== generation) return false;
    const entries = snapshot.sections.slice();
    entries[index] = {
      ...entries[index],
      status: result.status,
      result,
      refresh,
    };
    snapshot = {
      ...snapshot,
      sections: entries,
      state: derivePanelState(entries.map((entry) => entry.status)),
    };
    emit({ type: 'section', id: entries[index].id });
    return true;
  };

  const cancel = () => {
    generation += 1;
    abort?.abort();
    abort = null;
  };

  return {
    /** @returns {DossierSnapshot} */
    getSnapshot: () => snapshot,
    restore(saved) {
      cancel();
      snapshot = {
        state: 'partial',
        ctx: buildSectionContext({
          ...saved.site,
          radiusMiles: saved.radiusMiles,
        }),
        sections: saved.sections.map((result, index) => ({
          id: result.id,
          label: result.label,
          order: index,
          status: result.status,
          result,
        })),
        message: 'Saved snapshot. Refresh to request current source data.',
      };
      emit({ type: 'restore' });
    },

    /**
     * Start a run for a matched place. Resolves when every section settled or
     * the run was superseded.
     * @param {object} place Geocoded place, see buildSectionContext.
     */
    run(place, { refresh = false } = {}) {
      cancel();
      const runId = generation;
      const ctx = buildSectionContext(place);
      const previous =
        refresh &&
        snapshot.ctx &&
        snapshot.ctx.lat === ctx.lat &&
        snapshot.ctx.lon === ctx.lon &&
        snapshot.ctx.radiusMiles === ctx.radiusMiles
          ? new Map(snapshot.sections.map((entry) => [entry.id, entry.result]))
          : new Map();
      const controller = new AbortController();
      abort = controller;
      snapshot = {
        state: ordered.length ? DOSSIER_STATE.LOADING : DOSSIER_STATE.READY,
        ctx,
        sections: ordered.map((section) => ({
          id: section.id,
          label: section.label,
          order: section.order ?? 0,
          status: SECTION_LOADING,
          result: previous.get(section.id) || null,
          refresh: refresh
            ? { status: 'loading', startedAt: clock().toISOString() }
            : null,
        })),
        refreshing: refresh,
      };
      emit({ type: 'run' });
      const jobs = ordered.map(async (section, index) => {
        let result;
        let sectionFailed = false;
        let timer = null;
        const requests = [];
        const outcomes = [];
        const request = async (input, init) => {
          const raw = String(input);
          const isCre = raw.startsWith('/api/cre/');
          const url =
            refresh && isCre && !/[?&]refresh=/.test(raw)
              ? `${raw}${raw.includes('?') ? '&' : '?'}refresh=1`
              : input;
          const response = await fetchImpl(url, init);
          if (refresh && isCre && response.ok === false)
            outcomes.push({
              status: 'failed',
              attemptedAt: clock().toISOString(),
            });
          if (refresh && isCre && typeof response.clone === 'function') {
            const metadata = response
              .clone()
              .json()
              .then((body) => body?.refresh || null)
              .catch(() => null)
              .then((value) => {
                if (value) outcomes.push(value);
              });
            requests.push(metadata);
          }
          return response;
        };
        try {
          // A hung source must not hold the dossier at Loading forever: the
          // section gets its own deadline, and a load that ignores its signal
          // loses the race anyway.
          const deadline = new AbortController();
          const signal = AbortSignal.any([controller.signal, deadline.signal]);
          const expired = new Promise((_, reject) => {
            timer = setTimeout(() => {
              deadline.abort();
              reject(new Error('section timed out'));
            }, timeoutMs);
          });
          const raw = await Promise.race([
            (async () => {
              const value = await section.load(ctx, {
                signal,
                refresh,
                fetchImpl: request,
              });
              await Promise.allSettled(requests);
              return value;
            })(),
            expired,
          ]);
          result = validateSectionResult({
            ...raw,
            id: section.id,
            label: raw?.label || section.label,
          });
          if (refresh && result.status === SECTION_STATUS.UNAVAILABLE) {
            sectionFailed = true;
            if (previous.get(section.id)) result = previous.get(section.id);
          }
        } catch (error) {
          if (runId !== generation) return;
          sectionFailed = true;
          console.warn(`[cre] section ${section.id} failed:`, error);
          result =
            previous.get(section.id) || unavailableResult(section, clock);
        } finally {
          clearTimeout(timer);
        }
        const failed = outcomes.find((item) => item.status === 'failed');
        const throttled = outcomes.find((item) => item.status === 'throttled');
        const selected =
          failed ||
          throttled ||
          outcomes.find((item) => item.status === 'succeeded') ||
          outcomes[0];
        settle(
          runId,
          index,
          result,
          refresh
            ? {
                status: sectionFailed
                  ? 'failed'
                  : selected?.status === 'succeeded' &&
                      result.status === SECTION_STATUS.PARTIAL
                    ? 'partial'
                    : selected?.status || 'checked',
                attemptedAt: selected?.attemptedAt || clock().toISOString(),
                dataRetrievedAt:
                  selected?.dataRetrievedAt || result.retrievedAt,
                requestCount: outcomes.length,
              }
            : null,
        );
      });
      return Promise.all(jobs).then(() => {
        if (runId === generation && abort === controller) abort = null;
        if (runId === generation && snapshot.refreshing) {
          snapshot = { ...snapshot, refreshing: false };
          emit({ type: 'refresh-complete' });
        }
      });
    },

    /**
     * A new search started: abort the previous run's section loads and drop
     * its values at once, so nothing from the last address shows under the
     * next one while the lookup runs (B1-07).
     * @param {string} [query]
     */
    searching(query = '') {
      cancel();
      snapshot = {
        state: DOSSIER_STATE.LOADING,
        ctx: null,
        sections: [],
        message: searchingMessage(String(query)),
        query: String(query),
      };
      emit({ type: 'searching' });
    },

    /**
     * The geocoder matched a place outside the US. No US section runs: a
     * clean "QCT No" in Ukraine would be false assurance (B1-14).
     * @param {string} where
     */
    outsideUs(where = '') {
      cancel();
      snapshot = {
        state: DOSSIER_STATE.OUTSIDE_US,
        ctx: null,
        sections: [],
        message: outsideUsMessage(String(where) || 'that place'),
      };
      emit({ type: 'outside-us' });
    },

    /**
     * The geocoder matched a place, but it is far from the city/state typed
     * (or in a different state): a nonexistent "101 Main St, Marfa TX" must
     * not silently build a dossier 380 miles away in Georgetown, TX. No
     * section runs; the caller offers the typed city's center as a fallback.
     * @param {{typed:string, matchLabel:string, milesOff:number, cityCenter:object}} mismatch
     */
    cityMismatch({
      typed = '',
      matchLabel = '',
      milesOff = 0,
      cityCenter = null,
      unresolved = false,
      matchedPlace = null,
    } = {}) {
      cancel();
      snapshot = {
        state: DOSSIER_STATE.CITY_MISMATCH,
        ctx: null,
        sections: [],
        message: unresolved
          ? cityUnresolvedMessage(typed)
          : cityMismatchMessage(typed, matchLabel, milesOff),
        mismatch: {
          typed,
          matchLabel,
          milesOff,
          cityCenter,
          unresolved,
          matchedPlace,
        },
      };
      emit({ type: 'city-mismatch' });
    },

    /** Geocoder answered with no match. */
    noMatch(query = '') {
      cancel();
      snapshot = {
        state: DOSSIER_STATE.NO_MATCH,
        ctx: null,
        sections: [],
        message: NO_MATCH_MESSAGE,
        query: String(query),
      };
      emit({ type: 'no-match' });
    },

    /** Geocoder failed (network or server). */
    fail(message = LOOKUP_ERROR_MESSAGE) {
      cancel();
      snapshot = {
        state: DOSSIER_STATE.ERROR,
        ctx: null,
        sections: [],
        message,
      };
      emit({ type: 'error' });
    },

    /** Stop any run; late results are dropped. */
    destroy() {
      cancel();
    },
  };
}
