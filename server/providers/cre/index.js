// The one registry of CRE server plugins; local.js spreads this list, and the integrator appends each package's plugin here as it lands.
import { creHealthProxy } from './health.js';
import { creSiteProxy } from './site.js';
import { creHazardsProxy } from './hazards.js';
import { creIncentivesProxy } from './incentives.js';
import { creCensusProxy } from './census.js';
import { creLodesProxy } from './lodes.js';
import { creQcewProxy } from './qcew.js';
import { creIsochroneProxy } from './isochrone.js';
import { creSchoolsProxy } from './schools.js';
import { crePermitsProxy } from './permits.js';
import { creRentsProxy } from './rents.js';
import { creAmenitiesProxy } from './amenities.js';
import { creNeighborhoodProxy } from './neighborhood.js';
import { creDestinationsProxy } from './destinations.js';
import { creWaybackProxy } from './wayback.js';
import { creCamerasProxy } from './cameras.js';
import { creMarketProxy } from './market.js';
import { creDevelopmentProxy } from './development.js';
import { creLocalNewsProxy } from './localNews.js';
import { localBrandMarksProxy } from './localBrandMarks.js';
import { creInsuranceProxy } from './insurance.js';
import { creLihtcLimitsProxy } from './lihtcLimits.js';
import { creDemandDriversProxy } from './demandDrivers.js';
import { creUtilitiesProxy } from './utilities.js';

/**
 * Construct the CRE provider plugins. Each data family adds one entry,
 * mounted at /api/cre/<family>.
 * @returns {import('vite').Plugin[]}
 */
export function creProviderPlugins() {
  return [
    creHealthProxy(),
    creSiteProxy(),
    creHazardsProxy(),
    creIncentivesProxy(),
    creCensusProxy(),
    creLodesProxy(),
    creQcewProxy(),
    creIsochroneProxy(),
    creSchoolsProxy(),
    crePermitsProxy(),
    creRentsProxy(),
    creAmenitiesProxy(),
    creNeighborhoodProxy(),
    creDestinationsProxy(),
    creWaybackProxy(),
    creCamerasProxy(),
    creMarketProxy(),
    creDevelopmentProxy(),
    creLocalNewsProxy(),
    localBrandMarksProxy(),
    creInsuranceProxy(),
    creLihtcLimitsProxy(),
    creDemandDriversProxy(),
    creUtilitiesProxy(),
  ];
}
