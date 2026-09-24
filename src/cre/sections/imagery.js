// Dossier section "imagery": how many distinct Esri Wayback imagery dates cover the site, the earliest and latest, and the source resolution, plus the mount hook that puts the time slider in the panel footer.
import { SECTION_STATUS } from '../contract.js';
import {
  WAYBACK_ATTRIBUTION,
  WAYBACK_CHANGES_ENDPOINT,
  WAYBACK_INFO_URL,
  displayDate,
  fetchWaybackChanges,
} from '../imagery/waybackProvider.js';

export const id = 'imagery';
export const label = 'Historical imagery';
export const order = 13;

export function streetViewLink(ctx) {
  if (!Number.isFinite(ctx?.lat) || !Number.isFinite(ctx?.lon)) return '';
  const point = encodeURIComponent(`${ctx.lat},${ctx.lon}`);
  return `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${point}`;
}

function withStreetView(result, ctx) {
  const url = streetViewLink(ctx);
  if (!url) return result;
  return {
    ...result,
    values: [
      ...result.values,
      {
        label: 'Street-level imagery',
        value: 'Open Google Street View',
        note: 'External historical panorama if available. Capture date unknown in this app; check the viewer.',
        externalUrl: url,
        sourceUrls: [url],
        captureDate: null,
      },
    ],
    sourceUrls: [...new Set([...result.sourceUrls, url])],
    streetViewUrl: url,
    streetViewCaptureDate: null,
  };
}

const CREDIT = Object.freeze({
  text: `Esri World Imagery Wayback: ${WAYBACK_ATTRIBUTION}`,
  url: WAYBACK_INFO_URL,
  license: 'Esri terms of use, display only with attribution',
});

/**
 * @param {import('../contract.js').SectionContext} ctx
 * @param {{signal?: AbortSignal, fetchImpl?: typeof fetch}} [opts]
 * @returns {Promise<import('../contract.js').SectionResult>}
 */
export async function load(ctx, { signal, fetchImpl } = {}) {
  const base = {
    id,
    label,
    credit: CREDIT,
    sourceUrls: [
      `${WAYBACK_CHANGES_ENDPOINT}?lat=${ctx.lat}&lon=${ctx.lon}`,
      WAYBACK_INFO_URL,
    ],
  };
  let changes;
  try {
    changes = await fetchWaybackChanges(ctx.lat, ctx.lon, {
      signal,
      fetchImpl,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    return withStreetView(
      {
        ...base,
        status: SECTION_STATUS.UNAVAILABLE,
        values: [],
        retrievedAt: new Date().toISOString(),
        message:
          'Esri World Imagery Wayback did not answer, so historical imagery dates are unavailable.',
      },
      ctx,
    );
  }
  return withStreetView(imageryResult(changes, base), ctx);
}

/**
 * Build the section result from a changes answer (newest first).
 * @param {import('../imagery/waybackProvider.js').WaybackChanges} changes
 */
export function imageryResult(changes, base = { id, label, credit: CREDIT }) {
  const releases = changes.releases;
  const out = {
    sourceUrls: [WAYBACK_INFO_URL],
    ...base,
    retrievedAt: changes.retrievedAt,
  };
  if (releases.length === 0) {
    return {
      ...out,
      status: SECTION_STATUS.EMPTY,
      values: [],
      message:
        'No Esri Wayback imagery release covers this site at zoom 17, so there is no imagery history to show.',
    };
  }
  const newest = releases[0];
  const oldest = releases[releases.length - 1];
  const values = [
    {
      label: 'Imagery updates at the site (releases that changed)',
      value: releases.length,
      note: `Wayback releases since 2014-02-20 where the site's zoom-17 imagery changed, out of ${changes.catalog?.count ?? 'all'} published`,
    },
    {
      label: 'Earliest imagery',
      value: displayDate(oldest),
      note: dateNote(oldest),
    },
    {
      label: 'Latest imagery',
      value: displayDate(newest),
      note: dateNote(newest),
    },
  ];
  if (Number.isFinite(newest.resolutionM)) {
    values.push({
      label: 'Source resolution (latest)',
      value: newest.resolutionM,
      unit: 'm',
      ...(newest.provider ? { note: newest.provider } : {}),
    });
  }
  if (changes.unknown?.length) {
    values.push({
      label: 'Releases not checked',
      value: changes.unknown.length,
      note: 'The tilemap did not answer for these releases; they are not counted as changes',
    });
  }
  return { ...out, status: SECTION_STATUS.READY, values };
}

function dateNote(change) {
  return change.captureDate
    ? `capture date; Wayback release ${change.releaseDate}`
    : 'Wayback release date (capture date not published)';
}

/**
 * Mount the time slider in the dossier panel footer for this site. Shares the
 * section's request, so it adds no extra network calls.
 * @param {{viewer:object, container:HTMLElement, lat:number, lon:number}} options
 */
export async function mountImagerySlider({ viewer, container, lat, lon }) {
  const { mountTimeSlider } = await import('../imagery/timeSlider.js');
  return mountTimeSlider({ viewer, container, lat, lon });
}
