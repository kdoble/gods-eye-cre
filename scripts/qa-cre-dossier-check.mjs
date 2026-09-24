// Pure dossier checker: snapshots the DOM contract (panel state, section status, value cells with their row labels) and counts sections that are ready with at least one real value.
import {
  DOSSIER_ATTR,
  isPlaceholderValue,
  isRealReadySection,
} from '../src/cre/contract.js';

/** The 11 sections named by the current CRE count requirement. */
export const ELIGIBLE_SECTION_IDS = Object.freeze([
  'hazards',
  'incentives',
  'demographics',
  'rents',
  'supply',
  'jobs',
  'access',
  'schools',
  'amenities',
  'cameras',
  'location',
]);
const ELIGIBLE_SECTION_ID_SET = new Set(ELIGIBLE_SECTION_IDS);

/**
 * Read the dossier DOM into plain data. Self-contained on purpose: the
 * harness passes this function to page.evaluate, so it may use only its
 * arguments and standard DOM calls.
 *
 * Each section carries both `values` (cell text, the historic shape) and
 * `rows` ({label, text}). The label is read through the value cell's
 * ancestors rather than an attribute, so it is best effort: when the panel
 * markup changes the label comes back empty and the zero rule falls back to
 * the unit written in the cell text.
 * @param {{querySelector: Function, querySelectorAll: Function}} root
 * @param {{STATE:string, SECTION:string, STATUS:string, VALUE:string}} attrs
 * @returns {{state: string|null, sections: Array<{id:string, status:string|null, values:string[], rows:Array<{label:string, text:string}>}>}}
 */
export function snapshotDossierDom(root, attrs) {
  const panel = root.querySelector(`[${attrs.STATE}]`);
  const blocks = [...root.querySelectorAll(`[${attrs.SECTION}]`)];
  const labelOf = (cell) => {
    const row = cell.parentNode ? cell.parentNode.parentNode : null;
    const term = row && row.querySelector ? row.querySelector('dt') : null;
    return term ? String(term.textContent ?? '').trim() : '';
  };
  return {
    state: panel ? panel.getAttribute(attrs.STATE) : null,
    sections: blocks.map((block) => {
      const cells = [...block.querySelectorAll(`[${attrs.VALUE}]`)];
      const rows = cells.map((cell) => ({
        label: labelOf(cell),
        text: String(cell.textContent ?? ''),
      }));
      return {
        id: block.getAttribute(attrs.SECTION),
        status: block.getAttribute(attrs.STATUS),
        values: rows.map((row) => row.text),
        rows,
      };
    }),
  };
}

/**
 * Number of sections that are ready and hold at least one real value.
 * @param {{sections: Array<{status:string|null, values:string[]}>}} snapshot
 */
export function readyValueCount(snapshot) {
  return readyEligibleSectionIds(snapshot).length;
}

/**
 * Unique ready section identifiers with real values, excluding imagery.
 * Imagery is useful context but does not count toward CRE dossier coverage.
 * @param {{sections?: Array<{id?:string, status:string|null, values:string[], rows?:Array<{label?:string,text:string}>}>}} snapshot
 */
export function readyEligibleSectionIds(snapshot) {
  const ids = new Set();
  for (const section of snapshot?.sections || []) {
    if (ELIGIBLE_SECTION_ID_SET.has(section.id) && isRealReadySection(section)) {
      ids.add(section.id);
    }
  }
  return [...ids];
}

/** True when this section can contribute to the eight-section CRE target. */
export function isEligibleReadySection(section) {
  return Boolean(ELIGIBLE_SECTION_ID_SET.has(section?.id) && isRealReadySection(section));
}

/**
 * Pass or fail a snapshot.
 *
 * The negative branch demands more than the state string: a build that
 * reported no-match while still rendering ready sections would be lying to
 * the user, so any ready section with a real value fails it too.
 * @param {ReturnType<typeof snapshotDossierDom>} snapshot
 * @param {{minSections?: number, negative?: boolean}} [options]
 * @returns {{ok: boolean, ready: number, eligibleIds:string[], settled:boolean, reason: string}}
 */
export function judgeDossier(
  snapshot,
  { minSections = 8, negative = false } = {},
) {
  const ready = readyValueCount(snapshot);
  const eligibleIds = readyEligibleSectionIds(snapshot);
  const settled = snapshot?.state === 'ready' || snapshot?.state === 'partial';
  if (negative) {
    if (!['no-match','outside-us'].includes(snapshot?.state)) {
      return {
        ok: false,
        ready,
        eligibleIds,
        settled: snapshot?.state === 'no-match' || snapshot?.state === 'error',
        reason: `expected data-dossier-state="no-match" or "outside-us", found "${snapshot?.state}"`,
      };
    }
    if (ready > 0) {
      return {
        ok: false,
        ready,
        eligibleIds,
        settled: true,
        reason: `no-match but ${ready} sections still render real values`,
      };
    }
    return { ok: true, ready, eligibleIds, settled: true, reason: 'no-match as expected, no real values' };
  }
  const ok = ready >= minSections;
  return {
    ok,
    ready,
    eligibleIds,
    settled,
    reason: ok
      ? `${ready} unique eligible sections ready with real values (need ${minSections}); dossier ${settled ? 'settled' : 'still loading'}`
      : `state "${snapshot?.state}", ${ready} unique eligible sections ready with real values, need ${minSections}`,
  };
}

export { DOSSIER_ATTR, isPlaceholderValue, isRealReadySection };
