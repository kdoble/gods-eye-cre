import { SECTION_STATUS } from '../contract.js';
import { MAP_COLORS } from '../mapColors.js';
export const id = 'neighborhood';
export const label = 'Roads, crime coverage & local planning';
export const order = 13;
const SOURCE = 'https://www.openstreetmap.org/copyright';
const sourceList = (item) =>
  item?.sourceUrls || (item?.source ? [item.source] : []);
export async function load(ctx, { signal, fetchImpl = globalThis.fetch } = {}) {
  const base = {
    id,
    label,
    credit: {
      text: 'OpenStreetMap and local public authorities listed with each finding',
      url: SOURCE,
      license: 'See individual source terms',
    },
    sourceUrls: [SOURCE],
    retrievedAt: new Date().toISOString(),
  };
  const res = await fetchImpl(
    `/api/cre/neighborhood?lat=${ctx.lat}&lon=${ctx.lon}&radiusM=${Math.min(8047, Math.round((ctx.radiusMiles || 1) * 1609.344))}`,
    { signal },
  );
  if (!res.ok)
    return {
      ...base,
      status: SECTION_STATUS.UNAVAILABLE,
      values: [],
      message:
        'Local context sources did not answer. Do not infer no roads, no crime or no constraints.',
    };
  const body = await res.json(),
    data = body.data || {},
    values = [],
    overlays = [],
    notes = [];
  const styles = {
    roads: MAP_COLORS.roads,
    crime: MAP_COLORS.crime,
    parcel: MAP_COLORS.parcel,
    zoning: MAP_COLORS.zoning,
  };
  const sources = new Set();
  const jurisdiction = data.jurisdiction || null;
  // Coordinator item B: "Dallas/Atlanta city package" as a label showed for
  // EVERY address, including the vast majority outside both cities, and
  // leaked the internal pilot-program framing into the report. Outside
  // both cities (status 'uncovered', confirmed by the boundary polygon
  // check), the row is dropped entirely -- there is nothing to report.
  // Inside one, it reads as a plain, city-named "Extra local data" row.
  if (jurisdiction && jurisdiction.status !== 'uncovered') {
    notes.push(`jurisdiction: ${jurisdiction.message}`);
    for (const url of sourceList(jurisdiction)) sources.add(url);
    const cityName = String(jurisdiction.id || '').split('-')[0];
    const city = cityName ? cityName[0].toUpperCase() + cityName.slice(1) : '';
    values.push({
      label:
        jurisdiction.status === 'resolved'
          ? 'Extra local data'
          : 'Local jurisdiction check',
      value:
        jurisdiction.status === 'resolved'
          ? city
          : 'Could not confirm local jurisdiction',
      note: `${jurisdiction.message || ''}${jurisdiction.crossesBoundary ? ' Study area crosses the municipal boundary; local layers cover only the city portion.' : ''}`,
      status: jurisdiction.stale ? 'stale' : jurisdiction.status,
      partial:
        jurisdiction.status !== 'resolved' ||
        jurisdiction.crossesBoundary === true ||
        jurisdiction.stale === true,
      sourceUrls: sourceList(jurisdiction),
    });
  }
  for (const key of ['roads', 'crime', 'parcel']) {
    const item = data[key];
    if (!item) continue;
    notes.push(`${key}: ${item.message}`);
    for (const url of sourceList(item)) sources.add(url);
    if (item.status === 'ready' || item.status === 'partial') {
      if (key === 'parcel') {
        for (const f of item.parcelFeatures || item.features || []) {
          const p = f.properties || f.attributes || {};
          const fields =
            item.jurisdictionId === 'atlanta-ga'
              ? [
                  ['PIN', 'Atlanta parcel ID'],
                  ['SITEADDRESS', 'Parcel address'],
                  ['ZONING', 'Parcel zoning field (verify)'],
                ]
              : item.parcelFeatures
                ? [
                    ['ADDRESS', 'Johnson City parcel address'],
                    ['WATERSEWER', 'Mapped water/sewer status (verify)'],
                    ['WATER', 'Mapped water status (verify)'],
                    ['SEWER', 'Mapped sewer status (verify)'],
                    ['ELEC', 'Mapped electric status (verify)'],
                    ['GAS', 'Mapped gas status (verify)'],
                    ['TAXYR', 'Parcel tax year'],
                  ]
                : [
                    ['PIN', 'Atlanta parcel ID'],
                    ['SITEADDRESS', 'Parcel address'],
                    ['ZONING', 'Zoning (verify with city)'],
                  ];
          for (const [field, title] of fields) {
            if (p[field])
              values.push({
                label: title,
                value: String(p[field]),
                sourceUrls: item.parcelFeatures
                  ? [item.parcelSource || item.sourceUrls?.[0]].filter(Boolean)
                  : sourceList(item),
                status: item.stale ? 'stale' : item.parcelStatus || item.status,
                partial: item.parcelStatus === 'unavailable',
              });
          }
        }
        for (const f of item.zoningFeatures || []) {
          const p = f.properties || f.attributes || {};
          const zone =
            p.LONG_ZONE_DIST || p.ZONECLASS || p.ZONING || p.ZONE || p.LABEL;
          if (zone)
            values.push({
              label:
                item.jurisdictionId === 'dallas-tx'
                  ? 'Dallas mapped zoning district (verify)'
                  : item.jurisdictionId === 'atlanta-ga'
                    ? 'Atlanta mapped zoning district (verify)'
                    : 'Johnson City zoning district (verify)',
              value: String(zone),
              sourceUrls: [
                item.zoningSource ||
                  item.sourceUrls?.[1] ||
                  sourceList(item)[0],
              ].filter(Boolean),
              status: item.stale ? 'stale' : item.zoningStatus || 'ready',
              partial: item.zoningStatus === 'unavailable',
            });
        }
        if (item.parcelStatus === 'unsupported')
          values.push({
            label: 'Parcel coverage',
            value: 'No tested parcel feed for this city package',
            status: 'unsupported',
            partial: true,
            sourceUrls: sourceList(item),
          });
      } else if (
        key === 'crime' &&
        item.sourceStatus === 'connected-research-only'
      ) {
        values.push({
          label: `Dallas reported offense records (${ctx.radiusMiles || 1} mi, 90 days)`,
          value: item.totalRecords ?? item.features?.length ?? 0,
          note: item.message,
          status: item.stale ? 'stale' : item.status,
          partial: item.status === 'partial' || item.stale === true,
          sourceUrls: sourceList(item),
        });
        if (item.sourceMetadata?.recordDate)
          values.push({
            label: 'Latest mapped Dallas offense date in window',
            value: item.sourceMetadata.recordDate,
            note: 'Occurrence date from a returned row; this is not a completeness or reporting-lag guarantee.',
            status: item.stale ? 'stale' : item.status,
            partial: item.status === 'partial' || item.stale === true,
            sourceUrls: sourceList(item),
          });
        if (Number.isFinite(item.densityPerSqMi))
          values.push({
            label: 'Reported offense record density (90 days)',
            value: item.densityPerSqMi,
            unit: 'records/sq mi',
            note: 'Selected circle only. This is a count divided by area, not a population-adjusted crime rate or safety score.',
            status: item.stale ? 'stale' : item.status,
            partial: item.status === 'partial' || item.stale === true,
            sourceUrls: sourceList(item),
          });
        for (const category of (item.categories || []).slice(0, 5))
          values.push({
            label: `Dallas offense category: ${category.category}`,
            value: category.count,
            note: `${item.start} through ${item.end}; publisher category, preliminary and filtered.`,
            status: item.stale ? 'stale' : item.status,
            partial: item.status === 'partial' || item.stale === true,
            sourceUrls: sourceList(item),
          });
      } else if (
        key === 'crime' &&
        item.sourceStatus === 'published-not-connected'
      ) {
        values.push({
          label: 'Crime coverage',
          value: 'Official source published; incident feed not connected',
          note: `Verified ${item.verifiedOn || 'date unknown'}. ${item.message}`,
          status: item.sourceStatus,
          partial: true,
          sourceUrls: sourceList(item),
        });
      } else
        values.push({
          label:
            key === 'roads'
              ? 'Mapped major road segments (max 3 mi)'
              : `Chicago incident records (${ctx.radiusMiles || 1} mi, 90-day window)`,
          value: item.features?.length || 0,
          partial: item.status === 'partial',
          status: item.stale ? 'stale' : item.status,
          note: item.message,
          sourceUrls: sourceList(item),
        });
      if (item.features?.length)
        if (key === 'parcel' && item.parcelFeatures) {
          if (item.parcelFeatures.length)
            overlays.push({
              id: 'parcel',
              geojson: {
                type: 'FeatureCollection',
                features: item.parcelFeatures,
              },
              style: { stroke: styles.parcel },
            });
          if (item.zoningFeatures?.length)
            overlays.push({
              id: 'zoning',
              geojson: {
                type: 'FeatureCollection',
                features: item.zoningFeatures,
              },
              style: { stroke: styles.zoning },
            });
        } else
          overlays.push({
            id: key,
            geojson: { type: 'FeatureCollection', features: item.features },
            style: { stroke: styles[key] },
          });
    } else
      values.push({
        label: `${key === 'crime' ? 'Crime' : key === 'parcel' ? 'Parcel' : 'Road'} coverage`,
        value:
          key === 'crime' &&
          item.sourceStatus === 'connected-research-only' &&
          item.status === 'empty'
            ? 'No reported offense records matched this dated source window'
            : item.sourceStatus === 'published-not-connected'
              ? 'Official source published; incident feed not connected'
              : item.status === 'unsupported'
                ? 'Not supported in this locality'
                : item.status === 'empty'
                  ? 'No matching record in this source'
                  : 'Source unavailable',
        note: item.message,
        status:
          item.sourceStatus === 'published-not-connected'
            ? item.sourceStatus
            : item.status,
        partial: item.status === 'unavailable' || item.status === 'unsupported',
        sourceUrls: sourceList(item),
      });
  }
  return {
    ...base,
    retrievedAt: body.retrievedAt || base.retrievedAt,
    status: (() => {
      const statuses = Object.values(data)
        .map((item) => item?.status)
        .filter(Boolean);
      const hasObservation = statuses.some((status) =>
        ['ready', 'partial', 'empty'].includes(status),
      );
      if (!hasObservation) return SECTION_STATUS.UNAVAILABLE;
      if (
        statuses.some((status) =>
          ['partial', 'unavailable', 'unsupported'].includes(status),
        ) ||
        values.some((value) => value.status === 'stale')
      )
        return SECTION_STATUS.PARTIAL;
      if (statuses.every((status) => status === 'empty'))
        return SECTION_STATUS.EMPTY;
      return SECTION_STATUS.READY;
    })(),
    values,
    overlays,
    sourceUrls: [...sources],
    jurisdiction,
    evidence: {
      packageVersion: jurisdiction?.packageVersion || null,
      boundarySource: jurisdiction?.source || null,
      boundaryCheckedAt: jurisdiction?.boundaryCheckedAt || null,
      boundaryStale: jurisdiction?.stale === true,
      boundaryStaleAt: jurisdiction?.staleAt || null,
      crossesBoundary: jurisdiction?.crossesBoundary ?? null,
      crime: data.crime?.sourceMetadata || null,
      zoning: data.parcel?.sourceMetadata || null,
    },
    message: notes.join('\n'),
  };
}
