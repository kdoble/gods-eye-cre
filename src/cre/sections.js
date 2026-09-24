// Ordered registry of dossier section modules; the integrator owns this file and builders hand over sections/<id>.js modules.
// Each entry exposes { id, label, order, load(ctx, { signal }) }. The fixture
// section (sections/fixture.js) is for tests only and is never registered.
import * as location from './sections/location.js';
import * as hazards from './sections/hazards.js';
import * as demographics from './sections/demographics.js';
import * as jobs from './sections/jobs.js';
import * as access from './sections/access.js';
import { schoolsSection } from './sections/schools.js';
import * as incentives from './sections/incentives.js';
import { supplySection } from './sections/supply.js';
import { rentsSection } from './sections/rents.js';
import { amenitiesSection } from './sections/amenities.js';
import * as cameras from './sections/cameras.js';
import * as imagery from './sections/imagery.js';
import { destinationsSection } from './sections/destinations.js';
import * as neighborhood from './sections/neighborhood.js';
import { marketSection } from './sections/market.js';
import { developmentSection } from './sections/development.js';
import { localNewsSection } from './sections/localNews.js';
import * as insurance from './sections/insurance.js';
import * as lihtcLimits from './sections/lihtcLimits.js';
import * as demandDrivers from './sections/demandDrivers.js';
import * as utilities from './sections/utilities.js';

/**
 * Display order: decision data first (risk, incentives, who lives there,
 * rents, supply, jobs), then access and neighborhood, then site trivia. The
 * modules keep their own `order`; the registry decides what the panel shows.
 */
export const SECTION_DISPLAY_ORDER = Object.freeze([
  'neighborhood',
  'destinations',
  'demand-drivers',
  'hazards',
  'insurance',
  'market',
  'development',
  'local-news',
  'incentives',
  'lihtc-limits',
  'demographics',
  'rents',
  'supply',
  'jobs',
  'access',
  'utilities',
  'schools',
  'amenities',
  'imagery',
  'cameras',
  'location',
]);

const rank = (id) => {
  const at = SECTION_DISPLAY_ORDER.indexOf(id);
  return at === -1 ? SECTION_DISPLAY_ORDER.length + 1 : at + 1;
};

const pick = ({ id, label, load }) =>
  Object.freeze({ id, label, order: rank(id), load });

/** @type {ReadonlyArray<{id:string, label:string, order:number, load:Function}>} */
export const SECTIONS = Object.freeze(
  [
    location,
    hazards,
    demographics,
    jobs,
    access,
    schoolsSection,
    incentives,
    supplySection,
    rentsSection,
    amenitiesSection,
    cameras,
    imagery,
    neighborhood,
    destinationsSection,
    marketSection,
    developmentSection,
    localNewsSection,
    insurance,
    lihtcLimits,
    demandDrivers,
    utilities,
  ]
    .map(pick)
    .sort((a, b) => a.order - b.order),
);
