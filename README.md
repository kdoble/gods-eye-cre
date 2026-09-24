# Gods Eye CRE

Gods Eye CRE is a local workspace for screening U.S. multifamily sites. Search an address to review its estimated location, surrounding public data, map overlays, and a source-labeled dossier. Results can be partial or unavailable when a provider is offline or a key is absent. An address match does not confirm a building or parcel, and screening results do not establish feasibility or replace property diligence.

This fork builds on [God's Eye View](https://github.com/bilawalsidhu/gods-eye-view) by [Bilawal Sidhu](https://github.com/bilawalsidhu). The upstream MIT license and copyright notice remain in [LICENSE](LICENSE). Gods Eye CRE is maintained at [kdoble/gods-eye-cre](https://github.com/kdoble/gods-eye-cre).

### What this is, and is not

This is a free, local starting point for screening a multifamily site using public data. It is not an appraisal, not a survey, not legal, zoning, flood, or insurance advice, and not investment advice. Verify every figure at its source before relying on it for a decision.

Walking and driving routes in the app (the Directions layer, drive-time isochrones, and destination-distance figures) run on free public demo routing servers, [FOSSGIS's OSRM](https://project-osrm.org/) and [Valhalla](https://valhalla1.openstreetmap.de/), built on OpenStreetMap data. These are shared, rate-limited community services, not a dedicated routing provider: they can be slow or briefly unavailable, and a route that fails to answer falls back to a labeled straight-line distance rather than blocking the rest of the dossier.

## Quick Start

The app itself starts with no API keys at all. But as of September 2026 the U.S. Census Bureau's API rejects every call that has no key (it answers with an HTTP redirect to a "missing key" page), so the Census demographics section of the dossier needs a free key to return data. HUD is separately optional. Get the free Census key below before your first real search; skip it if you only want to try the app.

### Prerequisites

- **Node.js 24.14 or newer within 24.x, or Node.js 26.x.** Node 25 is EOL and only partially supported (the app runs, but some release checks are skipped); Node 23 and earlier are too old and are refused. Check your version with:

  ```bash
  node -v
  ```

  If it does not start with `v24.14` through `v24.x`, or `v26.x`, install a supported version (for example with [nvm](https://github.com/nvm-sh/nvm): `nvm install 24.14.0 && nvm use 24.14.0`).

- **Git**, to clone the repository.

### Get your free Census key (about 2 minutes)

1. Go to [api.census.gov/data/key_signup.html](https://api.census.gov/data/key_signup.html) and enter your organization name and email address.
2. The key arrives by email within a few minutes. **Click the activation link in that email.** The key does not work until you activate it.
3. Add the activated key to the app, either way:
   - **In the app:** open the dossier panel and click **Keys and settings**, then paste the key into the Census field. This writes it into a local `.env` file for you.
   - **By hand:** create a file named `.env` in the repo root (it is git-ignored, so it is never committed) with the line:

     ```
     CENSUS_API_KEY=your_key_here
     ```

### Run it

```bash
git clone --depth 1 https://github.com/kdoble/gods-eye-cre.git
cd gods-eye-cre
npm ci
npm run doctor
npm run dev
```

Open **http://localhost:4173** (the port the dev server actually binds to by default), enter a U.S. property address, and review the map and dossier. The geocoder point may be approximate; confirm it against the property before interpreting nearby results. Providers receive the address or coordinates needed to answer their requests, even though the app itself runs locally. See [SECURITY.md](SECURITY.md) for the local key handling model.

`npm run doctor` reports whether each key is present. It does not validate that a key was activated or that a provider accepts it. That only shows up once you run a search.

### What works with no keys, and what Census unlocks

With no keys at all, the app starts, the map and globe work, and most of the dossier populates from keyless public sources. Without an activated `CENSUS_API_KEY`, the demographics section reports it needs a key instead of returning data. Adding the key unlocks, for the searched site's 1/3/5 mile rings: population, median household income, renter share, median gross rent, and rent-burden (GRAPI) figures.

### Other optional keys

None of these are required to start the app. Each adds one more dossier section or map layer; without it, that piece reports unavailable or falls back to a keyless mode. Add any of them the same two ways as Census: **Keys and settings** in the dossier panel, or the repo-root `.env` file. [`.env.example`](.env.example) lists every supported variable with its placeholder and notes.

| Variable                                      | Unlocks                                                    | Notes                                                                                                                                                 |
| --------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HUD_API_TOKEN`                               | Site dossier Fair Market Rents and Small Area FMR          | Free token from [huduser.gov](https://www.huduser.gov/portal/dataset/fmr-api.html)                                                                    |
| `DATA_GOV_API_KEY`                            | none                                                       | Not used by the current CRE dossier                                                                                                                   |
| `GOOGLE_MAPS_API_KEY`                         | Google Photorealistic 3D Tiles, GEV place search           | **Compiled into the browser bundle**, visible in devtools by design. Restrict it by HTTP referrer (and API) in Google Cloud, never rely on hiding it. |
| `GOOGLE_MAPS_SERVER_API_KEY`                  | Server-side Google Places and Street View CCTV fallback    | Server-side only; falls back to `GOOGLE_MAPS_API_KEY` if unset                                                                                        |
| `CESIUM_ION_TOKEN`                            | Bing imagery map stacks, world terrain                     | **Compiled into the browser bundle.** Restrict it in Cesium ion (a public assets:read token with URL restrictions), never rely on hiding it           |
| `GEV_ENABLE_UPSTREAM_EXTRAS`                  | Mounts the inherited flights (OpenSky/adsb.lol/adsbdb) and AIS vessels routes | Off by default in this fork; those layers aren't used by the CRE dossier. Set to `1` to run this fork in its original globe/"gev" mode, at your own call on OpenSky's non-commercial license |
| `AISSTREAM_API_KEY`                           | Live AIS vessels layer                                     | Free at [aisstream.io](https://aisstream.io); requires `GEV_ENABLE_UPSTREAM_EXTRAS=1` too                                                             |
| `FIRMS_MAP_KEY`                               | NASA FIRMS live active-fire detections                     | Free at [firms.modaps.eosdis.nasa.gov](https://firms.modaps.eosdis.nasa.gov/api/map_key/)                                                             |
| `TOMTOM_API_KEY`                              | Real live traffic (keyless runs a simulation instead)      | Free tier at [developer.tomtom.com](https://developer.tomtom.com)                                                                                     |
| `OPENSKY_CLIENT_ID` / `OPENSKY_CLIENT_SECRET` | More flight-polling credits                                | Anonymous access works without it, just rate-limited; requires `GEV_ENABLE_UPSTREAM_EXTRAS=1` too                                                     |
| `LL2_API_TOKEN`                               | Higher Launch Library 2 (space launches) request allowance | Public access works without it                                                                                                                        |
| `OPENAI_API_KEY`                              | Voice control                                              | Server-side only                                                                                                                                      |

### Local brand marks (optional)

The public app ships no retailer logo artwork; map badges and the exported report use neutral text-initial labels (Sb, Kr, Ta, Wm, Wg) for a handful of well-known chains. If you want your own local copy to show the real logo instead, drop a file named after the chain key (`kroger.png`, `starbucks.svg`, `target.jpg`, `walmart.webp`, `walgreens.png`) into the gitignored `local-brand-marks/` folder at the repo root, see [`local-brand-marks/README.txt`](local-brand-marks/README.txt) for the exact rules. The dev server serves only exact known filenames from that folder; anything else, including a path-traversal attempt, is refused. These are trademarks, the files stay on your machine and are never committed.

## What the dossier covers

The current sections cover site and location context, hazards, demographics, jobs, drive-time access, schools, incentives, multifamily permits, rent context, housing values and inventory, municipal activity, local headlines, amenities, public cameras, and historical imagery where those sources respond. These are screening signals with different geographies, periods, methods, and limits. Read each source, date, status, and note in context. A populated section is not proof that every source within it is complete.

The dossier can export JSON or a printable report. Use it to organize initial review and follow-up diligence, not as a property valuation, legal determination, hazard clearance, entitlement opinion, or underwriting model.

## A site review

Search the street address, inspect the match, then use **Confirm location** once the pin is on the intended site. A geocoder match is only an estimated point; confirming it does not verify a parcel, building, ownership, access, or zoning. The dossier opens to **Investor**, which emphasizes incidents, walkable daily needs, retail access, rents and demand. **Developer** brings parcel/zoning, physical constraints and concept diligence forward; use **Details** for values, source dates, coverage notes, and unavailable-source explanations, and **Map** to inspect the point, radius, and returned overlays.

Choose a 1, 3, or 5 mile map radius. It controls the displayed ring, FEMA flood geometry, the major-road query (capped at 3 miles), and supported local police queries. Demographics always report fixed 1-, 3-, and 5-mile rings; jobs use their own fixed ring and drive-time areas. Retail and everyday amenity counts stay at 1 mile, nearest hospitals are searched up to 3 miles, and public cameras use their fixed 5 mile search. Municipal activity and housing series show their own search areas. Coverage and source methods vary; a blank map or unsupported locality does not mean no risk, no development, or no nearby feature.

The subject uses a distinct **SITE triangle**. Known Starbucks, Kroger, Target, Walmart, and Walgreens locations use small bundled identifying marks; other named places use category symbols. Map layers include major roads, retail and everyday amenities, a separate FEMA flood toggle, environmental hazards, and supported local police records. Police controls filter categories and switch between record locations and counted map cells. Dallas records are reported offense rows over a dated 90-day window, not unique incidents, a crime rate, or a safety rating. The map and geometry exports use the same selected filters. See [retailer mark provenance](docs/cre/BRAND-MARKS.md).

Local coverage includes Dallas police and zoning, Chicago police, Atlanta parcel/zoning context, and official parcel/zoning lookups in Johnson City. Johnson City Police publishes an official incident map, linked with its exclusions; its feature feed was inaccessible during verification. These are not nationwide services. The location panel links to Google Maps, Google Street View, and OpenStreetMap without requiring a Google key in this app; imagery availability depends on the location. Public cameras are traffic cameras where supported feeds provide them, not guaranteed street-level views of a property. An empty camera section means the checked feeds returned no nearby cameras.

Save up to five site snapshots in this browser, along with analyst notes and diligence actions. Select saved sites to compare them, open a report, or export selected snapshots as a local JSON backup and comparison CSV. These snapshots stay in browser storage until removed or browser data is cleared; export a backup to move them elsewhere.

Under **Notes, diligence & local imports**, add user-supplied rent-comps or development-pipeline CSVs, or a dated GeoJSON map overlay for a custom area. Imported CSV evidence is labeled user-supplied and is not independently verified. GeoJSON is drawn as a local overlay; polygon acreage is geometry-derived and does not reaggregate or replace Census, county, or other source statistics.

## Additional research and reports

Use **Update** to retry the reviewed public sources for the current site. Prior dated findings remain visible during refresh; failed attempts, cached checks, and refresh cooldowns are labeled. National bulk catalogs retain their source cache policy. The Update view lists each topic's progress and retrieval date. **Back to top** returns to the controls from the bottom of the dossier.

**News & market** brings together dated housing values, ZIP for-sale inventory and asking-rent indices, city activity records, and clickable local headlines. Dallas activity covers right-of-way work; Atlanta activity covers rezoning cases. These records do not establish apartment construction, subject occupancy, or code compliance. Current code cases require the linked official city search. News searches use city topics; the address is matched locally against retrieved headline text and is not sent to the news index. A headline match is not a verified property event.

Optional AI research setup remains available inside Update, with saved Investor and Developer topic selections. **The optional AI source-discovery provider is not connected**; its Run and auto-run controls remain disabled. Automatic baseline research and public-source Update work independently of that optional service.

Named OSM groceries, pharmacies and major retail candidates are searched within 5 km. A separate named-workplace layer shows up to six nearby mapped offices, hospitals, universities or colleges when available. These are location candidates, not verified major employers or employee counts. Walking routes and the nearest retail driving route use the shared public route service. Unavailable routes preserve the destination with a labeled straight-line distance; they are not walking times. OSM coverage and public routing availability vary.

**Report** opens a printable role-specific location brief, a schematic of returned source geometry, and the full dated source appendix. Use Print / Save PDF in the preview. **Map** contains saved sites and selected-site comparisons (two to five sites). The selected area, point confirmation, research scope and analyst notes are retained; comparisons never assign an automatic investment ranking.

## Development

The supported local install is the fork clone shown above. Do not clone the upstream repository for this CRE application. Useful checks include:

```bash
npm test
npm run format:check
npm run check:boundaries
npm run build
```

For an opt-in live browser check of the site workspace, start the dev server and run `QA_BASE_URL=http://localhost:4173 npm run qa:cre-workspace`. It visits the Johnson City test point, Atlanta, and Chicago pilots and uses public sources; results and screenshots are written to `/tmp/gods-eye-cre-workspace-qa` by default.

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidance and [SECURITY.md](SECURITY.md) for vulnerability reporting. Package metadata uses the name `gods-eye-cre`; the package remains marked private and is not configured for npm publication.

## License and bundled material

The inherited application source remains under MIT. Individual datasets and media keep their own licenses and attribution. The TeleGeography cable dataset and Bhote Koshi event material carry noncommercial terms and are excluded from the current source tree, current build, and supported shallow-clone setup. This public repository starts from a clean snapshot and does not include the earlier development history where these assets were once present, so no copy of them ships here, in the working tree or in this repository's Git history. See [DATA_SOURCES.md](DATA_SOURCES.md) for source-specific terms. Do not infer rights for third-party data from the application's MIT license.

## Inherited map controls

DISPLAY ▸ **Draw** lets you add an area, line, or pin by clicking points on the globe, then finish with a double-click or Enter and optionally add a label and color. Backspace removes the last point; Esc cancels the current drawing. Clear removes the marks. Drawn marks are local map annotations and are not included in the dossier's JSON or print exports.
