// Role-specific, evidence-led first-screen content. This module only rearranges
// source results; it never scores a site or fills a missing result with a claim.
import { formatLabeledValue } from './format.js';

const ROLE_COPY = Object.freeze({
  investor: {
    title: 'Acquisition and operating context',
    groups: [
      [
        'crime',
        'Reported offense records',
        'What does the local source report, for which area and dates?',
        ['neighborhood'],
      ],
      [
        'walkability',
        'Walkable daily needs',
        'Which named daily needs are reachable on foot?',
        ['destinations', 'walkability', 'amenities', 'access', 'location'],
      ],
      [
        'retail-access',
        'Major retail and road access',
        'Which retail anchors and road connections are nearby?',
        ['destinations', 'retail', 'roads', 'access', 'neighborhood'],
      ],
      [
        'market',
        'Renters, rents and demand',
        'What market evidence supports the renter and rent thesis?',
        ['demographics', 'rents', 'jobs'],
      ],
      [
        'competition',
        'Competing supply',
        'What projects or permits may affect lease-up?',
        ['supply'],
      ],
      [
        'exposure',
        'Physical and operating exposure',
        'What should be verified before an acquisition decision?',
        ['hazards', 'schools', 'incentives'],
      ],
    ],
    questions: [
      'Confirm the police source, covered dates, geography, and omitted categories.',
      'Verify the walking route and destination entrance in the field.',
      'Validate comparable rents, concessions, and competing project status.',
    ],
  },
  developer: {
    title: 'Parcel and concept feasibility context',
    groups: [
      [
        'crime',
        'Reported offense records',
        'What does the local source report, for which area and dates?',
        ['neighborhood'],
      ],
      [
        'parcel',
        'Parcel and zoning',
        'Which parcel and current land-use rules apply here?',
        ['parcel', 'zoning', 'neighborhood', 'location'],
      ],
      [
        'access',
        'Access and daily needs',
        'What routes, destinations, and access evidence are available?',
        [
          'destinations',
          'walkability',
          'amenities',
          'access',
          'roads',
          'retail',
        ],
      ],
      [
        'constraints',
        'Site constraints',
        'Which mapped constraints need parcel-level verification?',
        ['hazards'],
      ],
      [
        'demand',
        'Demand and competing supply',
        'What dated demand and project evidence should shape the concept?',
        ['demographics', 'jobs', 'supply', 'rents'],
      ],
      [
        'program',
        'Other location context',
        'What additional public context is available for this point?',
        ['schools', 'incentives'],
      ],
    ],
    questions: [
      'Confirm parcel identity, zoning text, and applicable overlays with the authority.',
      'Verify frontage, legal and fire access, utilities, and connection capacity.',
      'Have civil and environmental diligence define buildable area; no area is inferred here.',
    ],
  },
});

const FIELD_FILTERS = Object.freeze({
  crime: /crime|incident|offen[cs]e|reporting|police source/i,
  walkability:
    /walk|pedestrian|foot|grocery|grocer|pharmacy|park|transit|sidewalk|destination/i,
  'retail-access':
    /retail|anchor|major road|interchange|road access|access route|frontage|curb|drive time|^drive to\b/i,
  market:
    /income|rent|household|population|jobs|employment|labor|wage|vacancy|occupancy|renters/i,
  competition:
    /permit|development|unit|pipeline|competing|project|supply|construction|delivery/i,
  exposure: /flood|wetland|hazard|environment|school|incentive|slope|soil/i,
  parcel:
    /parcel|zoning|land use|property id|jurisdiction|lot area|parcel area/i,
  access:
    /access|route|road|walk|grocery|retail|transit|interchange|frontage|curb|destination/i,
  constraints: /flood|wetland|hazard|environment|slope|utility|constraint/i,
  demand:
    /rent|jobs|employment|population|income|permit|supply|project|unit|household/i,
  program: /school|incentive|affordable/i,
});
const GROUP_LIMITS = Object.freeze({
  crime: 6,
  walkability: 6,
  'retail-access': 6,
  market: 7,
  competition: 6,
  exposure: 6,
  parcel: 7,
  access: 7,
  constraints: 7,
  demand: 7,
  program: 5,
});

const asText = (value) => String(value ?? '').trim();

/**
 * Statuses that mean "no feed reaches this locality" for the crime coverage
 * row (as opposed to a real, possibly zero, incident count). The row's own
 * message used to be rendered verbatim here, which for any city outside the
 * one pilot feed (Chicago) surfaced "Coverage pilot: Chicago reported
 * incidents only" and a data.cityofchicago.org link on an unrelated site
 * (e.g. New York). A source that does not cover this city is never relevant
 * evidence for it, so the card says the plain thing instead and cites
 * nothing but this locality's own sources.
 */
const CRIME_NO_FEED_STATUSES = new Set([
  'unsupported',
  'empty',
  'unavailable',
  'source-unavailable',
]);

function rowText(item, sectionId, valueStatus) {
  if (sectionId === 'crime' && valueStatus === 'published-not-connected') {
    return 'Official police map is published; its incident feed is not connected here. No incident counts or rating are shown. Full source notes and exclusions are in Details and the report appendix.';
  }
  if (
    sectionId === 'crime' &&
    (CRIME_NO_FEED_STATUSES.has(valueStatus) ||
      asText(item?.label).toLowerCase() === 'crime coverage')
  ) {
    return 'No automated crime feed for this city yet. Check local police records for reported incidents. Missing coverage does not mean low crime.';
  }
  const value = formatLabeledValue(item);
  return [value, asText(item?.note)].filter(Boolean).join(' · ');
}

