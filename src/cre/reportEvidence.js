import { researchContextKey } from './researchWorkspace.js';
// Saved AI evidence is untrusted input on restore, just like imported CSVs.
export function validResearchSnapshot(research, site) {
  if (research == null) return true;
  const text = (value, max = 16000) =>
    value == null || (typeof value === 'string' && value.length <= max);
  if (
    !research ||
    typeof research !== 'object' ||
    research.version !== 1 ||
    !Array.isArray(research.layers) ||
    research.layers.length > 12 ||
    !Number.isFinite(research.site?.lat) ||
    !Number.isFinite(research.site?.lon) ||
    research.site.lat !== site.lat ||
    research.site.lon !== site.lon ||
    research.contextKey !== researchContextKey(site) ||
    researchContextKey(research.site) !== researchContextKey(site) ||
    !text(research.contextKey, 1500) ||
    !text(research.site.address, 1000)
  )
    return false;
  return research.layers.every((layer) => {
    if (
      !layer ||
      !text(layer.id, 100) ||
      !text(layer.label, 300) ||
      !text(layer.summary) ||
      !text(layer.message) ||
      !text(layer.status, 100)
    )
      return false;
    if (
      layer.sources &&
      (!Array.isArray(layer.sources) ||
        layer.sources.length > 30 ||
        !layer.sources.every(
          (s) => s && text(s.url, 4000) && text(s.title, 1000),
        ))
    )
      return false;
    if (
      layer.evidence &&
      (!Array.isArray(layer.evidence) ||
        layer.evidence.length > 30 ||
        !layer.evidence.every(
          (e) =>
            e &&
            [
              'claim',
              'sourceUrl',
              'title',
              'geography',
              'coveredPeriod',
              'limitations',
            ].every((k) => text(e[k], 6000)),
        ))
    )
      return false;
    return true;
  });
}
