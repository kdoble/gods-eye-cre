# Data Sources & Attribution

God's Eye View's **code** is [MIT](LICENSE)-licensed. **The MIT grant covers the source code only. It does NOT extend to third-party data or visual assets.** Every third-party source keeps its own license and terms. This file documents the live and bundled data sources; bundled 3D-model provenance is recorded in [`public/models/README.md`](public/models/README.md).

How to read this:

- **The non-permissive datasets listed below are historical.** Cable and Bhote Koshi noncommercial payloads have been removed from the current CRE distribution, current build, and shallow clone. Their source commits remain in repository history and their original terms still apply to those copies.
- **Current distribution scope is CRE-focused.** Each live source retains its own terms, and this document records attribution obligations for currently used sources as well as provenance for removed historical datasets.
- **Attribution is shown in-app** and listed here. Keep it intact. The required Google/Cesium credit renders on the on-globe credit line (bottom-left, `#cesium-credits`), and every per-layer credit below is registered into the expandable **"Data attribution"** lightbox on that line (`src/data/dataCredits.js` → `viewer.creditDisplay.addStaticCredit`). Both stay visible in clean-view and recording modes.
- **Bundled model attribution lives beside the model files.** [`public/models/README.md`](public/models/README.md) records each shipped model's creator, source, license, and modification status.

---

## Live sources (fetched at runtime, not stored in this repo)

