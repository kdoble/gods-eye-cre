import { SECTION_STATUS } from '../contract.js';

export const id = 'local-news';
export const label = 'Local news';
export const order = 17;
const CREDIT = Object.freeze({
  text: 'Google News RSS headlines; each link opens the publisher',
  url: 'https://news.google.com/',
  license: 'Headline metadata only; article and index terms apply',
});

export function localNewsValues(data) {
  return (Array.isArray(data?.records) ? data.records : [])
    .filter((item) => item?.title && item?.url && item?.publishedAt)
    .map((item) => ({
      label: `${item.topic || 'Local'} news · ${item.publisher || 'Publisher'} · ${item.publishedAt.slice(0, 10)}`,
      value: item.title,
      note:
        item.scope === 'property-headline-match'
          ? 'Selected street address appears in headline text; article and property connection not independently verified.'
          : 'City-level housing, retail, or road context; no property connection verified.',
      externalUrl: item.url,
      sourceUrls: [item.url],
      publishedAt: item.publishedAt,
      scope: item.scope,
    }));
}

export async function loadLocalNewsSection(
  ctx,
  { signal, refresh = false, fetchImpl = globalThis.fetch } = {},
) {
  const base = {
    id,
    label,
    credit: CREDIT,
    sourceUrls: [CREDIT.url],
    retrievedAt: new Date().toISOString(),
  };
  const params = new URLSearchParams({
    lat: String(ctx.lat),
    lon: String(ctx.lon),
  });
  if (ctx.address) params.set('address', String(ctx.address).slice(0, 160));
  if (refresh) params.set('refresh', '1');
  let body;
  try {
    const response = await fetchImpl(`/api/cre/local-news?${params}`, {
      signal,
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) throw new Error('NEWS_ROUTE');
    body = await response.json();
  } catch (error) {
    if (signal?.aborted) throw error;
    return {
      ...base,
      status: SECTION_STATUS.UNAVAILABLE,
      values: [],
      message: 'Local headline feeds did not answer.',
    };
  }
  const data = body?.data;
  if (!data || typeof data !== 'object')
    return {
      ...base,
      status: SECTION_STATUS.UNAVAILABLE,
      values: [],
      message: 'Local headline response was invalid.',
    };
  const values = localNewsValues(data);
  const status =
    data.status === 'partial'
      ? SECTION_STATUS.PARTIAL
      : data.status === 'ready'
        ? SECTION_STATUS.READY
        : data.status === 'empty'
          ? SECTION_STATUS.EMPTY
          : SECTION_STATUS.UNAVAILABLE;
  return {
    ...base,
    status,
    values,
    sourceUrls: [
      ...new Set([
        CREDIT.url,
        ...(data.sourceUrls || []),
        ...values.flatMap((v) => v.sourceUrls || []),
      ]),
    ],
    retrievedAt: body.retrievedAt || base.retrievedAt,
    sourceStatus: data.sourceStatus,
    ...(body.refresh ? { refresh: body.refresh } : {}),
    message:
      data.message ||
      'News coverage is limited to checked public city-topic feeds; no exact-property search was sent upstream.',
  };
}

export const localNewsSection = Object.freeze({
  id,
  label,
  order,
  load: loadLocalNewsSection,
});
