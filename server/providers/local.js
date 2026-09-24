import { openSkyProxy } from './aircraft/opensky.js';
import { celestrakProxy, rocketLaunchesProxy } from './space.js';
import { tomtomProxy } from './traffic.js';
import { firmsProxy } from './firms.js';
import { terrainHeightsProxy } from './terrain.js';
import { adsbdbProxy } from './aircraft/enrichment.js';
import { overpassProxy } from './overpass.js';
import { militaryInstallationsProxy } from './military-installations.js';
import { regionalBriefProxy } from './regional/briefing.js';
import { geocodeProxy } from './regional/place.js';
import { censusGeocodeProxy } from './census.js';
import { weatherEffectsProxy } from './regional/weather-effects.js';
import { cctvProxy } from './cctv.js';
import { defaultSourceRoot } from './common/source-root.js';
import { radioBrowserProxy } from './radio.js';
import { gbfsProxy } from './gbfs.js';
import { transitProxy } from './transit.js';
import { adsbLolProxy } from './aircraft/adsb-lol.js';
import { aisLiveProxy } from './vessels/ais-live.js';
import { trackBackfillProxies } from './aircraft/tracks.js';
import { openAiRealtimeProxy } from './openai.js';
import { googlePlacesContextProxy } from './places.js';
import { keySetupEndpoint } from '../standalone/key-setup.js';
import { creProviderPlugins } from './cre/index.js';

/**
 * Upstream globe extras this fork does not use in the CRE interface: OpenSky
 * flight tracking (non-commercial license; ADS-B Lol and adsbdb are its
 * fallback/enrichment for the same "flights" layer) and the AIS vessel feed.
 * Both layers are already hidden from the CRE UI (see CRE_HIDDEN_LAYER_IDS in
 * src/cre/mode.js) but their server routes were still mounted by default.
 * They're real, working upstream features (kept for anyone running this fork
 * in its original globe/"gev" mode) but are off by default here so a CRE
 * install neither calls OpenSky's non-commercial API nor an AIS feed
 * unasked. Set GEV_ENABLE_UPSTREAM_EXTRAS=1 to mount them again; doing so is
 * the operator's own call on OpenSky's non-commercial terms and the AIS
 * feed's terms, not this repo's.
 */
function upstreamExtrasEnabled() {
  return String(process.env.GEV_ENABLE_UPSTREAM_EXTRAS || '').trim() === '1';
}

/** Construct the local provider plugins in their established order. */
function localProviderPlugins() {
  const upstreamExtras = upstreamExtrasEnabled();
  return [
    ...(upstreamExtras
      ? [openSkyProxy(), adsbdbProxy(), adsbLolProxy(), trackBackfillProxies()]
      : []),
    celestrakProxy(),
    tomtomProxy(),
    firmsProxy(),
    rocketLaunchesProxy(),
    terrainHeightsProxy(),
    overpassProxy(),
    militaryInstallationsProxy(),
    regionalBriefProxy(),
    geocodeProxy(),
    censusGeocodeProxy(),
    weatherEffectsProxy(),
    cctvProxy({ sourceRoot: defaultSourceRoot }),
    radioBrowserProxy(),
    gbfsProxy(),
    transitProxy(),
    ...(upstreamExtras ? [aisLiveProxy()] : []),
    openAiRealtimeProxy(),
    googlePlacesContextProxy(),
    keySetupEndpoint(),
    ...creProviderPlugins(),
  ];
}

export { localProviderPlugins };

export {
  CCTV_FRAME_FETCH_TIMEOUT_MS,
  fetchCctvImageFromUpstream,
} from './cctv.js';
export {
  createRadioProxyMiddleware,
  isPublicRadioAddress,
  normalizeRadioBrowserStation,
  publicRadioStation,
  publicRadioHttpsUrl,
} from './radio.js';
export { LL2_CACHE_TTL_MS, launchLibraryRequestHeaders } from './space.js';
export { googlePlacesContextProxy } from './places.js';
export { googleServerApiKey } from './places.js';
export { keylessGooglePlacesResponse } from './places.js';
export { adsbLolFallbackAnchor } from './aircraft/opensky.js';
export { readResponseTextCapped } from './common/http.js';
export { readResponseJsonCapped } from './common/http.js';
export { coalesceProxyRequest } from './common/http.js';
export { requiredFiniteQueryNumber } from './common/query.js';
export { isOverpassBoundaryQuery } from './overpass/query.js';
export { simplifyOverpassPayloadBody } from './overpass/geometry.js';
export { readOverpassDisk } from './overpass/cache.js';
export { resolveOverpassPreflight } from './overpass/cache.js';
export { overpassPayloadIsData } from './overpass/transport.js';
export { fetchOverpassPayload } from './overpass/transport.js';
export { openAiRealtimeProxy } from './openai.js';
export { MILITARY_INSTALLATION_ELEMENT_CAP } from './military-installations/constants.js';
export { quantizeMilitaryInstallationBox } from './military-installations/query.js';
export { militaryInstallationCacheKey } from './military-installations/query.js';
export { resolveMilitaryInstallationTier } from './military-installations/cache.js';
export { migrateMilitaryInstallationEntry } from './military-installations/cache.js';
export { militaryInstallationDiskFresh } from './military-installations/cache.js';
export { militaryInstallationDiskPath } from './military-installations/cache.js';
export { readMilitaryInstallationDisk } from './military-installations/cache.js';
export { writeMilitaryInstallationDisk } from './military-installations/cache.js';
export { validMilitaryInstallationBox } from './military-installations/query.js';
export { militaryInstallationFailureReason } from './military-installations/query.js';
export { validRegionalPoint } from './regional/query.js';
export { regionalBriefHasAnySource } from './regional/briefing.js';
