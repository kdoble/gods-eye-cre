// Splitting a tract GEOID list into query batches that fit the route's own GEOID ceiling, its county/state ceiling and a URL length every proxy carries, then merging the answers, so a dense metro asks several times instead of losing the section to an HTTP 400 (A-S2-1, A-S2-2).

/**
 * GEOIDs per batch. Eleven digits plus a comma is 12 characters, so 150 keeps
 * the query string near 1,850 characters: inside nginx's 8 KB
 * `large_client_header_buffers` and Apache's 8,190 byte `LimitRequestLine`,
 * which a single 800 GEOID request (9,600 characters) already risked and a
 * Brooklyn 5 mile list (over 20 KB) broke outright.
 */
export const MAX_GEOIDS_PER_BATCH = 150;
/** Ceiling on the query string a batch may build, characters. */
export const MAX_QUERY_CHARS = 2000;
/** Counties one ACS batch may span (server ACS_MAX_COUNTIES). */
export const MAX_COUNTIES_PER_BATCH = 40;
/** States one LODES batch may span (server LODES_MAX_STATES). */
export const MAX_STATES_PER_BATCH = 4;

const GEOID_CHARS = 12;

/**
 * Split GEOIDs into batches. Sorting first makes each batch county- and
 * state-contiguous, which both keeps the group counts low and lines the
 * batches up with the server's per-county ACS cache.
 * @param {string[]} geoids
 * @param {{maxPerBatch?:number, maxQueryChars?:number, groupOf?:(g:string)=>string, maxGroups?:number}} [options]
 * @returns {string[][]}
 */
export function chunkGeoids(geoids, options = {}) {
  const {
    maxPerBatch = MAX_GEOIDS_PER_BATCH,
    maxQueryChars = MAX_QUERY_CHARS,
    groupOf = (geoid) => geoid.slice(0, 5),
    maxGroups = MAX_COUNTIES_PER_BATCH,
  } = options;
  const unique = [
    ...new Set((geoids || []).filter(Boolean).map(String)),
  ].sort();
  const perBatch = Math.max(
    1,
    Math.min(maxPerBatch, Math.floor(maxQueryChars / GEOID_CHARS)),
  );
  /** @type {string[][]} */
  const batches = [];
  let batch = [];
  let groups = new Set();
  for (const geoid of unique) {
    const group = groupOf(geoid);
    const full =
      batch.length >= perBatch ||
      (!groups.has(group) && groups.size >= maxGroups);
    if (batch.length && full) {
      batches.push(batch);
      batch = [];
      groups = new Set();
    }
    batch.push(geoid);
    groups.add(group);
  }
  if (batch.length) batches.push(batch);
  return batches;
}

/**
 * Run one request per batch, keeping each batch's outcome.
 * @param {string[][]} batches
 * @param {(geoids:string[]) => Promise<object>} request
 */
async function runBatches(batches, request) {
  return Promise.all(
    batches.map((batch) =>
      request(batch).then(
        (value) => ({ ok: true, value, batch }),
        (error) => ({ ok: false, error, batch }),
      ),
    ),
  );
}

/** Oldest of a set of ISO timestamps, so a merged answer is never fresher than its stalest part. */
function oldestIso(stamps) {
  const times = stamps
    .filter(Boolean)
    .map((s) => ({ s, t: Date.parse(s) }))
    .filter((e) => Number.isFinite(e.t));
  if (!times.length) return null;
  return times.sort((a, b) => a.t - b.t)[0].s;
}

/**
 * ACS values for any number of tracts, in batches.
 *
 * Merges `data.tracts` across batches. A batch that fails does not sink the
 * section: its GEOIDs come back in `missing` so the caller can say which
 * tracts a figure leaves out rather than quietly summing fewer of them.
 * @param {string[]} geoids
 * @param {(path:string) => Promise<object>} get
 * @param {{signal?:AbortSignal}} [options]
 * @returns {Promise<{status:string, data:object|null, sourceUrls:string[], retrievedAt:string|null, missing:string[], batches:number, failedBatches:number, keyName?:string, message?:string}>}
 */
