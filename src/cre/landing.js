// Straight-down site view after a search: the camera plan (position, height, heading, pitch) that puts the site in the middle of the open map, clear of the dossier on wide and phone layouts.
import { destinationPoint } from './geo.js';

/** Camera height over the rendered ground for the site view, meters. */
export const SITE_VIEW_HEIGHT_M = 650;
export const SITE_VIEW_HEIGHT_NARROW_M = 560;
/** On a phone the dossier is a bottom sheet; the site sits this far down the screen. */
export const NARROW_SITE_SCREEN_Y = 0.16;

/**
 * Where the site should appear across a wide screen, as a fraction of the
 * canvas width: the middle of the map strip right of the dossier panel.
 * @param {number} canvasWidth
 * @param {number} panelRight Right edge of the dossier panel in canvas pixels (0 when hidden).
 */
export function wideSiteScreenX(canvasWidth, panelRight) {
  if (!(canvasWidth > 0)) return 0.5;
  const right = Math.min(Math.max(Number(panelRight) || 0, 0), canvasWidth);
  if (right > canvasWidth * 0.6) return 0.5;
  return (right + canvasWidth) / 2 / canvasWidth;
}

/** Fit a study ring inside the uncovered map strip beside the dossier. */
export function areaFramePlan(
  canvasWidth,
  canvasHeight,
  panelRight,
  ringRadiusM,
) {
  const width = Math.max(1, Number(canvasWidth) || 1);
  const height = Math.max(1, Number(canvasHeight) || 1);
  const right = Math.min(Math.max(Number(panelRight) || 0, 0), width);
  const useOpenStrip = width > 720 && right > 0 && right <= width * 0.6;
  const usableWidth = useOpenStrip ? width - right : width;
  const screenX = useOpenStrip ? wideSiteScreenX(width, right) : 0.5;
  // A bounding-sphere fly-to draws roughly 90% of the shorter viewport side.
  // Leave a further 12% width margin so the ring outline clears the panel.
  const fitFactor = Math.max(1, (0.9 * height) / (0.88 * usableWidth));
  const fitRadiusM = ringRadiusM * fitFactor;
  return {
    fitRadiusM,
    screenX,
    westShiftM: Math.max(
      0,
      (screenX - 0.5) * 2 * fitRadiusM * (width / height),
    ),
  };
}

/**
 * Straight-down site view: where the camera goes after a search in CRE mode.
 * Looking straight down, the site's screen position does not depend on the
 * height the ground is drawn at, so a flat globe and a terrain globe land
 * the same. On a wide screen the camera slides west so the site sits in the
 * middle of the map right of the dossier (screenX); on a narrow screen it
 * slides south so the site sits above the bottom sheet.
 * @param {{lat:number, lon:number}} site
 * @param {{groundM?:number, narrow?:boolean, screenX?:number, fovRad?:number}} [options]
 *   fovRad is the camera's field of view, which Cesium applies to the longer screen side.
 * @returns {{lat:number, lon:number, height:number, heading:number, pitchDeg:number}}
 */
export function siteViewPlan(
  site,
  { groundM = 0, narrow = false, screenX = 0.5, fovRad = Math.PI / 3 } = {},
) {
  const above = narrow ? SITE_VIEW_HEIGHT_NARROW_M : SITE_VIEW_HEIGHT_M;
  const fov = Number.isFinite(fovRad) && fovRad > 0 ? fovRad : Math.PI / 3;
  const span = 2 * above * Math.tan(fov / 2);
  let at = { lat: site.lat, lon: site.lon };
  if (narrow) {
    // Portrait: the field of view is vertical.
    const shift = (0.5 - NARROW_SITE_SCREEN_Y) * span;
    at = destinationPoint(site.lat, site.lon, 180, shift);
  } else if (Number.isFinite(screenX) && screenX !== 0.5) {
    // Landscape: the field of view is horizontal, heading north, east right.
    const shift = (screenX - 0.5) * span;
    at = destinationPoint(
      site.lat,
      site.lon,
      shift > 0 ? 270 : 90,
      Math.abs(shift),
    );
  }
  return {
    lat: at.lat,
    lon: at.lon,
    height: (Number.isFinite(groundM) ? groundM : 0) + above,
    heading: 0,
    pitchDeg: -90,
  };
}
