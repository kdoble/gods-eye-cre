// Screen-space landing check: projects the expected site point to pixels on the globe the viewer actually drew and judges whether it sits in the open map area, clear of the dossier panel.

/** Pixels the pin must stay inside the open map area's edges. */
export const EDGE_MARGIN_PX = 24;
/** The pin must sit within this fraction of the open area's width and height from its center. */
export const CENTER_TOLERANCE = 0.2;

/**
 * Probe the page. Self-contained on purpose: the harness passes its source
 * to page.evaluate, so it may use only its arguments and the page globals.
 *
 * The height used is the height of the surface the globe actually rendered
 * under the point (globe.getHeight over the loaded tiles), never the site's
 * surveyed elevation. That is what the old landing check got wrong: it
 * intersected the view at surveyed ground plus 30 m while the CRE globe is
 * drawn flat at sea level, so a camera aimed at the wrong ground height
 * passed its own test. If the rendered height cannot be read on a real
 * terrain globe the probe reports an error, which the judge treats as FAIL.
 * @param {number} lat
 * @param {number} lon
 */
export function probeSiteScreen(lat, lon) {
  const viewer = globalThis.__godsEyeView?.viewer;
  const C = globalThis.__CESIUM__;
  if (!viewer || !C) return { error: 'viewer or Cesium global missing' };
  const scene = viewer.scene;
  const carto = C.Cartographic.fromDegrees(lon, lat);
  const flat = viewer.terrainProvider instanceof C.EllipsoidTerrainProvider;
  let height = scene.globe.getHeight(carto);
  let heightSource = 'globe.getHeight';
  if (!Number.isFinite(height)) {
    if (!flat) return { error: 'rendered ground height unavailable' };
    height = 0;
    heightSource = 'ellipsoid (flat globe)';
  }
  const world = C.Cartesian3.fromDegrees(lon, lat, height);
  const toWindow =
    C.SceneTransforms.worldToWindowCoordinates ||
    C.SceneTransforms.wgs84ToWindowCoordinates;
  const pixel = toWindow(scene, world);
  const toPoint = C.Cartesian3.subtract(
    world,
    viewer.camera.positionWC,
    new C.Cartesian3(),
  );
  const inFront = C.Cartesian3.dot(toPoint, viewer.camera.directionWC) > 0;
  // How far the camera stands off the site. A nadir camera flown straight up
  // keeps the pin dead centre and the aim point unmoved, so neither the
  // screen check nor the distance check sees it: only the range does (B2-03).
  const rangeM = C.Cartesian3.magnitude(toPoint);
  const canvasRect = viewer.canvas.getBoundingClientRect();
  const rectOf = (node) => {
    if (!node) return null;
    const style = getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden') return null;
    const r = node.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return null;
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  };
  // What the user would touch at the pin: anything but the map canvas there
  // (a dock, a sheet, a banner) means the pin is covered.
  let coveredBy = null;
  if (pixel) {
    const hit = document.elementFromPoint(
      canvasRect.left + pixel.x,
      canvasRect.top + pixel.y,
    );
    if (hit && hit !== viewer.canvas) {
      coveredBy =
        hit.id ||
        String(hit.className || hit.tagName)
          .split(' ')
          .slice(0, 2)
          .join('.');
    }
  }
  return {
    coveredBy,
    rangeM: Math.round(rangeM * 10) / 10,
    heightM: Math.round(height * 10) / 10,
    heightSource,
    flatGlobe: flat,
    inFront,
    pixel: pixel ? { x: pixel.x, y: pixel.y } : null,
    canvas: {
      left: canvasRect.left,
      top: canvasRect.top,
      right: canvasRect.right,
      bottom: canvasRect.bottom,
    },
    panel: rectOf(document.getElementById('dossier-panel')),
  };
}

/**
 * The largest strip of the canvas the panel does not cover: left, right,
 * above or below it. With no panel the whole canvas is open.
 * @param {{left:number, top:number, right:number, bottom:number}} canvas
 * @param {{left:number, top:number, right:number, bottom:number}|null} panel
 */
export function openMapArea(canvas, panel) {
  if (!panel) return { ...canvas };
  const strips = [
    { ...canvas, right: Math.min(canvas.right, panel.left) },
    { ...canvas, left: Math.max(canvas.left, panel.right) },
    { ...canvas, bottom: Math.min(canvas.bottom, panel.top) },
    { ...canvas, top: Math.max(canvas.top, panel.bottom) },
  ].filter((r) => r.right > r.left && r.bottom > r.top);
  if (!strips.length) return null;
  const area = (r) => (r.right - r.left) * (r.bottom - r.top);
  return strips.reduce((best, r) => (area(r) > area(best) ? r : best));
}