/** Never cite the Chicago crime pilot's own data portal for a site it does not cover. */
function isIrrelevantPilotUrl(sectionId, valueStatus, url) {
  return (
    sectionId === 'crime' &&
    valueStatus !== 'published-not-connected' &&
    /cityofchicago\.org/i.test(String(url ?? ''))
  );
}

/**
 * Arrange existing section evidence for a role-first screen and printable brief.
 * Output contains plain text only. Callers must render it as text, not HTML.
 * @param {object} snapshot dossier snapshot
 * @param {'investor'|'developer'} role
 */
export function buildRoleInsights(snapshot, role = 'investor') {
  const selected = ROLE_COPY[role] ? role : 'investor';
  const copy = ROLE_COPY[selected];
  const byId = new Map(
    (snapshot?.sections || []).map((entry) => [entry.id, entry]),
  );
  const groups = copy.groups.map(([id, title, question, sectionIds]) => {
    const entries = sectionIds
      .map((sectionId) => byId.get(sectionId))
      .filter(Boolean);
    const items = [];
    const seen = new Set();
    for (const entry of entries) {
      const result = entry.result;
      const values = result?.values || [];
      let sectionItems = 0;
      const sectionLimit =
        id === 'retail-access' && entry.id === 'destinations'
          ? 3
          : GROUP_LIMITS[id] || 6;
      for (const value of values) {
        if (sectionItems >= sectionLimit) break;
        const label = asText(value.label) || entry.label || entry.id;
        const valueStatus = value.status || entry.status;
        const filterText =
          id === 'retail-access' ? label : `${label} ${asText(value.note)}`;
        if (!FIELD_FILTERS[id]?.test(filterText)) continue;
        const dedupeKey = `${entry.id}:${label}:${asText(value.value)}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        const text = rowText(value, id, valueStatus);
        if (!text) continue;
        items.push({
          label,
          text,
          status:
            valueStatus === 'published-not-connected'
              ? 'partial'
              : valueStatus || (value.partial ? 'partial' : entry.status),
          sourceStatus: valueStatus,
          source: asText(result?.credit?.text),
          retrievedAt: asText(result?.retrievedAt),
          sourceUrls: [
            ...new Set(
              [
                ...(value.sourceUrls || result?.sourceUrls || []),
                ...(value.sourceUrls ? [] : [result?.credit?.url]),
              ].filter(Boolean),
            ),
          ].filter((url) => !isIrrelevantPilotUrl(id, valueStatus, url)),
        });
        sectionItems += 1;
        if (items.length >= (GROUP_LIMITS[id] || 6)) break;
      }
      if (items.length >= (GROUP_LIMITS[id] || 6)) break;
      if (!items.length && result?.message && entry.status !== 'ready') {
        items.push({
          label: entry.label || entry.id,
          text:
            entry.status === 'needs-key'
              ? entry.id === 'demographics'
                ? 'Census data needs a key to load income, renter, and gross-rent context.'
                : 'A provider key is needed to load this result.'
              : asText(result.message),
          status: entry.status,
          source: asText(result?.credit?.text),
          retrievedAt: asText(result?.retrievedAt),
          sourceUrls: [
            ...new Set(
              [...(result?.sourceUrls || []), result?.credit?.url].filter(
                Boolean,
              ),
            ),
          ],
        });
      }
    }
    if (!items.length) {
      const found = entries.some((entry) => entry.status === 'loading');
      items.push({
        label: 'Evidence status',
        text: found
          ? 'This source is still being checked.'
          : `No ${id === 'crime' ? 'crime-specific' : id === 'parcel' ? 'parcel or zoning' : title.toLowerCase()} result is available in this snapshot. This does not establish absence or low risk.`,
        status: found ? 'loading' : 'unavailable',
        sourceUrls: [],
      });
    }
    return { id, title, question, items };
  });
  return {
    title: copy.title,
    role: selected,
    groups,
    questions: [...copy.questions],
  };
}

/** Item statuses that carry no evidence: nothing connected, nothing supported, or a key still needed. */
const NO_DATA_ITEM_STATUSES = new Set([
  'unavailable',
  'unsupported',
  'published-not-connected',
  'needs-key',
  'source-unavailable',
]);

/**
 * True when a role-insight group has no real evidence: every item is
 * unavailable, unsupported, not connected, or waiting on a key. A group with
 * even one item carrying data (a value, a partial reading, or a still-loading
 * check) is never "no data".
 * @param {{items: Array<{status?: string}>}} group
 */
export function groupIsNoData(group) {
  const items = group?.items || [];
  if (!items.length) return false;
  return items.every((item) => NO_DATA_ITEM_STATUSES.has(item.status));
}

/**
 * Split role-insight groups into the ones with evidence (kept in place) and
 * the ones with none (moved to the end, original order kept), so the
 * strongest signal on a role tab is never buried under a stack of empty
 * cards. Callers render `hidden` under a single collapsed "No data for this
 * location (N)" group.
 * @param {Array<{id:string}>} groups
 */
export function partitionGroups(groups) {
  const visible = [];
  const hidden = [];
  for (const group of groups || [])
    (groupIsNoData(group) ? hidden : visible).push(group);
  return { visible, hidden };
}
