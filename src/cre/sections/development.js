import { SECTION_STATUS } from '../contract.js';

export const id = 'development';
export const label = 'Projects and public works';
export const order = 16;
const CREDIT = Object.freeze({
  text: 'City of Dallas Right-of-Way Management; City of Atlanta Department of City Planning',
  url: 'https://www.dallasopendata.com/',
  license: 'Public municipal GIS; source-specific reuse terms apply',
});

export function developmentValues(data) {
  const records = Array.isArray(data?.records) ? data.records : [];
  const values = [];
  if (records.length)
    values.push({
      label:
        data.region === 'dallas-tx'
          ? 'Nearby right-of-way permits shown'
          : 'Nearby rezoning cases shown',
      value: records.length,
      note: `${data.window || 'Date window not reported'}; ${data.totalReturned ?? records.length} returned by source${data.truncated ? ', display capped or source truncated' : ''}. These are local context, not confirmed subject projects.`,
      sourceUrls: data.sourceUrls || [],
    });
  for (const record of records) {
    if (!record || !record.id || !record.title || !record.sourceUrl) continue;
    const context =
      record.kind === 'right-of-way-permit'
        ? `${record.distanceM ?? '?'} m away`
        : 'in nearby map square';
    values.push({
      label: `${record.kind === 'right-of-way-permit' ? 'ROW permit' : 'Rezoning'} ${record.id}`,
      value: record.title,
      note: `${record.status || 'Status not reported'}; ${record.recordDate || `docket ${record.docketYear || 'date unknown'}`}; ${context}. ${record.note || ''}`.trim(),
      externalUrl: record.sourceUrl,
      sourceUrls: [
        record.sourceUrl,
        ...(record.ordinanceUrl ? [record.ordinanceUrl] : []),
      ],
      recordDate: record.recordDate,
      scope: record.scope,
    });
  }
  if (data?.codeCaseUrl)
    values.push({
      label: 'Code compliance case search',
      value: 'Open official city case search',
      note: 'Current case records were not verified in a connected feed. A complaint is not a confirmed violation.',
      externalUrl: data.codeCaseUrl,
      sourceUrls: [data.codeCaseUrl],
      scope: 'source-link-only',
    });
  return values;
}

export async function loadDevelopmentSection(
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
  if (refresh) params.set('refresh', '1');
  let body;
  try {
    const response = await fetchImpl(`/api/cre/development?${params}`, {
      signal,
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) throw new Error('DEVELOPMENT_ROUTE');
    body = await response.json();
  } catch (error) {
    if (signal?.aborted) throw error;
    return {
      ...base,
      status: SECTION_STATUS.UNAVAILABLE,
      values: [],
      message: 'City project and public-works sources did not answer.',
    };
  }
  const data = body?.data;
  if (!data || typeof data !== 'object')
    return {
      ...base,
      status: SECTION_STATUS.UNAVAILABLE,
      values: [],
      message: 'Municipal records response was invalid.',
    };
  const values = developmentValues(data);
  const status =
    data.status === 'not-covered' || data.status === 'unavailable'
      ? SECTION_STATUS.UNAVAILABLE
      : data.status === 'partial' || data.truncated || !data.records?.length
        ? SECTION_STATUS.PARTIAL
        : SECTION_STATUS.READY;
  return {
    ...base,
    status,
    values,
    sourceUrls: [
      ...new Set([
        ...(data.sourceUrls || []),
        ...values.flatMap((v) => v.sourceUrls || []),
      ]),
    ],
    retrievedAt: body.retrievedAt || base.retrievedAt,
    ...(body.refresh ? { refresh: body.refresh } : {}),
    message:
      data.message ||
      'Municipal activity is local context; project and code-case coverage is incomplete.',
  };
}

export const developmentSection = Object.freeze({
  id,
  label,
  order,
  load: loadDevelopmentSection,
});