/**
 * Pass or fail a probe. Any missing measurement is a FAIL, never a pass.
 * @param {ReturnType<typeof probeSiteScreen>} probe
 * @param {{margin?: number, tolerance?: number}} [options]
 * @returns {{ok: boolean, reason: string, pixel?: object, area?: object, offset?: object}}
 */
export function judgeSiteOnScreen(
  probe,
  { margin = EDGE_MARGIN_PX, tolerance = CENTER_TOLERANCE } = {},
) {
  if (!probe) return { ok: false, reason: 'no probe result' };
  if (probe.error) return { ok: false, reason: probe.error };
  const { pixel, canvas, panel } = probe;
  if (!pixel || !Number.isFinite(pixel.x) || !Number.isFinite(pixel.y))
    return { ok: false, reason: 'site does not project to the screen' };
  if (!probe.inFront) return { ok: false, reason: 'site is behind the camera' };
  const area = openMapArea(canvas, panel);
  if (!area) return { ok: false, reason: 'panel covers the whole map' };
  // Window coordinates are canvas-relative; the area is in page pixels.
  const x = pixel.x + canvas.left;
  const y = pixel.y + canvas.top;
  const round = (n) => Math.round(n);
  const at = { x: round(x), y: round(y) };
  const box = {
    left: round(area.left),
    top: round(area.top),
    right: round(area.right),
    bottom: round(area.bottom),
  };
  const width = area.right - area.left;
  const height = area.bottom - area.top;
  const offset = {
    dx: round(x - (area.left + width / 2)),
    dy: round(y - (area.top + height / 2)),
  };
  const inside =
    x >= area.left + margin &&
    x <= area.right - margin &&
    y >= area.top + margin &&
    y <= area.bottom - margin;
  if (!inside)
    return {
      ok: false,
      reason: `site pin at (${at.x}, ${at.y}) is outside the open map area ${JSON.stringify(box)}`,
      pixel: at,
      area: box,
      offset,
    };
  if (probe.coveredBy)
    return {
      ok: false,
      reason: `site pin at (${at.x}, ${at.y}) is covered by ${probe.coveredBy}`,
      pixel: at,
      area: box,
      offset,
    };
  const centered =
    Math.abs(offset.dx) <= tolerance * width &&
    Math.abs(offset.dy) <= tolerance * height;
  if (!centered)
    return {
      ok: false,
      reason: `site pin at (${at.x}, ${at.y}) is ${offset.dx}, ${offset.dy} px from the open map center, limit ${round(tolerance * width)}, ${round(tolerance * height)}`,
      pixel: at,
      area: box,
      offset,
    };
  return {
    ok: true,
    reason: `site pin at (${at.x}, ${at.y}), ${offset.dx}, ${offset.dy} px from the open map center`,
    pixel: at,
    area: box,
    offset,
  };
}

/** How far the aimed point may miss the surveyed site before the landing fails. */
export const MAX_MISS_M = 75;
/**
 * How far the camera may stand off the site. The CRE landing settles at
 * SITE_VIEW_HEIGHT_M (650 m, 560 m narrow), so this is generous; it exists
 * because a camera flown straight up over the site keeps the pin centred and
 * the aim point unchanged, and nothing else in the harness would notice.
 */
export const MAX_RANGE_M = 5_000;

/** Great-circle metres between two WGS84 points. */
export function haversineM(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_008.8 * Math.asin(Math.sqrt(a));
}

/**
 * Where the camera is aimed: the line of sight through a pixel, intersected
 * with the surface `height` metres above the ellipsoid. Self-contained on
 * purpose: the harness passes its source to page.evaluate.
 *
 * `height` must be the height the globe was RENDERED at, not surveyed ground.
 * The old check used surveyed ground plus 30 m, the same wrong assumption as
 * the landing it tested, so it passed while the pin was off screen (B1-02).
 * pickPosition is not used: under SwiftShader it read garbage depth.
 * @param {number} height
 * @param {{x:number, y:number}} at - Page pixel to shoot the ray through.
 */
