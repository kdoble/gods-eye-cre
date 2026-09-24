// Public city-topic headlines. The selected address is matched only after
// retrieval; it is never sent to the news index or publisher.
import { readResponseTextCapped } from '../common/http.js';
import { createCreCache } from './common/cache.js';
import {
  creBody,
  creRoute,
  makeCreLimiter,
  parsePoint,
  parseRefresh,
  sendError,
  sendJson,
  CRE_ERRORS,
} from './common/route.js';
import { resolveLocalJurisdiction } from './jurisdictions.js';

const HOUR = 3_600_000;
const FEED = 'https://news.google.com/rss/search';
const SOURCE = Object.freeze({
  name: 'Google News public RSS search; publisher named per headline',
  url: 'https://news.google.com/',
  license:
    'Headline metadata only; publisher article and Google News terms govern reuse',
});
const TOPICS = Object.freeze({
  'dallas-tx': [
    ['housing', 'Dallas housing development'],
    ['retail', 'Dallas retail opening'],
    ['roads', 'Dallas road construction'],
  ],
  'atlanta-ga': [
    ['housing', 'Atlanta housing development'],
    ['retail', 'Atlanta retail opening'],
    ['roads', 'Atlanta road construction'],
  ],
});

const xmlText = (value) =>
  String(value ?? '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(
      /&#(x[0-9a-f]+|\d+);|&amp;|&lt;|&gt;|&quot;|&apos;|&nbsp;/gi,
      (entity, numeric) => {
        if (numeric) {
          const code =
            numeric[0].toLowerCase() === 'x'
              ? parseInt(numeric.slice(1), 16)
              : Number(numeric);
          return Number.isInteger(code) && code >= 32 && code <= 0x10ffff
            ? String.fromCodePoint(code)
            : ' ';
        }
        return (
          {
            '&amp;': '&',
            '&lt;': '<',
            '&gt;': '>',
            '&quot;': '"',
            '&apos;': "'",
            '&nbsp;': ' ',
          }[entity.toLowerCase()] || ' '
        );
      },
    )
    .replace(/<[^>]*>/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
const tag = (item, name) =>
  item.match(
    new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i'),
  )?.[1] ?? '';

export function parseNewsRss(xml, { topic, region, now = Date.now() }) {
  if (!/<rss\b/i.test(xml) || !/<channel>/i.test(xml))
    throw new Error('INVALID_NEWS_RSS');
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 35);
  const place = region === 'dallas-tx' ? /\bdallas\b/i : /\batlanta\b/i;
  const subject = {
    housing:
      /\b(?:hous(?:e|es|ing)|homes?|apartments?|multifamily|residential|development|redevelopment|construction)\b/i,
    retail:
      /\b(?:retail|stor(?:e|es)|shop|restaurant|opening|grocer|market)\b/i,
    roads:
      /\b(?:road|highway|street|traffic|transportation|interstate|intersection|bridge|rail|sidewalk|txdot|gd(?:ot)?|lane|construction)\b/i,
  }[topic];
  const cutoff = now - 366 * 86_400_000;
  return items
    .map((match) => {
      const item = match[1],
        rawTitle = xmlText(tag(item, 'title')).slice(0, 240);
      const publisher = xmlText(tag(item, 'source')).slice(0, 90);
      const title = rawTitle.endsWith(` - ${publisher}`)
        ? rawTitle.slice(0, -publisher.length - 3)
        : rawTitle;
      const rawLink = xmlText(tag(item, 'link'));
      const published = Date.parse(xmlText(tag(item, 'pubDate')));
      let link = null;
      try {
        const url = new URL(rawLink);
        if (
          url.protocol === 'https:' &&
          url.hostname === 'news.google.com' &&
          url.pathname.startsWith('/rss/articles/')
        )
          link = url.href;
      } catch {
        /* Untrusted link omitted. */
      }
      if (
        !title ||
        !publisher ||
        !link ||
        !Number.isFinite(published) ||
        published < cutoff ||
        published > now + HOUR ||
        !place.test(title) ||
        (subject && !subject.test(title))
      )
        return null;
      // Dallas Highway is in Georgia, not Dallas, Texas. Query text alone can
      // otherwise classify this common false positive as local Dallas news.
      if (
        region === 'dallas-tx' &&
        /\b(?:Georgia DOT|Dallas Highway|Paulding County)\b/i.test(title)
      )
        return null;
      return {
        title,
        publisher,
        publishedAt: new Date(published).toISOString(),
        topic,
        scope: 'city-context',
        url: link,
      };
    })
    .filter(Boolean);
}