export async function fetchAcsBatches(geoids, get, { signal } = {}) {
  const batches = chunkGeoids(geoids);
  const results = await runBatches(batches, (batch) =>
    get(`/api/cre/census/acs?geoids=${batch.join(',')}`),
  );
  if (signal?.aborted) throw signal.reason ?? new Error('aborted');
  const failed = results.filter((r) => !r.ok);
  if (failed.length === results.length) throw failed[0].error;
  const needsKey = results.find(
    (r) => r.ok && r.value?.status === 'needs-key',
  )?.value;
  if (needsKey) {
    return {
      status: 'needs-key',
      data: null,
      sourceUrls: [],
      retrievedAt: needsKey.retrievedAt ?? null,
      missing: [],
      batches: batches.length,
      failedBatches: failed.length,
      keyName: needsKey.keyName,
      message: needsKey.message,
    };
  }
  const tracts = {};
  const sourceUrls = new Set();
  const stamps = [];
  let vintage = '';
  let priorVintage = '';
  let ready = false;
  let stale = false;
  for (const entry of results) {
    if (!entry.ok) continue;
    const body = entry.value;
    if (body?.status === 'ready') ready = true;
    for (const url of body?.sourceUrls || []) sourceUrls.add(url);
    if (body?.retrievedAt) stamps.push(body.retrievedAt);
    const data = body?.data;
    if (!data) continue;
    stale ||= data.stale === true;
    vintage ||= data.vintage || '';
    priorVintage ||= data.priorVintage || '';
    Object.assign(tracts, data.tracts || {});
  }
  const missing = [...new Set(geoids)].filter((geoid) => !tracts[geoid]?.cur);
  return {
    status: ready && Object.keys(tracts).length ? 'ready' : 'empty',
    data: { vintage, priorVintage, tracts, stale },
    sourceUrls: [...sourceUrls],
    retrievedAt: oldestIso(stamps),
    missing,
    batches: batches.length,
    failedBatches: failed.length,
  };
}

/**
 * LODES workplace jobs for any number of tracts, in batches.
 *
 * The route answers a real zero for a tract with no workplace blocks, so a
 * GEOID absent from the merged table was genuinely not fetched. Those land in
 * `missing`, which is what lets the jobs section call a sum a floor instead of
 * presenting it as a total (A-S2-2).
 * @param {string[]} geoids
 * @param {(path:string) => Promise<object>} get
 * @param {{signal?:AbortSignal}} [options]
 */
export async function fetchLodesBatches(geoids, get, { signal } = {}) {
  const batches = chunkGeoids(geoids, {
    groupOf: (geoid) => geoid.slice(0, 2),
    maxGroups: MAX_STATES_PER_BATCH,
  });
  const results = await runBatches(batches, (batch) =>
    get(`/api/cre/lodes/jobs?geoids=${batch.join(',')}`),
  );
  if (signal?.aborted) throw signal.reason ?? new Error('aborted');
  const failed = results.filter((r) => !r.ok);
  if (failed.length === results.length)
    throw failed[0]?.error ?? new Error('no batches');
  const tracts = {};
  const sectors = {};
  const sourceUrls = new Set();
  const stamps = [];
  let year = null;
  const vintages = new Set();
  let stale = false;
  for (const entry of results) {
    if (!entry.ok) continue;
    const body = entry.value;
    if (body?.status !== 'ready') continue;
    for (const url of body.sourceUrls || []) sourceUrls.add(url);
    if (body.retrievedAt) stamps.push(body.retrievedAt);
    const data = body.data || {};
    stale ||= data.stale === true;
    for (const vintage of data.vintages || [])
      if (Number.isFinite(vintage)) vintages.add(vintage);
    Object.assign(tracts, data.tracts || {});
    Object.assign(sectors, data.sectors || {});
    if (Number.isFinite(data.year)) {
      vintages.add(data.year);
      year = Math.min(year ?? data.year, data.year);
    }
  }
  const missing = [...new Set(geoids)].filter((geoid) => !tracts[geoid]);
  return {
    status: Object.keys(tracts).length ? 'ready' : 'empty',
    data: { year, vintages: [...vintages].sort(), sectors, tracts, stale },
    sourceUrls: [...sourceUrls],
    retrievedAt: oldestIso(stamps),
    missing,
    batches: batches.length,
    failedBatches: failed.length,
  };
}
