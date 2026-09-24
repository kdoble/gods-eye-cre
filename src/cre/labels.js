// Display wording helpers for the dossier: strips the Census legal/statistical area suffix (LSAD) from place names so "Johnson City city" reads "Johnson City".

/**
 * Census LSAD suffixes as they appear at the end of a TIGER place NAME. They
 * are lowercase in the source ("city", "town", "CDP"), which is what keeps a
 * name like "Carson City" or "Kansas City" intact. Longest first.
 */
const LSAD_SUFFIX =
  /\s+(?:city and borough|(?:metropolitan|metro|consolidated|unified) government \(balance\)|urban county|municipality|borough|village|town|city|CDP|\(balance\))$/;

/**
 * Place name for display, without the Census LSAD suffix. The raw name is
 * returned untouched when stripping would leave nothing.
 * @param {unknown} name
 * @returns {string}
 */
export function stripLsad(name) {
  const raw = typeof name === 'string' ? name.trim() : '';
  const stripped = raw.replace(LSAD_SUFFIX, '').trim();
  return stripped || raw;
}
