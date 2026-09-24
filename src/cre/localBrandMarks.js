// Client-side resolver for the optional `local-brand-marks/` folder (see
// server/providers/cre/localBrandMarks.js and README.md's Local brand marks
// section). The public repo ships no retailer logo artwork; brandMarks.js's
// neutral labels stay the default everywhere. If the user has dropped their
// own file for a chain key into that gitignored folder, this module swaps the
// map badge and exported-report image for a URL pointing at the dev server's
// local file route -- never the raw file bytes inlined into the page.
import { brandMarkFor as neutralBrandMarkFor } from './brandMarks.js';

const MANIFEST_URL = '/api/cre/local-brand-marks/manifest';
const FILE_BASE_URL = '/api/cre/local-brand-marks/';

/** key -> filename, for chains the manifest reports a local file for. */
let overrideFilenames = {};

/**
 * Fetch which known chain keys currently have a user-supplied local file.
 * Safe to call repeatedly (e.g. on dossier open); a failed or missing
 * endpoint (production build, offline dev server) leaves prior state
 * untouched rather than clearing working overrides.
 * @param {{fetchImpl?: typeof fetch}} [options]
 * @returns {Promise<Record<string,string>>}
 */
export async function loadLocalBrandMarkOverrides({
  fetchImpl = globalThis.fetch,
} = {}) {
  try {
    const response = await fetchImpl(MANIFEST_URL);
    if (!response?.ok) return overrideFilenames;
    const payload = await response.json();
    if (payload && typeof payload.marks === 'object' && payload.marks) {
      overrideFilenames = { ...payload.marks };
    }
  } catch {
    // No dev-server local-brand-marks route (production build) or a
    // transient fetch failure. Neutral labels keep working either way.
  }
  return overrideFilenames;
}

/** Test-only: set the in-memory override map directly, bypassing fetch. */
export function setLocalBrandMarkOverridesForTest(next) {
  overrideFilenames = next && typeof next === 'object' ? { ...next } : {};
}

/**
 * The brand mark for a named place, preferring the user's own local file
 * (via the dev-server file route) over the bundled neutral label when one is
 * registered for that chain key.
 * @param {string} name
 * @returns {{key:string,name:string,initials:string,image:string,overrideUrl:string|null}|null}
 */
export function brandMarkFor(name) {
  const neutral = neutralBrandMarkFor(name);
  if (!neutral) return neutral;
  const filename = overrideFilenames[neutral.key];
  if (!filename) return { ...neutral, overrideUrl: null };
  const overrideUrl = `${FILE_BASE_URL}${filename}`;
  return { ...neutral, image: overrideUrl, overrideUrl };
}
