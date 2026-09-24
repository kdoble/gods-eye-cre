// CRE dossier defaults (ring radii, drive time, address placeholder) in one place so sections, overlays and the harness agree on the same numbers.

export const METERS_PER_MILE = 1609.344;

/** Ring radii in miles, smallest first. */
export const RING_MILES = Object.freeze([1, 3, 5]);

/** Ring radii in meters, keyed the way SectionContext.rings is keyed. */
export const RINGS_M = Object.freeze({
  oneMi: 1 * METERS_PER_MILE,
  threeMi: 3 * METERS_PER_MILE,
  fiveMi: 5 * METERS_PER_MILE,
});

/** Drive-time isochrone length in minutes. */
export const DRIVE_TIME_MINUTES = 15;

/** Placeholder text for the address box in CRE mode (SPEC 4.1). */
export const ADDRESS_PLACEHOLDER = 'Enter a property address';

const DAY_MS = 86_400_000;

/**
 * How old a section's data may be before the panel says so, in milliseconds.
 * Each entry is the longest server cache TTL behind that section, so a stamp
 * past it means the value was served from cache after the source failed. The
 * retrieved-at line is the dossier's only freshness control and it used to
 * carry the request time, not the fetch time (B-S2-2).
 */
export const SECTION_MAX_AGE_MS = Object.freeze({
  location: 30 * DAY_MS,
  hazards: 30 * DAY_MS,
  incentives: 7 * DAY_MS,
  demographics: 30 * DAY_MS,
  jobs: 90 * DAY_MS,
  rents: 90 * DAY_MS,
  supply: 90 * DAY_MS,
  schools: 30 * DAY_MS,
  amenities: 7 * DAY_MS,
  access: 7 * DAY_MS,
  imagery: 30 * DAY_MS,
  cameras: 7 * DAY_MS,
});

/** Fallback ceiling for a section with no entry above. */
export const DEFAULT_MAX_AGE_MS = 30 * DAY_MS;