export function probeAimPoint(height, at) {
  const viewer = globalThis.__godsEyeView?.viewer;
  const C = globalThis.__CESIUM__;
  if (!viewer || !C) return null;
  const rect = viewer.canvas.getBoundingClientRect();
  const ray = viewer.camera.getPickRay(
    new C.Cartesian2(at.x - rect.left, at.y - rect.top),
  );
  const wgs84 = C.Ellipsoid.WGS84.radii;
  const raised = new C.Ellipsoid(
    wgs84.x + height,
    wgs84.y + height,
    wgs84.z + height,
  );
  const hit = ray && C.IntersectionTests.rayEllipsoid(ray, raised);
  if (!hit) return null;
  const point = C.Ray.getPoint(ray, hit.start);
  const carto = C.Cartographic.fromCartesian(point);
  return {
    lat: C.Math.toDegrees(carto.latitude),
    lon: C.Math.toDegrees(carto.longitude),
  };
}

/**
 * The CRE site pin and rings the app actually drew, plus the camera position.
 * Self-contained on purpose: the harness passes its source to page.evaluate.
 * A negative case reads this to prove no site was marked.
 */
export function probeSiteOverlay() {
  const viewer = globalThis.__godsEyeView?.viewer;
  const C = globalThis.__CESIUM__;
  const source = globalThis.__creDossier?.overlays?.source;
  const camera =
    viewer && viewer.camera
      ? [
          viewer.camera.positionWC.x,
          viewer.camera.positionWC.y,
          viewer.camera.positionWC.z,
        ]
      : null;
  if (!source || !C)
    return {
      error: source ? 'Cesium global missing' : 'CRE overlay source missing',
      camera,
    };
  const entities = source.entities.values;
  const pins = [];
  for (const entity of entities) {
    if (!/:site:/.test(String(entity.id))) continue;
    const position = entity.position?.getValue?.(C.JulianDate.now());
    if (!position) {
      pins.push({ lat: null, lon: null });
      continue;
    }
    const carto = C.Cartographic.fromCartesian(position);
    pins.push({
      lat: C.Math.toDegrees(carto.latitude),
      lon: C.Math.toDegrees(carto.longitude),
    });
  }
  return {
    camera,
    entityCount: entities.length,
    pinCount: pins.length,
    pins,
    ringCount: entities.filter((entity) => /:ring-/.test(String(entity.id)))
      .length,
  };
}

/**
 * Pass or fail a landing: the aimed point must be within `maxMissM` of the
 * surveyed site, the camera must be within `maxRangeM` of it, AND the pin
 * must sit in the open map area. Any missing measurement is a FAIL, never a
 * pass.
 * @param {{distanceM: number|null, rangeM: number|null, screen: {ok:boolean, reason:string}|null}} measured
 * @param {{maxMissM?: number, maxRangeM?: number}} [options]
 * @returns {{ok: boolean, reason: string}}
 */
export function judgeLanding(
  { distanceM = null, rangeM = null, screen = null } = {},
  { maxMissM = MAX_MISS_M, maxRangeM = MAX_RANGE_M } = {},
) {
  if (!screen) return { ok: false, reason: 'no screen-space measurement' };
  if (!Number.isFinite(distanceM))
    return { ok: false, reason: 'no landing distance measurement' };
  if (!Number.isFinite(rangeM))
    return { ok: false, reason: 'no camera range measurement' };
  if (distanceM >= maxMissM)
    return {
      ok: false,
      reason: `camera aimed ${Math.round(distanceM)} m from the site, limit ${maxMissM} m`,
    };
  if (rangeM >= maxRangeM)
    return {
      ok: false,
      reason: `camera ${Math.round(rangeM)} m from the site, limit ${maxRangeM} m`,
    };
  if (!screen.ok)
    return { ok: false, reason: `site not in the open map: ${screen.reason}` };
  return {
    ok: true,
    reason: `aimed ${Math.round(distanceM)} m from the site at ${Math.round(rangeM)} m range, ${screen.reason}`,
  };
}

/**
 * Pass or fail a negative search: the app must report no match, leave the
 * camera where it was, draw no site pin, and render no ready dossier values.
 * @param {{state: string|null, ready: number, movedM: number|null, pinCount: number|null, overlayError?: string|null}} observed
 * @param {{maxMoveM?: number, states?: string[]}} [options]
 * @returns {{ok: boolean, reason: string}}
 */