| Source                                                                | Used for                                                                                                                            | License / terms                                                                                                                                                                                                                                                                                                                                       | Attribution                                                                                                                                 |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **OpenStreetMap ALPR camera locations** (including DeFlock community mapping) | Optional mapped automatic license-plate-reader camera layer | [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/); commercial use permitted with applicable attribution and database share-alike obligations | [© OpenStreetMap contributors](https://www.openstreetmap.org/copyright); [DeFlock](https://deflock.org) community mapping |
| **Google Map Tiles API** (Photorealistic 3D Tiles) + Places/Geocoding | The 3D globe, voice scene context, and on-demand nearby installation search                                                         | Google Maps Platform ToS (proprietary, your own key + billing)                                                                                                                                                                                                                                                                                        | "Google" / "Google Maps" logo, **shown in-app**, required                                                                                  |
| **OpenSky Network**                                                   | Primary worldwide live-flight snapshot                                                                                              | Non-commercial research/education license                                                                                                                                                                                                                                                                                                             | Schäfer et al., _"Bringing Up OpenSky"_, IPSN 2014 + opensky-network.org                                                                    |
| **adsb.lol point API**                                                | Bounded live-flight fallback when OpenSky has no usable snapshot                                                                    | ODbL 1.0                                                                                                                                                                                                                                                                                                                                              | adsb.lol contributors; `api.adsb.lol/v2/lat/{lat}/lon/{lon}/dist/{radius}`                                                                  |
| **adsb.lol**                                                          | Military flights + aircraft traces                                                                                                  | ODbL 1.0                                                                                                                                                                                                                                                                                                                                              | "adsb.lol" (ODbL)                                                                                                                           |
| **adsbdb** (`api.adsbdb.com`) | Aircraft type, model name and registration by ICAO hex for enriched flights; airline and origin/destination airports for the tracked flight's callsign | No licence or rate limit is published for the service. Its own credits: aircraft data from PlaneBase, ICAO-to-N-number conversion by Guillaume Michel, and flight route data that "is the work of David Taylor, Edinburgh and Jim Mason, Glasgow, and may not be copied, published, or incorporated into other databases without the explicit permission of David J Taylor, Edinburgh" | "adsbdb, api.adsbdb.com" (courtesy); route data credited to David Taylor, Edinburgh, and Jim Mason, Glasgow |
| **AISStream.io**                                                      | Live vessels (AIS)                                                                                                                  | Free, beta, no formal ToS; AIS is a public broadcast                                                                                                                                                                                                                                                                                                  | "AISStream.io" (courtesy)                                                                                                                   |
| **CelesTrak**                                                         | Satellite TLEs (SGP4)                                                                                                               | US-government-origin data, no license; citation requested                                                                                                                                                                                                                                                                                             | "CelesTrak (celestrak.org), Dr. T.S. Kelso"                                                                                                 |
| **The Space Devs, Launch Library 2 v2.3**                            | Recent launch, payload, stage, and recovery metadata for Space Missions (30d)                                                       | [The Space Devs terms of use](https://github.com/TheSpaceDevs/Tutorials/blob/main/faqs/faq_TSD.md#terms-of-use): data may be used and shared in any form; avoid forwarding it without added value; attribution is encouraged (not mandatory). [Official API limits](https://ll.thespacedevs.com/docs/): 15 unauthenticated calls/hour; optional token | "Launch Library 2, The Space Devs" (courtesy attribution)                                                                                  |
| **Esri World Imagery** (ArcGIS Online tile service)                   | The keyless satellite basemap, the default landing when no Google/ion credential is configured, and the "Esri Satellite" map stack | [Esri Master Agreement](https://www.esri.com/en-us/legal/terms/full-master-agreement): the public World Imagery service is usable in public-facing apps with attribution; no key is required for this classic endpoint, but Esri governs and can change access; an app at scale should review current ArcGIS Location Platform terms                 | "Powered by Esri, Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community" (provider carries the service's own credit line) |
| **USGS**                                                              | Earthquakes                                                                                                                         | U.S. public domain                                                                                                                                                                                                                                                                                                                                    | "Data courtesy of the U.S. Geological Survey"                                                                                               |
| **OpenStreetMap (Overpass API)**                                      | Road geometry for traffic                                                                                                           | ODbL 1.0                                                                                                                                                                                                                                                                                                                                              | "© OpenStreetMap contributors"                                                                                                              |
| **TomTom Traffic API** (flow vector tiles)                            | Live congestion coloring for the traffic layer (optional, BYOK)                                                                     | [TomTom for Developers terms](https://developer.tomtom.com) (proprietary, your own key; free tier currently 200K tile requests/month, see [current pricing](https://docs.tomtom.com/pricing/))                                                                                                                                                       | "Traffic flow data © TomTom", registered when live mode activates                                                                          |
| **OpenStreetMap (Overpass API)**                                      | Viewport-bounded mapped installation context for Global Context                                                                     | ODbL 1.0                                                                                                                                                                                                                                                                                                                                              | "© OpenStreetMap contributors" (incomplete mapped context)                                                                                  |
| **Photon** (komoot)                                                   | Keyless place search, the fallback when no Google Maps key is configured, or when Google declines the Geocoding request            | Service: free public instance, [fair use](https://photon.komoot.io) (no bulk/heavy use); underlying data: **ODbL 1.0**                                                                                                                                                                                                                                | "Photon (komoot)" + "© OpenStreetMap contributors"                                                                                          |
| **OpenStreetMap (Nominatim)**                                         | Reverse-geocoded place label in the cockpit Local Info page, and last-resort forward place search via `/api/geocode` when Google and Photon do not answer | ODbL 1.0 + [Nominatim usage policy](https://operations.osmfoundation.org/policies/nominatim/) (maximum 1 request/second, results cached, identifying User-Agent) | "© OpenStreetMap contributors"                                                                                                              |
| **Open-Meteo**                                                        | Current weather in the cockpit Local Info page and cockpit-local dynamic atmospheric effects                                        | [CC BY 4.0 data licence and adjacent-link attribution requirement](https://open-meteo.com/en/licence)                                                                                                                                                                                                                                                 | Linked "Weather data by Open-Meteo.com" beside the displayed local data                                                                     |
| **Google News RSS**                                                   | Primary locality-matched headlines in the cockpit Regional News page                                                                | [Google News Terms of Service](https://www.google.com/intl/en_us/terms_google_news.html) restrict use to personal, noncommercial use; linked articles remain third-party publisher content and retain publisher terms                                                                                                                                 | "Google News RSS" plus each article's linked publisher/domain                                                                               |
| **GDELT Project DOC 2.0**                                             | Fail-soft fallback for location-matched cockpit headlines                                                                           | [GDELT Terms of Use](https://www.gdeltproject.org/about.html#termsofuse): unrestricted academic/commercial/governmental dataset use, with citation and link required; linked articles retain publisher terms                                                                                                                                          | "GDELT Project" plus each article's linked publisher/domain                                                                                 |
| **City of Austin Open Data**                                          | CCTV camera catalog + frames                                                                                                        | City of Austin Open Data Terms of Use                                                                                                                                                                                                                                                                                                                 | "City of Austin, TX, data.austintexas.gov"                                                                                                 |
| **TxDOT ITS (its.txdot.gov)**                                         | CCTV camera catalogs + frames, Texas districts                                                                                      | Public TxDOT traffic camera data                                                                                                                                                                                                                                                                                                                      | "Texas Department of Transportation" (courtesy)                                                                                             |
| **City of Tallinn (ristmikud.tallinn.ee)**                            | CCTV camera catalog + frames, Tallinn intersections                                                                                 | Public City of Tallinn traffic camera data                                                                                                                                                                                                                                                                                                            | "City of Tallinn, ristmikud.tallinn.ee" (courtesy)                                                                                         |
| **Transpordiamet / Tarktee**                                          | CCTV camera catalog + frames, Estonia road-weather cameras                                                                          | Public Transpordiamet / Tarktee road camera data                                                                                                                                                                                                                                                                                                      | "Transpordiamet / Tarktee, tarktee.transpordiamet.ee" (courtesy)                                                                           |
| **Stadt Warendorf webcam**                                            | Webcam frames, Marktplatz / Historisches Rathaus (`config/cctv_sources.warendorf.json`)                                             | Public municipal webcam data                                                                                                                                                                                                                                                                                                                          | "Stadt Warendorf, webcam.warendorf.de" (courtesy); mount and heading derived from OSM geometry, "© OpenStreetMap contributors" (ODbL)      |
| **Live Traffic NSW (Transport for NSW)**                              | CCTV camera catalog + frames, New South Wales                                                                                       | [CC BY 4.0](https://opendata.transport.nsw.gov.au/), attribution REQUIRED                                                                                                                                                                                                                                                                            | "Live Traffic NSW, Transport for NSW"                                                                                                      |
| **Caltrans (cwwp2.dot.ca.gov)**                                       | CCTV camera catalogs + frames, California districts                                                                                 | Public Caltrans traffic camera data                                                                                                                                                                                                                                                                                                                   | "Caltrans, cwwp2.dot.ca.gov" (courtesy)                                                                                                    |
| **TfL Open Data (JamCams)**                                           | CCTV camera catalog + frames, London                                                                                                | [TfL Open Data terms](https://tfl.gov.uk/info-for/open-data-users/), attribution REQUIRED                                                                                                                                                                                                                                                            | "Powered by TfL Open Data. Contains OS data © Crown copyright and database rights"                                                          |
| **Ontario 511**                                                       | CCTV camera catalog + frames, Ontario highways including Kitchener-area routes                                                      | [Open Government Licence, Ontario](https://www.ontario.ca/page/open-government-licence-ontario)                                                                                                                                                                                                                                                      | "Ontario 511" plus Open Government Licence - Ontario                                                                                        |
| **Fintraffic / Digitraffic (weathercams)**                            | CCTV camera catalog + frames, Finland                                                                                               | [CC BY 4.0](https://www.digitraffic.fi/en/terms-of-service/), attribution REQUIRED                                                                                                                                                                                                                                                                   | "Fintraffic / digitraffic.fi, license CC BY 4.0"                                                                                            |
| **DriveBC** (Government of British Columbia)                          | CCTV camera catalog + frames, British Columbia highways                                                                             | [Open Government Licence, British Columbia](https://www2.gov.bc.ca/gov/content/data/open-data/open-government-licence-bc), attribution REQUIRED                                                                                                                                                                                                     | "DriveBC. Contains information licensed under the Open Government Licence, British Columbia"                                               |
| **Open Calgary** (`data.calgary.ca`)                                  | CCTV camera catalog + frames, Calgary                                                                                               | [Open Government Licence, City of Calgary](https://data.calgary.ca/stories/s/Open-Calgary-Terms-of-Use/u45n-7awa), attribution REQUIRED                                                                                                                                                                                                             | "Contains information licensed under the Open Government Licence, City of Calgary"                                                         |
| **GBFS (Lyft / BCycle)**                                              | Bikeshare availability                                                                                                              | Per-feed (attribution-only)                                                                                                                                                                                                                                                                                                                           | Credit the operator (e.g. Austin BCycle) + its `license_url`                                                                                |
| **MBTA / MassDOT** (cdn.mbta.com) | Transit layer live vehicles and up to 15 minutes of recently observed positions, Greater Boston | MBTA / MassDOT open realtime vehicle data, used for the live view and up to fifteen minutes of recently observed positions; published for developer use and not against their use. | Attribution to MBTA / MassDOT (courtesy text) |
| **CapMetro** (data.texas.gov) | Transit layer live vehicles, Austin TX | CapMetro open realtime vehicle data, used for the live view; published for developer use and not against their use. | Attribution to CapMetro (courtesy text) |
| **Metro Transit** (Metropolitan Council) | Transit layer live vehicles, Minneapolis-St Paul | Metro Transit / Metropolitan Council open realtime vehicle data, used for the live view; published for developer use and not against their use. | Attribution to Metro Transit / Metropolitan Council (courtesy text) |
| **OVapi / Stichting OpenGeo** | Transit layer live vehicles, Netherlands | OVapi / Stichting OpenGeo open realtime vehicle data, used for the live view; published for developer use and not against their use. The client sends a User-Agent and conditional requests. | Attribution to OVapi / Stichting OpenGeo (courtesy text) |
| **Entur** (api.entur.io) | Transit layer live vehicles, Norway | Entur open realtime vehicle data, used for the live view; published for developer use and not against their use. The client sends the `ET-Client-Name` identifying header. | Attribution to Entur (courtesy text) |
| **TransLink** (Queensland Government) | Transit layer live vehicles, South East Queensland | TransLink / Queensland Government open realtime vehicle data, used for the live view; published for developer use and not against their use. | Attribution to TransLink / Queensland Government (courtesy text) |
| **HSL** (realtime.hsl.fi) | Transit layer live vehicles, Helsinki | HSL (Helsinki Region Transport) open realtime vehicle data, used for the live view; published for developer use and not against their use. | Attribution to HSL (Helsinki Region Transport) (courtesy text) |
| **Radio Browser**                                                     | Geolocated internet-radio station directory and station-level tags                                                                  | Public-domain directory data under PDDL 1.0; individual broadcaster stream terms apply                                                                                                                                                                                                                                                                | "Radio Browser" plus a link to the selected broadcaster                                                                                     |
| **Re:Earth Terrain** (Mapterhorn)                                     | Terrain (keyless globe stacks, OSM etc., + `/api/terrain/heights` ellipsoidal-height lookups)                                     | Terrain mesh: CC BY 4.0; geoid: EGM2008 (NGA, public domain)                                                                                                                                                                                                                                                                                          | "Terrain (keyless globe stacks): Re:Earth Terrain / Mapterhorn (CC BY 4.0) / EGM2008 (NGA)"                                                 |
| **OSRM on the FOSSGIS routing servers** (`routing.openstreetmap.de`) | Street-following routes for the Directions layer and voice route annotations, via `/api/route` | [FOSSGIS routing usage policy](https://routing.openstreetmap.de/about.html): "Display the required attribution and display a link to 'fix the map'", "Use a valid user agent and, if applicable, a correct referrer", "One request per second max", "No scraping, no heavy usage". The full policy is the German [FOSSGIS Nutzungsbedingungen](https://www.fossgis.de/arbeitsgruppen/osm-server/nutzungsbedingungen/); FOSSGIS also states that the server may be embedded in your own pages but "eine gewerbliche Nutzung ist nur mit Einschränkungen erlaubt" (commercial use only with restrictions). Route data derives from OpenStreetMap (ODbL 1.0) | "Routing: OSRM on the FOSSGIS servers" + "© OpenStreetMap contributors" + a "fix the map" link, shown in the Data attribution popover |

### Notes on the live sources

- **Google Maps Platform.** You supply your own API key and are bound by [Google's ToS](https://cloud.google.com/maps-platform/terms). Google Maps Content (tiles, geocodes, places) **may not be cached, stored, rehosted, or committed**; this app only ever uses it live, which is the compliant pattern. The "Google" attribution is displayed on the globe and must stay visible. Restrict your key (see [SECURITY.md](SECURITY.md)).
- **OpenSky Network, adsb.lol, and AISStream are upstream extras, off by default in this fork.** The globe's flight-tracking (OpenSky, its adsb.lol fallback, and adsbdb enrichment) and AIS vessel-tracking routes are not used by the CRE screening interface, so `server/providers/local.js` does not mount them unless the operator sets `GEV_ENABLE_UPSTREAM_EXTRAS=1`. Enabling them is the operator's own call on each source's terms below, in particular OpenSky's non-commercial license.
- **OpenSky Network.** Its license is **non-commercial**, and operational use of the REST API in a live product can require a prior written agreement with OpenSky, even for non-profit/government use. If you deploy this commercially, contact OpenSky for your own terms. The flights layer is a toggle and runs anonymously by default.
- **adsb.lol flight fallback.** When OpenSky is unavailable and no last-good OpenSky response exists, the server requests a cached, capped 250 nm adsb.lol point snapshot around the current camera subpoint. This is regional observed context, not worldwide completeness; provenance is exposed in the Flights stats/context row. Military ICAOs remain reconciled through the existing dedicated military registry rather than duplicated.
- **adsbdb enrichment.** `/api/adsbdb` resolves an ICAO hex to aircraft type, model name and registration, and the tracked flight's callsign to an airline and an origin/destination pair. Fan-out is deliberately small because adsbdb is a free community API that publishes no quota: at most 4 requests in flight, dispatches dripped to roughly 5/s, and each key asked for at most once per session, with route lookups reserved for the tracked aircraft. The dev-server proxy caches each key for 24 hours in `.gev-cache/adsbdb.json`, negative answers included, so fresh entries survive server restarts. That gitignored cache remains local to the deployment and is not bundled with this repo. adsbdb publishes no general service license; its README says the route data may not be copied, published, or incorporated into other databases without the explicit permission of David J Taylor, Edinburgh. Deployers are responsible for obtaining any permission their use requires. Enrichment is best-effort and fail-silent; a flight that gets no answer keeps what the flight feed already gave it.
- **Launch Library 2.** `/api/launches` makes a server-side rolling-30-day query against the supported v2.3 detailed launch endpoint, caches successful responses for 15 minutes in memory and on disk, and serves the last successful response during a throttle or transient outage. Anonymous access is limited to 15 calls/hour; deployments can provide `LL2_API_TOKEN` for authenticated access. The Space Devs' published terms permit using and sharing the API data in any form, ask users not to forward it without adding value, disclaim complete accuracy, and encourage, but do not require, attribution. This app keeps a courtesy credit. Payload and stage/recovery records are shown only when supplied. Failed launches expose their source status and never receive fallback orbit geometry or a live/estimated marker. LL2 supplies launch context and event timing, not continuous ascent telemetry or live orbital state.
- **TfL JamCams.** The camera list comes from the keyless `api.tfl.gov.uk` endpoint (an optional `TFL_APP_KEY` raises its rate limit); frames come from TfL's public S3 bucket. The "Powered by TfL Open Data" attribution is required by TfL's terms and is registered in the Data attribution popover.
- **Ontario 511 CCTV.** The camera list comes from the keyless `511on.ca/api/v2/get/cameras` endpoint; frames are server-registered still images under `511on.ca/map/Cctv/`. The source is live-fetched at runtime and attributed under the Open Government Licence - Ontario.
- **Fintraffic weathercams.** The camera list is one keyless GeoJSON request to `tie.digitraffic.fi/api/weathercam/v1/stations` (809 stations / 2,275 presets), sent with the `Digitraffic-User: gods-eye-view` header the service asks clients to identify themselves with and with gzip; frames are stills on `weathercam.digitraffic.fi`, refreshed on each station's 600 s collection interval, which is also the client's ambient-still refresh cadence for this pack (the active camera keeps the usual 10-second refresh). One preset (a fixed camera view) is one camera; stations not `GATHERING` and presets not `inCollection` are dropped. Attribution is required by the CC BY 4.0 licence and is registered in the Data attribution popover. `CCTV_FINTRAFFIC_ENABLED=0` is the kill switch.
- **DriveBC highway cameras.** The camera list comes from the keyless `https://www.drivebc.ca/api/webcams/` endpoint served by the DriveBC.ca site ([bcgov/DriveBC.ca](https://github.com/bcgov/DriveBC.ca)); frames come from `https://www.drivebc.ca/images/<id>.jpg`, built from the numeric camera id. DataBC's [DriveBC HighwayCams](https://catalogue.data.gov.bc.ca/dataset/bc-highwaycams) catalogue entry publishes the same cameras under the Open Government Licence, British Columbia, but its CSV still lists the retired `images.drivebc.ca` frame URLs, which now return a placeholder. The licence's attribution statement is required and is registered in the Data attribution popover. By default the 250 cameras nearest Vancouver and Victoria load; `CCTV_DRIVEBC_MAX_SOURCES` changes the cap and `CCTV_DRIVEBC_ENABLED=0` turns the pack off. Some cameras in the feed are supplied by partners (TransLink, the City of Vancouver, the City of Surrey, Parks Canada / Alberta Motor Association and others); the feed's per-camera credit is carried onto the camera record and shown beside the provider in the CCTV panel.
- **TxDOT ITS cameras.** The catalog comes from the keyless `its.txdot.gov/its/DistrictIts/GetCctvStatusListByDistrict` endpoint, one call per district. Frames come from the per-camera `GetCctvSnapshotByIcdId` endpoint, which answers JSON carrying a base64 JPEG rather than an image body; the proxy decodes it only for responses from the official TxDOT origin and validates the JPEG header before serving. Only cameras reporting `Device Online` are registered. Districts default to Austin and San Antonio (`CCTV_TXDOT_DISTRICTS`; 25 codes exist statewide); `CCTV_TXDOT_MAX_SOURCES` caps the pack and `CCTV_TXDOT_ENABLED=0` turns it off. Frames are fetched live at request time and are never stored or redistributed.
- **Tallinn ristmikud.** Intersection camera stills are fetched live from `ristmikud.tallinn.ee` (`/last/camNNN.jpg`). The curated catalog (`config/cctv_sources.tallinn.json`) supplies coordinates and heading priors; only server-registered ristmikud HTTPS URLs are proxied. Frames are fetched at request time and never stored or redistributed. Disable with `CCTV_TALLINN_ENABLED=0`.
- **Tarktee / Transpordiamet.** Estonia road-weather camera locations and current JPEG URLs come from keyless DATEX2 endpoints on `tarktee.transpordiamet.ee` (`/api/v1/datex/roadCameraLocations` + `roadCameraImages`). Frame URLs rotate with each capture; the 15-minute CCTV source cache refreshes them. Only `https://tarktee.transpordiamet.ee/images/…` URLs are registered. Disable with `CCTV_TARKTEE_ENABLED=0`.
- **Warendorf webcam.** The Stadt Warendorf Marktplatz webcam, registered from the curated `config/cctv_sources.warendorf.json` (the Kreis Warendorf registration-office cameras from the contributing PR are indoor waiting rooms and were left out); only the municipal image host is proxied, frames are fetched at request time and never stored or redistributed. Disable with `CCTV_WARENDORF_ENABLED=0`.
- **Live Traffic NSW cameras.** The camera list is the keyless public `data.livetraffic.com/cameras/traffic-cam.json` feed (Transport for NSW open data, CC BY 4.0); frames are stills on `webcams.transport.nsw.gov.au`, and only that host is registered. That image host answers non-browser clients with an HTML placeholder, so the proxy identifies as a browser for that one host and as itself everywhere else. Frames are fetched at request time and never stored or redistributed. Disable with `CCTV_NSW_ENABLED=0`.
- **Open Calgary traffic cameras.** Keyless. The camera list is the public Socrata dataset `k7p9-kppz` on `data.calgary.ca`; frames are stills on the city's own `trafficcam.calgary.ca` host, and only that host is registered. Most rows publish an `http://` frame URL and the host redirects those to HTTPS, so URLs are upgraded and pinned to that origin before registration. Frames are fetched at request time and never stored or redistributed. The dataset publishes no camera facing: the `quadrant` field and the quadrant suffix on each camera name are Calgary's address grid, not a bearing, so headings use the shared id-hash fallback at low confidence and are corrected with the in-app calibration gizmo. The licence requires the attribution statement above. Disable with `CCTV_CALGARY_ENABLED=0`.
- **Camera frame content.** Public camera frames can contain people, vehicles and license plates, and the camera layer does nothing with them beyond putting them on the map. A successful upstream response is relayed as the provider served it: nothing in the camera pipeline blurs, redacts, enhances or restores it, and nothing there runs face, plate or object detection or otherwise recognises or classifies what is in the picture. (The ALPR layer described below maps where plate-reader cameras are, from locations contributors tagged in OpenStreetMap; it reads nothing from any camera frame.) When an upstream has no frame for a camera, what you see instead is a Google Street View still or the app's own placeholder card; the panel's source badge names which of them you are looking at, and a refresh that fails after a frame has arrived leaves the last good picture on screen rather than replacing it. The browser resamples each frame for display: onto a fixed 1920x1080 surface for the camera's projection plane in the scene, and onto a 192x108 canvas for the small ambient card. That scaling is the only change made to the picture, and the only pixels the camera layer reads back are a 64x36 downscale hashed to tell whether the picture has changed. Live streams are piped through; the still path reads the image into memory to pass it on (TxDOT wraps its JPEG in a JSON envelope, which is decoded there), and no frame is written to disk (the disk cache, `.gev-cache/`, holds feed JSON for other layers and never camera imagery). Outside that pipeline, the voice assistant is the one feature that sends imagery anywhere: when it answers a question about what is in view it may attach a downscaled screenshot of the rendered scene (including any camera plane on screen) to the request it sends to the voice model. Frames are fetched only from server-registered camera URLs; a client cannot hand the proxy a URL (see [SECURITY.md](SECURITY.md)). What the app does stays inside the line README draws: no named-person search, no face recognition, no tracking individuals.
- **Transit (GTFS-Realtime).** The proxy requests only registered operator feeds, validates redirects, bounds responses, and uses conditional requests, short snapshot caching and failure backoff. All seven registered regions are live-enabled; each can be disabled independently. Vehicles use delayed playback between reports, with report age and waiting states shown separately. Session-local selected trails are available for every feed. MBTA additionally retains up to 15 minutes of recently observed positions in the running proxy, so available history can survive a browser reload; server restart clears it. History reads never fetch upstream, and other feeds have no proxy retention. Nothing is archived to disk or collected in the background. Operator text credits are included as a courtesy and do not imply endorsement. Heights are aligned to work with Google 3D tiles; subway markers are shown at street level because these feeds do not supply depth.
- **Radio Browser.** `/api/radio/stations` discovers official API mirrors, makes bounded and coalesced healthy/geolocated HTTPS-station queries, caches the normalized public-domain directory for 45 minutes, and may serve the last good catalog for up to seven days during an outage. Refreshes must meet minimum accepted-query and station coverage before replacing a warm catalog; schema-valid responses whose rows all fail the product's health policy do not count as successful queries. A usable partial cold catalog is explicitly `DEGRADED`, and malformed or empty successful payloads are rejected atomically. Every directory and click-count request rejects redirects, validates all resolved addresses as globally routable (including reserved/documentation IPv4 and special/non-global IPv6 exclusions), and pins the TLS connection to a validated address. Only MP3/AAC non-HLS directory rows with public HTTPS stream targets are returned; favicons are intentionally omitted. Pressing play connects one browser audio element directly to the selected broadcaster and calls the directory's click counter through known-ID-only `POST /api/radio/click/:uuid`. GEV never proxies, caches, records, bundles, or redistributes audio. Radio Browser supplies station-level tags, not dependable current-song or upcoming-program metadata, so Radio filtering never claims either. Direct playback exposes the listener's IP address to the broadcaster, whose own stream terms apply.
- **TomTom Traffic.** Optional and BYOK: without `TOMTOM_API_KEY` the traffic layer runs its built-in simulation and no TomTom data (or attribution) appears. With a key, flow vector tiles are fetched through the server-side `/api/tomtom` proxy (120 s cache + a daily tile-budget governor: `TOMTOM_DAILY_TILE_BUDGET`, default 6,000, sized so a 31-day month stays inside TomTom's 200K monthly free allowance; still a configurable application safety ceiling, not a guarantee; TomTom's [current pricing](https://docs.tomtom.com/pricing/) lists 200K free tile requests per month) and the "Traffic flow data © TomTom" credit is registered in the Data attribution popover the moment live mode activates. TomTom data is served live and cached only transiently (≤120 s TTL under `.gev-cache/`, gitignored); it is not bundled or redistributed. One 23 KB point-in-time tile snapshot is committed as a decode-test fixture (`src/data/fixtures/`, © TomTom, never served to the app).
- **Routing (OSRM / FOSSGIS).** `/api/route` proxies the public OSRM instances FOSSGIS e.V. runs for the OpenStreetMap community (car, bike, foot profiles). They are keyless and intended for fair, interactive use; the proxy rate-limits clients (60/min, 200/min total), caps route span and response size, caches each route for 10 minutes, and identifies itself in the User-Agent. Heavy or automated use must run its own OSRM. Routes are computed from OpenStreetMap data (ODbL); the Directions layer and voice routes never redistribute them. A route the router cannot find is reported as such; the Directions layer draws nothing in that case, and voice routes fall back to a clearly labeled straight line.
- **Re:Earth Terrain.** Keyless (no API key). Used two ways: (1) `src/mapStackController.js` swaps in a `Cesium.CesiumTerrainProvider` pointed at Re:Earth's `cesium-mesh/ellipsoid` quantized-mesh endpoint for globe stacks without a Cesium ion token (e.g. OSM), replacing a flat `EllipsoidTerrainProvider`; falls back to the flat provider if the endpoint can't be reached. (2) The server-side `/api/terrain/heights` proxy (disk-cached, serve-stale) resolves per-point ellipsoidal ground height for entity placement. Both are best-effort with a keyless-safe fallback (bundled EGM96 geoid math) if Re:Earth is unreachable.
- **OSRM on the FOSSGIS routing servers.** Keyless (no API key). Every route is requested by a person: clicking A and B in the Directions layer, or a voice "route from A to B". The server-side `/api/route` proxy sends an identifying `User-Agent`, pins the upstream host, accepts 2-12 coordinates, rejects any leg over 600 km or a total over 2,500 km, caps the buffered response at 8 MB, times the upstream out at 12 s, rate-limits per client, caches each route for 10 minutes, and coalesces identical requests that are in flight at the same time. Turn-by-turn maneuvers are asked for only when a caller wants them (`steps=1`), so the callers that do not read them send the smaller request. The "fix the map" link the policy asks for is in the Data attribution popover beside the OpenStreetMap credit.
- **Global Context installation context.** `/api/military-installations` queries only an allow-listed subset of OSM `military=*` and `landuse=military` features inside a maximum 10° non-dateline viewport. It caches and may serve stale mapped context, but it is neither a global installation database nor evidence of capability, activity, or absence. User-requested Google Places results remain separately sourced candidates unless their returned types explicitly establish military classification; generic offices, museums, and similarly ambiguous matches are excluded from military proximity counts.
- **Place search.** Named-place fly-to uses Google Geocoding when a Maps key is configured, then Photon's public instance, then `/api/geocode` (Nominatim search) when neither answers. `/api/geocode` shares the cockpit's Nominatim queue at no more than one request per second, sends an identifying `User-Agent` and `Referer`, caches answers for five minutes, shares one upstream call between identical searches already in flight, bounds the queue so a burst is refused rather than held, and drops a queued search whose caller has given up. It asks for one result per search and is not used for systematic or bulk queries.
- **Cockpit regional briefing.** `/api/regional-brief` rounds aircraft coordinates into 0.1° cache cells, caches results for five minutes, and serializes Nominatim calls at no more than one request per second. Google News RSS is queried with the resolved locality/region first; GDELT is used only when that RSS query fails or is empty. Google's published Google News terms restrict that source to personal, noncommercial use, so commercial deployments must disable/replace it or obtain separate permission; GDELT permits commercial dataset use with citation. The Data attribution popover identifies the active headline sources; article links retain publisher attribution. Headlines are location-query matches, not verified incidents, risk rankings, or evidence that a location is safe. Empty, partial, stale, and unavailable source states remain distinct. Open-Meteo supplies current conditions independently of the news source. `WX OFF` disables cockpit weather rendering only; the Local Info briefing still fetches its source-backed weather values and displays the required linked Open-Meteo credit.
- **Dynamic weather presentation.** While cockpit mode is active, `/api/weather-effects` requests current Open-Meteo observations for the aircraft/camera location, rounds coordinates into 0.1° cache cells, caches results for five minutes, and may retain a stale observation for up to 30 minutes during a transient outage. WMO condition code selects the visual family; observed cloud cover, precipitation, visibility, wind speed, and wind direction bound its strength and motion. Missing or expired weather renders no synthetic atmospheric effect, and normal globe view never renders the weather overlay.

---

## Bundled snapshots

Static datasets shipped in the repo for an out-of-the-box experience. **None are MIT**; each keeps its own license (see the carve-out in [LICENSE](LICENSE)). Each folder also has its own provenance README.

The current source tree and build exclude the former Bhote Koshi event imagery and GeoPera-derived river centerline, and exclude the former TeleGeography submarine-cable snapshot. Earlier Git commits retain those noncommercial assets; the project history has not been rewritten. Their original terms continue to apply to those historical copies. The supported clone command uses `--depth 1` so it retrieves only the current asset-free tree. Other snapshots below are under `src/data/local_data/`.

| Dataset                                                                     | Folder                            | License                                                                                                   | Commercial use?                                  | Attribution                                                                 |
| --------------------------------------------------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------- |
| **Datacenters** (~4.3K)                                                     | `datacenters/`                    | **ODbL 1.0** (OpenStreetMap extract)                                                                      | Yes (attribution + share-alike on data)           | "© OpenStreetMap contributors"                                              |
| **Dams** (704)                                                              | `dams/`                           | **ODbL 1.0** (OpenInfraMap / OSM extract)                                                                 | Yes (attribution + share-alike on data)           | "© OpenStreetMap contributors" (+ Open Infrastructure Map)                  |
| **Natural Earth physical regions** (1,046 land + 292 marine named polygons) | `natural_earth/`                  | **Public domain**                                                                                         | Yes (no restrictions)                             | "Made with Natural Earth" (courtesy credit, not legally required)          |
| **DataSF Analysis Neighborhoods** (41 SF neighborhood polygons)             | `neighborhoods/`                  | **PDDL 1.0** (public domain)                                                                              | Yes (no restrictions)                             | "City & County of San Francisco, DataSF" (courtesy, not legally required) |
| **CCTV ground heights** (3,445 cameras)                                     | `cctv_ground_heights/`            | Precomputed camera placement heights, aligned to work with Google Photorealistic 3D Tiles (folder README) | N/A                                                | N/A                                                                          |

### Previously bundled restricted datasets

The removed TeleGeography submarine-cable GeoJSON was licensed under
**CC BY-NC-SA 3.0** and is not covered by the application's MIT license. It is
absent from the current tree and CRE build. Earlier Git commits retain copies,
which remain subject to that license. Attribution: "© TeleGeography,
submarinecablemap.com". See [TeleGeography's Submarine Cable
Map](https://www.submarinecablemap.com/) for current data and licensing.

The removed Bhote Koshi imagery crops and GeoPera-derived centerline were
licensed under **CC BY-NC 4.0**. They are absent from the current tree and CRE
build; historical Git copies remain subject to that license. The linked
witness posts and public geolocation records retain their respective owners'
terms. This project does not rewrite history or grant additional rights to
historical copies.

### ALPR camera mapping

The optional ALPR layer queries OpenStreetMap nodes tagged `man_made=surveillance`
and `surveillance:type=ALPR` (including case-insensitive semicolon multi-values)
through the shared Overpass proxy. Source/tag reference:
[OSM ALPR tagging](https://wiki.openstreetmap.org/wiki/Tag:surveillance:type%3DALPR).
No DeFlock software, branded assets or separate database is bundled. The layer
shows contributor-supplied locations and tags, not plate records, camera video,
current operating status, or exhaustive coverage. All manufacturers share the
ALPR category and marker color. Manufacturer, operator and camera type are shown
only when tagged, not inferred or independently verified. Every selected card
names OpenStreetMap in a smaller, muted source line beneath those details.

Queries are limited to a city-scale viewport (at most 3° per axis), at most
1,500 returned nodes, with outward-snapped query reuse and explicit stale/limited
coverage notices. A linked © OpenStreetMap credit appears for five
seconds when camera locations first display after enabling, then collapses;
Data attribution retains the full source/license entry, following the
[OSMF interactive-map guidance](https://osmfoundation.org/wiki/Licence/Attribution_Guidelines).
OSM data remains separately attributed under ODbL; querying
at runtime does not replace the license obligations. ODbL permits commercial
use and does not license the application code. If publicly using a derivative
database, follow its share-alike and access requirements; keep independent
datasets separate rather than treating the whole collection as MIT data.
Overpass hosting capacity and usage policies are separate from the data license.

### ODbL share-alike (datacenters, dams)

The OSM-derived datasets are under the **Open Database License**. ODbL's share-alike applies to the **data / derived database, not this MIT-licensed code**; the two coexist (exactly how Open Infrastructure Map ships: MIT software + ODbL data). If you publicly distribute a _modified_ version of these databases, you must offer it under ODbL. Keep the "© OpenStreetMap contributors" notice (link: https://www.openstreetmap.org/copyright).

### NASA FIRMS acknowledgement

> We acknowledge the use of data and/or imagery from NASA's Fire Information for Resource Management System (FIRMS) (https://earthdata.nasa.gov/firms), part of NASA's Earth Observing System Data and Information System (EOSDIS).

FIRMS active fires are **fetched live at runtime** (CC0 / U.S. public domain data): the
`/api/firms` server-side proxy merges the three VIIRS NRT sources (NOAA-20, NOAA-21,
Suomi-NPP) clamped to the trailing 24 h, cached 30 min to respect the shared MAP_KEY
transaction quota. Requires a free `FIRMS_MAP_KEY`
(https://firms.modaps.eosdis.nasa.gov/api/map_key/); the layer is empty without it.
The former bundled 2026-05-25 snapshot was removed 2026-07-16.

### Natural Earth physical regions (`natural_earth/`)

Curated from the **Natural Earth 10m physical vectors** (https://www.naturalearthdata.com/,
fetched from the canonical `nvkelso/natural-earth-vector` GitHub repo, commit
`ca96624a56bd078437bca8184e78163e5039ad19`, 2026-07-28): `ne_10m_geography_regions_polys`
(mountain ranges, deserts, plateaus, peninsulas, islands, …) → `regions.json` and
`ne_10m_geography_marine_polys` (seas, gulfs, straits, bays) → `marine.json`. They back the
voice-annotation resolver's named-natural-region lookup (`src/data/naturalEarthRegions.js`),
so "outline the Alps" draws the real range polygon offline.

Curation (provenance in each file's `meta` header): named features only, outer rings only,
Douglas-Peucker simplified at ~0.01° with coordinates rounded to 3 decimals, sub-20 km²
MultiPolygon crumbs and zero-area sliver artifacts dropped (7.3 MB source → 2.5 MB pack).

Natural Earth is **public domain** (no permission needed, no attribution legally required;
see https://www.naturalearthdata.com/about/terms-of-use/). We credit anyway: "Made with Natural
Earth". Registration in the in-app `dataCredits.js` attribution list ships with the resolver
wiring (see below).

### DataSF Analysis Neighborhoods (`neighborhoods/`)

`neighborhoods/san-francisco.json` bundles the City & County of San Francisco's official
**"Analysis Neighborhoods"** dataset (41 neighborhood polygons; DataSF dataset `j2bu-swwd`,
catalog map view
[`p5b7-5n3h`](https://data.sfgov.org/Geographic-Locations-and-Boundaries/Analysis-Neighborhoods-Map/p5b7-5n3h)).
It backs the voice-annotation resolver's offline neighborhood-boundary lookup
(`src/data/neighborhoodPolygons.js`), so "outline Chinatown" draws the city's real
boundary polygon with no network dependency.

The dataset is licensed **PDDL 1.0** (Open Data Commons Public Domain Dedication and
License, public domain; the DataSF metadata declares `licenseId: "PDDL"`). No attribution
is legally required; we note the source here and in the folder's `SOURCE.md`, which records
the retrieval date (2026-07-30), exact download URL, license evidence, and the
deterministic transform (`scripts/build-sf-neighborhoods.mjs`: `nhood` → `name`, ~2 m
Douglas-Peucker simplification, 6-decimal rounding).

---

## In-app attribution

The required Google Maps / Cesium credit renders on the on-globe credit line (`#cesium-credits`, bottom-left) and must stay visible (including in clean-view and recording modes) (the whole line, logo + "Google Maps" + the "Data attribution" link, stays on screen; only the GEV panels/HUD fade). Current layer-specific credits (adsb.lol, adsbdb, OSM datacenters/dams/roads, NASA FIRMS, CelesTrak, USGS, City of Austin, Fintraffic, GBFS, Radio Browser, OpenSky, AISStream) are registered into the expandable **"Data attribution"** popover on that credit line via `viewer.creditDisplay.addStaticCredit(new Cesium.Credit(html, /* showOnScreen */ false))`; see `src/data/dataCredits.js`. When you add a new data source, add its license and attribution to this file **and** append an entry to `DATA_CREDITS` in `src/data/dataCredits.js` so it surfaces in the app.

---

## gods-eye-cre site dossier sources (CRE mode)

The site dossier (default `?mode=cre`) calls these sources from the dev server under
`/api/cre/<family>`; nothing is stored in this repo. Endpoints, live probes and caveats are
in [`docs/cre/SOURCES.md`](docs/cre/SOURCES.md). Each dossier section also prints its own
source line and retrieval time.

| Source | Dossier section | Key | License / terms | Attribution |
| --- | --- | --- | --- | --- |
| **US Census Geocoder** | Address search, location | none | public domain | "U.S. Census Bureau" |
| **Census ACS 5-year + TIGERweb** | Demographics (tract and 1, 3, 5 mile rings) | `CENSUS_API_KEY` (optional; improves rate limits) | CC0 / public domain | "U.S. Census Bureau, American Community Survey" |
| **LEHD LODES8 WAC** | Jobs within 3 miles, top sectors | none | public domain | "U.S. Census Bureau LEHD" |
| **BLS QCEW and LAUS** | County employment, wages, unemployment | none | public domain | "U.S. Bureau of Labor Statistics" |
| **Census Building Permits Survey** | Supply (county 5+ unit permits) | none | public domain | "U.S. Census Bureau" |
| **FEMA NFHL and National Risk Index** | Hazards | none | public domain | "FEMA" |
| **USFWS National Wetlands Inventory** | Hazards | none | public domain | "U.S. Fish and Wildlife Service" |
| **US EPA FRS and Smart Location Walkability** | Hazards, location | none | public domain | "U.S. EPA" |
| **USGS EPQS, 3DEP, WBD, design maps** | Location, hazards | none | public domain | "U.S. Geological Survey" |
| **USDA NRCS SSURGO** | Location (soils) | none | public domain | "USDA NRCS" |
| **HUD eGIS** (QCT, DDA, Opportunity Zones, LIHTC, public housing) | Incentives | none | HUD public data | "U.S. Department of Housing and Urban Development" |
| **HUD Fair Market Rents** | Rents (FMR, SAFMR) | `HUD_API_TOKEN` (optional; section shows needs-key without it) | HUD public data | "HUD" |
| **Zillow Observed Rent Index (ZORI)** | Rents | none | Zillow research data, free with attribution | "Zillow Observed Rent Index, Zillow Group" |
| **NCES EDGE** | Schools | none | public domain | "NCES EDGE" |
| **Valhalla (FOSSGIS demo) and OSRM demo** | Access (15 minute drive time) | none (openrouteservice key optional) | ODbL data; demo servers, fair use, no SLA | "Valhalla, OSRM, © OpenStreetMap contributors" |
| **OpenStreetMap via Overpass** | Amenities | none | ODbL 1.0 | "© OpenStreetMap contributors" |
| **Esri World Imagery Wayback** | Historical imagery slider, imagery change count | none | Esri terms: display with attribution, no persistent tile caching | "Esri, Vantor, Earthstar Geographics, CNES/Airbus DS, USDA FSA, USGS, Aerogrid, IGN, IGP, and the GIS User Community" |
| **Existing camera catalog** (`/api/cctv/sources`) | Cameras near the site | per pack | per pack (see the CCTV rows above) | per pack |
| **FEMA National Risk Index, expected annual loss** | Insurance cost signal | none | public domain | "FEMA National Risk Index" |
| **HUD USER API, MTSP income limits** | LIHTC rent and income limits | `HUD_API_TOKEN` (required; section shows "Needs HUD key" without it and makes no request) | public domain | "HUD Multifamily Tax Subsidy Project income limits" |
| **HIFLD Hospitals, HIFLD Colleges and Universities (FEMA-hosted copies)** | Demand drivers | none | public domain | "HIFLD (DHS, ORNL); NCES IPEDS" |
| **HIFLD Electric Retail Service Territories** | Utility providers | none | public domain ("None (Public Use)") | "ORNL, DOE CESER; EIA-861" |
| **US EPA Community Water System Service Area Boundaries** | Utility providers | none | public domain | "U.S. EPA" |
| **Zillow ZHVI/inventory/ZORI, Dallas/Atlanta municipal permit and rezoning feeds** | Market, development | none | Zillow research data (attribution); municipal open-data terms | "Zillow Group"; each city GIS source |
| **Google News RSS** | Local news | none | [Google News Terms of Service](https://www.google.com/intl/en_us/terms_google_news.html): personal, noncommercial use; linked articles retain publisher terms | "Google News RSS headlines; each link opens the publisher" (see `src/cre/sections/localNews.js`). Exports carry only headline, publisher, date and link, never article text |

`DATA_GOV_API_KEY` (optional) is reserved for the FBI Crime Data Explorer section, which is
not in Phase 1. The in-app credit lightbox carries matching `cre-*` entries from
`src/data/dataCredits.js`.

### Data-correctness notes (public-release remediation pass)

- **FEMA NFHL flood map panel.** When more than one FIRM panel intersects the query point, the
  panel whose ID's first five digits (its county FIPS) match the site's own county wins; the
  site's county is looked up against the Census TIGERweb State/County layer for this tie-break
  only. If no candidate panel matches the site's county, every intersecting panel is listed
  instead of guessing one (`server/providers/cre/hazards.js` `loadFlood`).
- **Census ACS ring medians (median household income, median gross rent).** A ring's median is
  pooled from the ACS B19001 (income) and B25063 (gross rent) distribution bins across every
  tract in the ring, then interpolated using the Census Bureau's own linear-interpolation
  method for grouped data. This replaced a household/renter-weighted mean of each tract's own
  published median, which is a different statistic and ran 3 to 11 percent high at the review's
  test site. The mean-of-medians method is still shown, labeled as such, when the bin fetch
  fails (`src/cre/sections/demographics.js`).
- **Rental vacancy vs. all-housing vacancy.** Two distinct rows now exist: "All-housing vacancy
  rate" (ACS B25002: vacant units over all housing units, includes for-sale and seasonal
  vacancy) and "Rental vacancy rate" (ACS B25004: for-rent units over renter-occupied plus
  for-rent plus rented-not-yet-occupied units). These can run in either direction from each
  other and are not interchangeable.
- **ACS change-row significance.** The population, income and rent change rows carry a
  Census-style z-test (`z = (est1 - est2) / sqrt((moe1/1.645)^2 + (moe2/1.645)^2)`) wherever
  both vintages' margins of error are available (a single tract only; a ring's medians are
  already a different, MOE-less calculation). `|z| < 1.645` is labeled not statistically
  significant at 90% confidence. Every change row also names that the compared ACS 5-year
  periods overlap in sampled years, since no tract crosswalk to a non-overlapping vintage was
  built this pass.
- **HUD Fair Market Rent.** Every FMR row now carries HUD's own definition verbatim ("40th
  percentile gross rent including utilities, used for voucher payment standards; not a market
  rent") and states whether the parser has been exercised against a live HUD API response this
  session (it requires `HUD_API_TOKEN`, which was not present on the machine that ran this
  remediation pass, so the parser's field-shape assumptions remain unverified against a live
  response as of this writing).
- **BLS QCEW average weekly wage.** The wage level now comes from the BLS QCEW *annual* file
  (`.../data/api/<year>/a/area/<fips>.csv`), not a single quarter; a quarter (especially Q1) can
  run well above or below the annual average (Fulton County, GA: Q1 2026 $2,355/week vs. the
  2025 annual average of $1,999/week, roughly 18% higher). Both the weekly figure and its
  annualized figure (weekly x 52) are shown. The existing quarter-over-same-quarter-prior-year
  percent change is unchanged, but is now labeled "(quarterly)" so it is never read as
  confirming a trend in the annual level.
- **HUD QCT / DDA designation year.** The designation year N is the year in the HUD layer name
  (`QUALIFIED_CENSUS_TRACTS_2026`, `Difficult_Development_Areas_2026`), corroborated at request
  time by the layer's `editingInfo.dataLastEditDate`. HUD publishes year-N designations in the
  fall of year N-1; both 2026 layers show data last edited 2025-09-22. Each row reads "HUD N
  designation, data updated Mon YYYY". If the data was last edited before year N-1 the row adds
  "layer data may be stale"; after December 31 of year N it adds "a newer HUD designation year may
  be available". The layer's `description` field is deliberately not used for the year: on the
  live 2026 layers it still reads "Fiscal Year 2024 ... Date Updated: 10/2023", which is stale
  boilerplate, not the data vintage. If `editingInfo` is missing, the layer-name year is shown
  with "update date unavailable".
- **FEMA National Risk Index (NRI) score.** Labeled "national percentile" rather than "of 100":
  `RISK_SCORE` in the NRI feature service is itself a national percentile rank
  (`RISK_SPCTL`), not a 0-100 grade, so "2.5 of 100" read like a low grade rather than the 2.5th
  percentile it actually is.
- **Census Building Permits Survey (BPS) trend.** A year with no filed data for a county is
  excluded from the multi-year trend average; it previously counted as a real zero permits,
  which is not what "no data" means.
- **Zillow Observed Rent Index (ZORI).** Rounded to whole dollars everywhere it is shown (Rents
  and Market sections); it previously showed two decimal places in one place and none in the
  other, which read as two independent sources agreeing to the penny on an index that carries
  no such precision.
- **Zillow ZORI rent trend chart (Rents section).** The same ZORI file already fetched for the
  Rents section now also keeps the trailing 36 months by ZIP (`zoriForZip`'s `history` field,
  `server/providers/cre/rents.js`), rendered as an inline SVG line (`src/cre/sections/rentsChart.js`,
  no charting library). A month with no published value is left as a gap in the line, never
  drawn as a false $0. No new upstream source or key: same ZORI CSV, same license and
  attribution row above.
- **BLS QCEW employment concentration (location quotients, Jobs section).** The county ANNUAL
  QCEW file the Jobs section already fetches (DATA-07's annual-average fix) also carries private
  ownership NAICS supersector rows (`own_code` 5, `agglvl_code` 73) with BLS's own
  `lq_annual_avg_emplvl` location quotient and each sector's employment
  (`server/providers/cre/qcew.js` `parseQcewSupersectors`, `sectorConcentration`, route
  `/api/cre/qcew/sectors`). A sector is flagged "concentrated vs U.S." only when it clears BOTH
  LQ &ge; 1.5 AND &ge; 10% of county PRIVATE employment (not the all-ownership county total used
  by the existing employment row); LQ alone rewards small, volatile sectors with the same alarm
  as a sector that is genuinely both large and over-represented (Fulton County's Information
  supersector clears LQ 3.1 but is only 6.4% of private employment, so it does not qualify).
  Supersector 1029 "Unclassified" is dropped: it is a residual bucket, not a real sector, and its
  LQ is noise (the recorded Fulton County, GA 2025 file: LQ 4.03 on only 4,938 jobs). No new
  upstream source, key or license: same BLS QCEW annual file and attribution row above.
  - **Single-sector-dependence threshold: 35%, not 25% (fixed 2026-09-24).** The largest
    supersector is always shown as an informational row ("Largest sector: &lt;name&gt;, &lt;share&gt;%
    of private jobs (LQ &lt;x&gt; vs U.S.)"); a "single-sector dependence" caution is added only
    when that share is &ge; 35%. The original 25% line falsely alarmed on Fulton County, GA, where
    Professional and business services (management, legal, accounting, admin support,
    consulting) is 27.4% of private employment: a broad, diversified urban supersector, not a
    one-industry or one-employer economy. 35% is set at the point where one supersector
    plausibly IS the county's economic base rather than just its largest bucket in an otherwise
    normal metro mix; a synthetic 40%-share fixture confirms the caution still fires when a
    county really is that lopsided. Tests: `server/providers/cre/qcew.js` (Fulton fixture: no
    caution; synthetic 40% fixture: caution) and `src/cre/sections/jobs.js`'s test suite.

### P6B sources: verified live endpoints and field names (checked 2026-09-24)

Every P6B provider pins its upstream hosts in code (`server/providers/cre/common/pinnedHosts.js`);
a URL on any other host, over plain http, or carrying credentials is refused before a request
is made.

- **FEMA National Risk Index, expected annual loss** (`/api/cre/insurance/eal`,
  `server/providers/cre/insurance.js`). Service:
  `https://services.arcgis.com/XG15cJAlne2vxtgt/arcgis/rest/services/National_Risk_Index_Census_Tracts/FeatureServer/0`
  (layer name `NRI_CensusTracts_Prod`, `NRI_VER` "December 2025", data last edited 2025-12-16).
  Field names were read from the live `?f=json` metadata, not guessed: `TRACTFIPS`, `COUNTY`,
  `STATEABBRV`, `NRI_VER`, `BUILDVALUE`, `RISK_SCORE`, `RISK_RATNG`, `EAL_VALB` (composite building
  EAL, dollars), `EAL_SCORE`, `EAL_RATNG`, `ALR_NPCTL` (composite loss rate, national percentile),
  and for each peril prefix `<P>_EALB` (building EAL, dollars), `<P>_EALS` (EAL score, a national
  percentile rank), `<P>_EALR` (rating) and `<P>_ALR_NPCTL` (loss rate, national percentile).
  Prefixes: `HRCN` hurricane, `SWND` strong wind, `HAIL` hail, `TRND` tornado, `WFIR` wildfire,
  `IFLD` inland flooding, `CFLD` coastal flooding. The live service has no `RFLD` (riverine)
  prefix; FEMA renamed riverine flooding to inland flooding, so riverine is shown from `IFLD` and
  labeled "Riverine (inland) flooding". A peril FEMA rates "Not Applicable" carries a null loss
  and is shown as words, never $0. Section label, verbatim: "FEMA expected annual loss to
  buildings in this tract, a relative risk signal, not an insurance premium".
- **HUD USER API, MTSP income limits** (`/api/cre/lihtc-limits/mtsp`,
  `server/providers/cre/lihtcLimits.js`). Endpoint:
  `https://www.huduser.gov/hudapi/public/mtspil/data/{county FIPS}99999`, bearer
  `HUD_API_TOKEN`; county FIPS from
  `https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/1`. The
  endpoint was confirmed to exist (it answers 401 "Unauthenticated" without a token; an unknown
  path answers a Not Found page). Response fields per HUD's documentation
  (https://www.huduser.gov/portal/dataset/fmr-api.html): `data.area_name`, `data.year`,
  `data.median_income`, `data["50percent"].il50_p1..il50_p8`,
  `data["60percent"].il60_p1..il60_p8`. **The parser has not yet been exercised against a live
  HUD response**: no `HUD_API_TOKEN` exists on the build machine, so it is tested only against a
  hand-built fixture of that documented shape. Max gross LIHTC rent is computed, not fetched:
  30 percent of the limit at the imputed household size (0BR 1 person, 1BR 1.5, 2BR 3, 3BR 4.5),
  over 12, rounded down. Without the token the route answers `needs-key` and makes no request of
  any kind; the section shows "Needs HUD key" with the signup link.
- **HIFLD Hospitals** (`/api/cre/demand-drivers/hospitals`). HIFLD Open
  (`services1.arcgis.com/Hp6G80Pky0om7QvQ`) answers "Invalid URL" for every layer as of this
  check. Used instead: FEMA HQ's hosted copy of the same HIFLD layer,
  `https://services.arcgis.com/XG15cJAlne2vxtgt/arcgis/rest/services/Hospitals_RAPT/FeatureServer/6`
  (copyright ORNL; DHS GMO; data last edited 2026-04-22). Fields: `NAME`, `BEDS` (-999 means not
  reported), `STATUS` (only `OPEN` kept), `TYPE`, `SOURCEDATE`. HIFLD status can lag real
  closures; each row says to confirm the facility operates.
- **HIFLD Colleges and Universities** (`/api/cre/demand-drivers/colleges`). FEMA HQ's hosted copy:
  `https://services.arcgis.com/XG15cJAlne2vxtgt/arcgis/rest/services/Colleges_and_Universities/FeatureServer/5`
  (IPEDS-derived; copyright ORNL and NGA HSIP; data last edited 2025-08-18). Fields: `NAME`,
  `TOT_ENROLL` (negative means not reported), `STATUS` (`A`, `N`, `R` kept), `NAICS_DESC` (only
  "COLLEGES, UNIVERSITIES, AND PROFESSIONAL SCHOOLS" and "JUNIOR COLLEGES" kept), `SOURCEDATE`.
  Distances are straight-line within 10 miles; top 3 of each are shown.
- **HIFLD Electric Retail Service Territories** (`/api/cre/utilities/electric`). HIFLD Open's copy
  is gone. Used instead: the same HIFLD layer republished publicly by the ArcGIS Online account
  `NBAM_Org`,
  `https://services3.arcgis.com/OYP7N6mAJJCyH6hd/arcgis/rest/services/Electric_Retail_Service_Territories_HIFLD/FeatureServer/0`
  (copyright ORNL, DOE CESER; license "None (Public Use)"; data last edited 2025-08-21; `YEAR`
  2022). Fields: `ID` (EIA utility ID), `NAME`, `TYPE` (INVESTOR OWNED, COOPERATIVE, MUNICIPAL,
  POLITICAL SUBDIVISION, STATE, FEDERAL, MUNICIPAL MKTG AUTHORITY, WHOLESALE POWER MARKETER,
  COMMUNITY CHOICE AGGREGATOR, NOT AVAILABLE), `STATE`, `HOLDING_CO`, `CUSTOMERS`, `YEAR`,
  `SOURCEDATE`.
  - **PROVENANCE search, verified live 2026-09-24, no official publisher found.** Checked: DOE and
    ORNL's own ArcGIS presence, EIA's own org (`gis.eia.gov`, `eia.maps.arcgis.com` -- neither
    answers), geoplatform.gov, and HIFLD's current geoplatform hub org
    (`services2.arcgis.com/FiaPA4ga0iQKduv3`, 229 services enumerated live, none named Electric
    Retail Service Territories). An ArcGIS Online catalog search for the exact title
    ("Electric Retail Service Territories") returns 265 results; every one of the top 20 is a
    third-party republish (`NBAM_Org`, `layermanager`, `esri_policymaps`,
    `FEMA_HQ_Recovery_GDAC`, `HSEMA_PPD`, `harcuser`, and others), never a government-run
    account. Conclusion: kept the current `NBAM_Org` copy (still the best available free
    national layer), but every row built from it now says **"public republished copy; publisher
    not verified"** instead of citing ORNL/DOE CESER as if that were a confirmed source. Re-check
    periodically in case an official copy appears (HIFLD's post-2025-shutdown home has been
    gaining layers).
- **US EPA Community Water System Service Area Boundaries** (`/api/cre/utilities/water`). EPA's
  own ArcGIS organization:
  `https://services.arcgis.com/cJ9YHowT8TU7DUyn/arcgis/rest/services/Water_System_Boundaries/FeatureServer/0`
  (data last edited 2026-05-29). Fields: `PWSID`, `PWS_Name`, `Primacy_Agency`,
  `Population_Served_Count`, `Service_Area_Type`, `Symbology_Field`. Boundaries can overlap, so
  every system at the point is listed.
- **Natural gas and sewer territories: not available nationally.** The HIFLD natural gas service
  territory layers were on HIFLD Open and are offline; no free national sewer service area layer
  was found. The section says "Not available nationally" rather than guessing.

### Undocumented live hosts, found and closed (public-release documentation pass)

Six hosts the code already calls (verified against the pinned-host allowlists in
`server/providers/`) had no row anywhere in this file, even though the README and in-app
credits describe the coverage they provide.

| Source | Used for | License / terms | Attribution |
| --- | --- | --- | --- |
| **Accela Citizen Access** (`aca-prod.accela.com`) | Development section: Dallas and Atlanta permit/code-case portal links (`server/providers/cre/development.js`, `codeCaseUrl`) | Public government citizen-access portal; no separate API terms published (a link out, not a scraped feed) | "Accela Citizen Access, City of Dallas" / "Accela Citizen Access, City of Atlanta" |
| **CMS Provider Data Catalog, Hospital General Information** (`data.cms.gov`) | Demand drivers: cross-checks HIFLD's stale hospital STATUS field against CMS's current Medicare-certified hospital list (`server/providers/cre/demandDrivers.js`) | Public domain (US Government work) | "CMS Provider Data Catalog, Hospital General Information" |
| **Austin CCTV image host** (`cctv.austinmobility.io`) | CCTV: individual camera snapshot images for the Austin pack (`server/providers/cctv/sources.js`); the catalog itself is `data.austintexas.gov`, already listed above | City of Austin Open Data Terms of Use (same program as the already-listed catalog host) | "City of Austin, TX, data.austintexas.gov" |
| **Dallas GIS** (`gis.dallascityhall.com`) and **Dallas police Crime Analytics Dashboard** (`dallascitydata.dallascityhall.com`) | Development section (ROW permits, zoning); jurisdiction city-limit polygon; neighborhood section's link to Dallas's own crime dashboard, since Dallas's incident-level feed is not connected (`server/providers/cre/development.js`, `jurisdictions.js`, `dallasCrime.js`) | Public municipal GIS/open-data services; the crime dashboard link is to the city's own published, authoritative dashboard, not a scraped feed | "City of Dallas GIS" / "City of Dallas Police Department, Crime Analytics Dashboard" |
| **Chicago Data Portal** (`data.cityofchicago.org`) | Neighborhood section: Chicago police incident records within the study radius (`server/providers/cre/neighborhood.js`) | City of Chicago Open Data terms (Socrata-hosted open data) | "City of Chicago, data.cityofchicago.org" |
| **Johnson City, TN GIS** (`gis.johnsoncitytn.org`) | Neighborhood section: parcel and zoning/overlay layers for the Johnson City test market (`server/providers/cre/neighborhood.js`) | Public municipal GIS service | "City of Johnson City, TN GIS" |

`api.openai.com` (the user's own BYOK voice provider) is out of scope for this table -- it is
not a third-party geodata source, it is a credential the user supplies and pays for directly.
