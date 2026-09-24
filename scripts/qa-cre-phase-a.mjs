// Opt-in, fresh-browser Phase A acceptance. Optional upstream gaps are reported
// as coverage, while broken controls, false map geometry and page errors fail.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { mapLayerForFeature } from '../src/cre/mapSelection.js';
import { haversineMeters } from '../src/cre/geo.js';

const out = process.env.QA_OUTPUT_DIR || '/private/tmp/cre-phase-a-qa';
const base = process.env.QA_BASE_URL || 'http://127.0.0.1:4280';
await fs.mkdir(out, { recursive: true });
const report = {
  startedAt: new Date().toISOString(),
  base,
  sites: [],
  checks: [],
  coverageGaps: [],
  networkFailures: [],
  requestFailures: [],
  consoleIssues: [],
  pageErrors: [],
  errors: [],
};
const browser = await puppeteer.launch({
  headless: true,
  ...(process.env.PUPPETEER_EXECUTABLE_PATH
    ? { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH }
    : {}),
  args:
    process.platform === 'darwin'
      ? ['--use-angle=metal', '--enable-gpu']
      : ['--use-angle=swiftshader', '--enable-webgl', '--no-sandbox'],
});
let page;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const safeUrl = (raw) => {
  try {
    const url = new URL(raw);
    return `${url.origin}${url.pathname}`;
  } catch {
    return 'invalid-url';
  }
};
const safeMessage = (raw) =>
  String(raw)
    .replace(/https?:\/\/[^\s)'"<>]+/g, (url) => safeUrl(url))
    .replace(/(key|token|secret|authorization)=([^\s&]+)/gi, '$1=[REDACTED]')
    .slice(0, 400);
async function addressSearch(address, expectedLat) {
  const started = Date.now();
  await page.click('#location-search', { clickCount: 3 });
  await page.keyboard.press('Backspace');
  await page.type('#location-search', address);
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    (lat) => {
      const snap = window.__creDossier?.getSnapshot();
      return (
        snap?.ctx &&
        Math.abs(snap.ctx.lat - lat) < 0.08 &&
        ['ready', 'partial'].includes(snap.state)
      );
    },
    { timeout: 120000 },
    expectedLat,
  );
  // Allow section rendering and address controls to settle before export.
  await delay(2800);
  await page.waitForFunction(
    (lat) => {
      const snap = window.__creDossier?.getSnapshot();
      return (
        snap?.ctx &&
        Math.abs(snap.ctx.lat - lat) < 0.08 &&
        ['ready', 'partial'].includes(snap.state)
      );
    },
    { timeout: 15000 },
    expectedLat,
  );
  return {
    snapshot: await page.evaluate(() => window.__creDossier.getSnapshot()),
    seconds: (Date.now() - started) / 1000,
  };
}
async function view(name) {
  await page.click(`#dossier-panel [data-view="${name}"]`);
  await page.waitForFunction(
    (role) =>
      document
        .querySelector(`#dossier-panel [data-view="${role}"]`)
        ?.getAttribute('aria-pressed') === 'true',
    { timeout: 6000 },
    name,
  );
  return page.$eval('#dossier-panel', (node) => node.innerText);
}
async function bringMobileControlIntoView(selector) {
  await page.$eval(selector, (node) =>
    node.scrollIntoView({ block: 'center' }),
  );
  await delay(250);
  return page.evaluate((selected) => {
    const node = document.querySelector(selected);
    const rect = node?.getBoundingClientRect();
    if (
      !rect ||
      rect.width <= 0 ||
      rect.height <= 0 ||
      rect.top < 0 ||
      rect.bottom > innerHeight ||
      rect.left < 0 ||
      rect.right > innerWidth
    )
      return false;
    const hit = document.elementFromPoint(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
    );
    return hit === node || node.contains(hit);
  }, selector);
}
function expectedNamedLabels(doc) {
  const radius = (doc.radiusMiles || 1) * 1609.344;
  let count = 0;
  for (const section of doc.sections || [])
    for (const overlay of section.overlays || []) {
      for (const feature of overlay.geojson?.features || []) {
        if (
          feature?.geometry?.type !== 'Point' ||
          feature.properties?.named !== true ||
          !feature.properties?.name
        )
          continue;
        const layer = mapLayerForFeature(
          section.id,
          overlay.id,
          feature.properties,
        );
        if (!doc.mapSelection.layers[layer]) continue;
        const [lon, lat] = feature.geometry.coordinates || [];
        if (
          Number.isFinite(lat) &&
          Number.isFinite(lon) &&
          haversineMeters(doc.site.lat, doc.site.lon, lat, lon) <= radius
        )
          count++;
      }
    }
  return count;
}
async function mapPreview(siteName, selection, doc) {
  const targetPromise = browser.waitForTarget(
    (target) => target.opener() === page.target(),
    { timeout: 15000 },
  );
  await page.click('[data-cre-map-preview]');
  const target = await targetPromise;
  const preview = await target.page();
  preview.on('pageerror', (error) =>
    report.pageErrors.push(`${siteName} preview: ${error.message}`),
  );
  await preview.waitForSelector('.context-map svg', { timeout: 15000 });
  const data = await preview.evaluate(() => ({
    heading: document.querySelector('h1')?.textContent || '',
    caption:
      document.querySelector('.context-map figcaption')?.textContent || '',
    layerIds: [...document.querySelectorAll('[data-cre-map-layer]')].map((el) =>
      el.getAttribute('data-cre-map-layer'),
    ),
    namedLabelCount: document.querySelectorAll('[data-cre-map-layer] text')
      .length,
    namedLabels: [
      ...document.querySelectorAll('[data-cre-map-layer] text'),
    ].map((node) => ({
      layer: node
        .closest('[data-cre-map-layer]')
        ?.getAttribute('data-cre-map-layer'),
      text: node.textContent?.trim() || '',
    })),
    legend: [...document.querySelectorAll('.context-map figcaption span')].map(
      (node) => ({
        text: node.textContent?.replace('■', '').trim() || '',
        color: node.querySelector('b')?.style.color || '',
      }),
    ),
    labelsAboveGeometry: (() => {
      const group = document.querySelector('.context-map svg g[clip-path]');
      if (!group) return false;
      const children = [...group.children];
      const firstLabel = children.findIndex((node) =>
        node.hasAttribute('data-cre-map-label'),
      );
      const lastOverlay = children.findLastIndex((node) =>
        node.hasAttribute('data-source-overlay'),
      );
      const pin = children.findIndex(
        (node) =>
          node.tagName.toLowerCase() === 'path' &&
          node.getAttribute('d') === 'M270 200 287 232H253Z',
      );
      return firstLabel < 0 || (firstLabel > lastOverlay && firstLabel > pin);
    })(),
    svg: Boolean(document.querySelector('.context-map svg[role="img"]')),
    pngButton: Boolean(document.querySelector('[data-cre-map-png]')),
    printButton: [...document.querySelectorAll('button')].some((b) =>
      /Print \/ Save PDF/.test(b.textContent),
    ),
  }));
  assert.ok(data.heading.toLowerCase().includes(siteName));
  assert.ok(data.svg && data.pngButton && data.printButton);
  assert.ok(
    data.labelsAboveGeometry,
    'Labels draw above source geometry and site pin',
  );
  assert.match(
    data.caption,
    /Geometry-only map.*(?:source retrieval and observation dates|Source dates):/i,
  );
  for (const layer of data.layerIds)
    assert.notEqual(
      selection.layers[layer],
      false,
      `Export includes disabled ${layer} geometry`,
    );
  for (const layer of new Set(data.layerIds))
    assert.ok(
      data.legend.some((item) => item.text === layer && item.color),
      `Legend contains a colored ${layer} swatch`,
    );
  if (expectedNamedLabels(doc) > 0)
    assert.ok(
      data.namedLabelCount > 0,
      'Available named point geometry has a visible map label',
    );
  await preview.screenshot({
    path: path.join(out, `${siteName}-map-preview.png`),
  });
  const client = await preview.createCDPSession();
  await client.send('Page.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: out,
  });
  await fs.rm(path.join(out, 'selected-site-map.png'), { force: true });
  await preview.click('[data-cre-map-png]');
  let pngPath;
  for (let i = 0; i < 40; i++) {
    const files = await fs.readdir(out);
    const png = files.find((file) => file === 'selected-site-map.png');
    const stillWriting = files.some((file) => file.endsWith('.crdownload'));
    if (
      png &&
      !stillWriting &&
      (await fs.stat(path.join(out, png))).size > 5000
    ) {
      pngPath = path.join(out, png);
      break;
    }
    await delay(300);
  }
  assert.ok(pngPath, 'Map PNG download appeared');
  const png = await fs.readFile(pngPath);
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.ok(png.length > 5000, 'PNG contains rendered map');
  const pngWidth = png.readUInt32BE(16);
  const pngHeight = png.readUInt32BE(20);
  assert.equal(pngWidth, 1200);
  assert.ok(
    pngHeight >= 1140 && pngHeight <= 1115 + 231 * 31,
    'PNG has bounded room for the source caption',
  );
  await fs.rename(pngPath, path.join(out, `${siteName}-map.png`));
  const pdfPath = path.join(out, `${siteName}-map.pdf`);
  await preview.pdf({
    path: pdfPath,
    printBackground: true,
    preferCSSPageSize: true,
  });
  const pdf = await fs.readFile(pdfPath);
  assert.equal(pdf.subarray(0, 4).toString(), '%PDF');
  assert.ok(pdf.length > 5000, 'PDF contains printable map');
  await preview.close();
  return {
    ...data,
    pngBytes: png.length,
    pngWidth,
    pngHeight,
    pdfBytes: pdf.length,
  };
}