function exactAddressTokens(address) {
  const firstLine = String(address).split(',')[0].trim();
  const match = /^(\d{1,6})\s+([A-Za-z][A-Za-z0-9' -]{2,70})$/i.exec(firstLine);
  if (!match) return null;
  const street = match[2]
    .toLowerCase()
    .replace(/\s+(?:ne|nw|se|sw|n|s|e|w)$/i, '')
    .replace(
      /\s+(?:street|st|avenue|ave|road|rd|lane|ln|drive|dr|boulevard|blvd|parkway|pkwy)$/i,
      '',
    )
    .replace(/\s+/g, ' ')
    .trim();
  if (street.length < 4) return null;
  return { number: match[1], street };
}

export function markExactMatches(records, address) {
  const tokens = exactAddressTokens(address);
  return records.map((item) => {
    const title = item.title.toLowerCase();
    const exact = Boolean(
      tokens &&
      new RegExp(`\\b${tokens.number}\\b`).test(title) &&
      new RegExp(
        `\\b${tokens.street.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`,
      ).test(title),
    );
    return {
      ...item,
      scope: exact ? 'property-headline-match' : 'city-context',
    };
  });
}

function feedUrl(query) {
  const url = new URL(FEED);
  url.searchParams.set('q', query);
  url.searchParams.set('hl', 'en-US');
  url.searchParams.set('gl', 'US');
  url.searchParams.set('ceid', 'US:en');
  return url.href;
}

export function createLocalNewsService({
  fetchImpl = globalThis.fetch,
  cacheRoot,
  disk = true,
  jurisdictionResolver = resolveLocalJurisdiction,
  now = Date.now,
} = {}) {
  const cache = createCreCache({
    family: 'news-city-topics-v1',
    ttlMs: 6 * HOUR,
    maxEntries: 20,
    disk,
    now,
    ...(cacheRoot ? { rootDir: cacheRoot } : {}),
  });
  async function localNewsFor({ lat, lon, address = '', refresh = false }) {
    const jurisdiction = await jurisdictionResolver({ lat, lon }, 0, {
      fetchImpl,
    });
    if (jurisdiction.status !== 'resolved' || !TOPICS[jurisdiction.id])
      return {
        region: jurisdiction.id || null,
        status:
          jurisdiction.status === 'uncovered' ? 'not-covered' : 'unavailable',
        records: [],
        message: jurisdiction.message || 'No local news feed is connected.',
        sourceUrls: [],
        retrievedAt: new Date(now()).toISOString(),
      };
    const region = jurisdiction.id;
    const tasks = TOPICS[region].map(async ([topic, query]) => {
      const url = feedUrl(query);
      try {
        const result = await cache.getOrLoad(
          `${region}:${topic}`,
          async () => {
            const response = await fetchImpl(url, {
              signal: AbortSignal.timeout(15_000),
              redirect: 'error',
              headers: {
                Accept: 'application/rss+xml, application/xml, text/xml',
              },
            });
            if (!response.ok) {
              void response.body?.cancel?.().catch(() => {});
              throw new Error('NEWS_HTTP');
            }
            return parseNewsRss(
              await readResponseTextCapped(response, 180 * 1024),
              { topic, region, now: now() },
            );
          },
          { refresh },
        );
        return { topic, url, result, status: 'ready' };
      } catch {
        return { topic, url, result: null, status: 'unavailable' };
      }
    });
    const sources = await Promise.all(tasks);
    const all = sources.flatMap((source) => source.result?.value || []);
    const deduped = [
      ...new Map(all.map((item) => [item.title.toLowerCase(), item])).values(),
    ].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
    const marked = markExactMatches(deduped, address);
    const exact = marked
      .filter((item) => item.scope === 'property-headline-match')
      .slice(0, 4);
    const city = marked.filter((item) => item.scope === 'city-context');
    const balanced = [];
    for (const topic of ['housing', 'retail', 'roads'])
      balanced.push(...city.filter((item) => item.topic === topic).slice(0, 4));
    const records = [...exact, ...balanced]
      .slice(0, 12)
      .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
    const stamps = sources
      .map((s) => s.result?.cachedAt)
      .filter(Number.isFinite);
    const failed = sources.filter(
      (s) => s.status === 'unavailable' || s.result?.source === 'STALE',
    );
    const refreshStatuses = sources
      .map((s) => s.result?.refreshStatus)
      .filter(Boolean);
    const attempts = sources
      .map((s) => s.result?.attemptedAt)
      .filter(Number.isFinite);
    return {
      region,
      status: failed.length
        ? records.length
          ? 'partial'
          : 'unavailable'
        : records.length
          ? 'ready'
          : 'empty',
      records,
      searchedTopics: TOPICS[region].map(([topic]) => topic),
      sourceStatus: Object.fromEntries(
        sources.map((s) => [
          s.topic,
          s.status === 'unavailable'
            ? 'unavailable'
            : s.result?.source === 'STALE'
              ? 'stale'
              : 'ready',
        ]),
      ),
      sourceUrls: sources.map((s) => s.url),
      retrievedAt: new Date(
        stamps.length ? Math.min(...stamps) : now(),
      ).toISOString(),
      message: failed.length
        ? `News feed unavailable or stale for ${failed.map((s) => s.topic).join(', ')}; other topics may be incomplete.`
        : records.length
          ? 'City-level headlines are not evidence about this property. Exact-address matches are based on headline text only, not article verification.'
          : 'No matching dated headlines appeared in the checked city-topic feed window; this is not proof of no news.',
      ...(refresh
        ? {
            refresh: {
              status:
                failed.length || refreshStatuses.includes('failed')
                  ? 'failed'
                  : refreshStatuses.includes('throttled')
                    ? 'throttled'
                    : refreshStatuses.includes('joined-existing')
                      ? 'joined-existing'
                      : 'succeeded',
              attemptedAt: attempts.length
                ? new Date(Math.max(...attempts)).toISOString()
                : null,
              dataRetrievedAt: stamps.length
                ? new Date(Math.min(...stamps)).toISOString()
                : null,
            },
          }
        : {}),
    };
  }
  return { localNewsFor };
}

export function creLocalNewsHandler({
  service = createLocalNewsService(),
  limiter = makeCreLimiter({ max: 30 }),
} = {}) {
  return creRoute(
    async ({ res, params }) => {
      const point = parsePoint(params),
        flag = parseRefresh(params);
      if (!point.ok) return sendError(res, 400, CRE_ERRORS.BAD_POINT);
      if (!flag.ok) return sendError(res, 400, CRE_ERRORS.BAD_REFRESH);
      const address = params.get('address') || '';
      if (address.length > 160 || /[\u0000-\u001f\u007f]/.test(address))
        return sendError(res, 400, 'Invalid address');
      const data = await service.localNewsFor({
        ...point,
        address,
        refresh: flag.refresh,
      });
      const body = creBody(
        data.records.length ? 'ready' : 'empty',
        data,
        SOURCE,
        new Date(data.retrievedAt),
      );
      if (data.refresh) body.refresh = data.refresh;
      sendJson(res, 200, body);
    },
    { limiter, tag: 'local-news' },
  );
}

export function creLocalNewsProxy() {
  const install = (server) => {
    server.middlewares.use('/api/cre/local-news', creLocalNewsHandler());
  };
  return {
    name: 'cre-local-news',
    configureServer: install,
    configurePreviewServer: install,
  };
}