export function judgeNoMatch(
  { state = null, ready = null, movedM = null, pinCount = null, overlayError = null } = {},
  { maxMoveM = 50, states = ['no-match', 'outside-us'] } = {},
) {
  if (overlayError) return { ok: false, reason: `overlay unreadable: ${overlayError}` };
  if (!states.includes(String(state)))
    return {
      ok: false,
      reason: `expected the dossier to report ${states.join(' or ')}, found "${state}"`,
    };
  if (!Number.isFinite(ready))
    return { ok: false, reason: 'no ready-section count was read' };
  if (ready > 0)
    return {
      ok: false,
      reason: `no match reported but ${ready} sections still render real values`,
    };
  if (!Number.isFinite(movedM))
    return { ok: false, reason: 'no camera movement measurement' };
  if (movedM > maxMoveM)
    return {
      ok: false,
      reason: `camera flew ${Math.round(movedM)} m on an address with no match, limit ${maxMoveM} m`,
    };
  if (!Number.isFinite(pinCount))
    return { ok: false, reason: 'no site-pin count was read' };
  if (pinCount > 0)
    return { ok: false, reason: `${pinCount} site pin(s) drawn for an address with no match` };
  return {
    ok: true,
    reason: `"${state}", no ready values, camera held within ${Math.round(movedM)} m, no site pin`,
  };
}

/** The defects a harness can inject into a live page to prove it still fails. */
export const QA_FAULTS = Object.freeze([
  'fly',
  'far',
  'pin',
  'zero',
  'usd0',
  'blank',
  'ready',
]);

/**
 * Break the live page on purpose, so a checker can be watched failing on a
 * known-bad state instead of being trusted because it says PASS. Runs right
 * before the assertions read the page. Self-contained on purpose: the
 * harness passes its source to page.evaluate.
 *
 * - `fly`    camera 5,600 km straight up (the B2-03 flight the old dossier
 *            harness called PASS)
 * - `far`    camera pulled 5,600 km back along its own view direction: the
 *            aim point and the pin's pixel do not move at all, so only the
 *            range check can see it
 * - `pin`    draw a site pin and rings where none belong
 * - `zero`   replace the leading number of every value cell with 0, units
 *            kept
 * - `usd0`   render EVERY value cell as "0 USD": the S3-6 build where every
 *            ACS median came back $0 and still counted 12 of 12 sections
 * - `blank`  replace every value cell with a dash placeholder
 * - `ready`  claim data-dossier-state="ready" whatever the panel holds
 * @param {string} fault
 * @param {{lat:number, lon:number}|null} at - Where `pin` should draw.
 */
export function applyPageFault(fault, at) {
  const viewer = globalThis.__godsEyeView?.viewer;
  const C = globalThis.__CESIUM__;
  if (fault === 'fly') {
    if (!viewer || !C) return { applied: false, why: 'no viewer' };
    const from = viewer.camera.positionWC;
    const up = C.Cartesian3.multiplyByScalar(
      C.Cartesian3.normalize(from, new C.Cartesian3()),
      5_600_000,
      new C.Cartesian3(),
    );
    // Keep the orientation: straight up over the site is the B2-03 flight,
    // and it leaves the pin dead centre and the aim point unmoved.
    viewer.camera.setView({
      destination: C.Cartesian3.add(from, up, new C.Cartesian3()),
      orientation: {
        heading: viewer.camera.heading,
        pitch: viewer.camera.pitch,
        roll: viewer.camera.roll,
      },
    });
    return { applied: true };
  }
  if (fault === 'far') {
    if (!viewer) return { applied: false, why: 'no viewer' };
    viewer.camera.zoomOut(5_600_000);
    return { applied: true };
  }
  if (fault === 'pin') {
    const overlays = globalThis.__creDossier?.overlays;
    if (!overlays) return { applied: false, why: 'no CRE overlays' };
    overlays.drawSite(at?.lat ?? 36.320692, at?.lon ?? -82.342509);
    return { applied: true };
  }
  if (fault === 'zero' || fault === 'blank' || fault === 'usd0') {
    const cells = [...document.querySelectorAll('[data-dossier-value]')];
    for (const cell of cells) {
      const text = String(cell.textContent ?? '');
      if (fault === 'blank') cell.textContent = '-';
      else if (fault === 'usd0') cell.textContent = '0 USD';
      else
        cell.textContent = text.replace(
          /^([-+]?\s?\$?\s?)[\d,]+(\.\d+)?/,
          '$10',
        );
    }
    return { applied: true, cells: cells.length };
  }
  if (fault === 'ready') {
    const panel = document.querySelector('[data-dossier-state]');
    if (!panel) return { applied: false, why: 'no dossier panel' };
    panel.setAttribute('data-dossier-state', 'ready');
    return { applied: true };
  }
  return { applied: false, why: `unknown fault "${fault}"` };
}