try {
  page = await browser.newPage(); // Fresh profile: never opens the user's browser storage.
  page.on('pageerror', (error) => report.pageErrors.push(error.message));
  page.on('requestfailed', (request) =>
    report.requestFailures.push({
      url: safeUrl(request.url()),
      reason: safeMessage(request.failure()?.errorText || 'unknown'),
    }),
  );
  page.on('console', (message) => {
    if (['warning', 'error'].includes(message.type()))
      report.consoleIssues.push({
        type: message.type(),
        text: safeMessage(message.text()),
      });
  });
  page.on('response', (response) => {
    if (response.status() >= 400)
      report.networkFailures.push({
        status: response.status(),
        url: safeUrl(response.url()),
      });
  });
  await page.setViewport({ width: 1440, height: 1000 });
  await page.goto(`${base}/?mode=cre&welcome=0`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForFunction(
    () =>
      window.__creDossier &&
      document.getElementById('loading-screen')?.classList.contains('hidden'),
    { timeout: 90000 },
  );
  for (const site of [
    { name: 'dallas', address: '12660 Jupiter Road, Dallas, TX', lat: 32.86 },
    {
      name: 'atlanta',
      address: '675 Ponce de Leon Ave NE, Atlanta, GA',
      lat: 33.77,
    },
  ]) {
    const { snapshot, seconds } = await addressSearch(site.address, site.lat);
    const sections = snapshot.sections.map((item) => ({
      id: item.id,
      status: item.status,
      message: item.result?.message || null,
      retrievedAt: item.result?.retrievedAt || null,
    }));
    report.sites.push({
      name: site.name,
      confirmedAddress: snapshot.ctx.address,
      lat: snapshot.ctx.lat,
      lon: snapshot.ctx.lon,
      seconds,
      state: snapshot.state,
      sections,
    });
    for (const section of sections)
      if (['partial', 'unavailable'].includes(section.status))
        report.coverageGaps.push({
          site: site.name,
          section: section.id,
          status: section.status,
          message: section.message,
        });
    for (const role of ['investor', 'developer']) {
      const text = await view(role);
      assert.match(
        text,
        role === 'investor' ? /Investor|Acquisition/i : /Developer|Parcel/i,
      );
      await page.screenshot({
        path: path.join(out, `${site.name}-${role}.png`),
      });
    }
    await view('map');
    await page.select('[data-cre-map-preset]', 'presentation');
    await page.select('[data-cre-label-density]', 'off');
    const exportBefore = await page.evaluate(() =>
      window.__creDossier.getExport(),
    );
    assert.equal(exportBefore.mapSelection?.preset, 'presentation');
    assert.equal(exportBefore.mapSelection?.labelDensity, 'off');
    await page.select('[data-cre-label-density]', 'key');
    const available = await page.$$eval('[data-layer-id]', (nodes) =>
      nodes
        .filter((node) => !node.disabled && node.checked)
        .map((node) => node.getAttribute('data-layer-id')),
    );
    const layerToDisable = available.includes('schools')
      ? 'schools'
      : available[0];
    if (layerToDisable) await page.click(`[data-layer-id="${layerToDisable}"]`);
    else
      report.coverageGaps.push({
        site: site.name,
        section: 'map',
        status: 'no-available-layer',
        message: 'No selected layer had source geometry to toggle.',
      });
    const selection = await page.evaluate(
      () => window.__creDossier.getExport().mapSelection,
    );
    assert.equal(selection.labelDensity, 'key');
    if (layerToDisable) assert.equal(selection.layers[layerToDisable], false);
    const exportDoc = await page.evaluate(() =>
      window.__creDossier.getExport(),
    );
    const preview = await mapPreview(site.name, selection, exportDoc);
    report.sites.at(-1).map = {
      selectedLayers: Object.entries(selection.layers)
        .filter(([, enabled]) => enabled)
        .map(([id]) => id),
      renderedLayers: [...new Set(preview.layerIds)],
      namedLabelCount: preview.namedLabelCount,
      namedLabels: preview.namedLabels,
      legend: preview.legend,
      pngBytes: preview.pngBytes,
      pngWidth: preview.pngWidth,
      pngHeight: preview.pngHeight,
      pdfBytes: preview.pdfBytes,
      sourceCaption: preview.caption,
    };
    assert.match(
      preview.caption,
      /(?:source retrieval and observation dates|Source dates):/i,
    );
    if (
      site.name === 'dallas' &&
      sections.some(
        (section) =>
          section.id === 'destinations' && section.status === 'ready',
      ) &&
      preview.layerIds.includes('retail')
    )
      assert.ok(
        preview.namedLabels.some(
          (item) => item.layer === 'retail' && item.text,
        ),
        'Dallas has a visible named retailer when named destinations and retail geometry are available',
      );
    report.checks.push(
      `${site.name}: two roles; preset, label and layer controls; same selected map geometry; PNG and PDF`,
    );
  }
  const dallasCamera = report.sites[0].sections.find(
    (section) => section.id === 'cameras',
  );
  const atlantaCamera = report.sites[1].sections.find(
    (section) => section.id === 'cameras',
  );
  assert.ok(
    dallasCamera && atlantaCamera,
    'Camera section exists in both sites',
  );
  const atlantaSnapshot = await page.evaluate(() =>
    window.__creDossier.getSnapshot(),
  );
  const atlantaCameras = atlantaSnapshot.sections.find(
    (section) => section.id === 'cameras',
  )?.result;
  assert.ok(
    !JSON.stringify(atlantaCameras).includes('txdot-dal-'),
    'Dallas cameras do not leak into Atlanta',
  );
  assert.match(JSON.stringify(atlantaCameras), /511 Georgia|511ga\.org/i);
  await page.setViewport({ width: 390, height: 844 });
  await view('map');
  await page.screenshot({ path: path.join(out, 'atlanta-mobile-map.png') });
  const presetVisible = await bringMobileControlIntoView(
    '[data-cre-map-preset]',
  );
  await page.screenshot({ path: path.join(out, 'atlanta-mobile-preset.png') });
  const densityVisible = await bringMobileControlIntoView(
    '[data-cre-label-density]',
  );
  const previewVisible = await bringMobileControlIntoView(
    '[data-cre-map-preview]',
  );
  await page.screenshot({
    path: path.join(out, 'atlanta-mobile-controls.png'),
  });
  const mobile = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth > innerWidth + 2,
  }));
  assert.equal(
    mobile.overflow,
    false,
    'Narrow mobile page has no horizontal overflow',
  );
  assert.ok(
    presetVisible && densityVisible && previewVisible,
    'Mobile map controls accessible',
  );
  report.checks.push(
    '390x844 map controls scrolled into viewport without horizontal overflow; site switch kept Georgia camera evidence',
  );
  assert.deepEqual(report.pageErrors, [], 'No uncaught page errors');
} catch (error) {
  report.errors.push(error.stack || String(error));
  process.exitCode = 1;
  if (page) {
    await page
      .screenshot({ path: path.join(out, 'failure.png') })
      .catch(() => {});
    report.diagnostic = await page
      .evaluate(() => ({
        url: location.pathname,
        readyState: document.readyState,
        loader: document.querySelector('#loading-screen')?.className,
        loaderText: document
          .querySelector('#loading-screen')
          ?.innerText?.slice(0, 300),
        hasDossier: Boolean(window.__creDossier),
        bodyText: document.body.innerText.slice(0, 1200),
      }))
      .catch(() => null);
  }
} finally {
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(
    path.join(out, 'results.json'),
    JSON.stringify(report, null, 2),
  );
  console.log(
    JSON.stringify(
      {
        sites: report.sites.map(({ name, state, seconds }) => ({
          name,
          state,
          seconds,
        })),
        checks: report.checks,
        coverageGaps: report.coverageGaps.length,
        pageErrors: report.pageErrors,
        errors: report.errors,
        output: out,
      },
      null,
      2,
    ),
  );
  await browser.close();
}
