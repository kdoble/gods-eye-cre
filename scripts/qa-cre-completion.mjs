// Opt-in browser acceptance for the public-source CRE completion slice.
// Runs in an isolated browser, writes evidence under /private/tmp, and never
// changes saved sites or connected services.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer';

const base = process.env.QA_BASE_URL || 'http://127.0.0.1:4280';
const output = process.env.QA_OUTPUT_DIR || '/private/tmp/cre-completion-qa';
await fs.mkdir(output, { recursive: true });
const result = {
  startedAt: new Date().toISOString(),
  base,
  checks: [],
  coverage: {},
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
const page = await browser.newPage();
page.on('pageerror', (error) => result.errors.push(error.message));
const check = (label, condition) => {
  assert.ok(condition, label);
  result.checks.push(label);
};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function search(address, latitude) {
  await page.click('#location-search', { clickCount: 3 });
  await page.keyboard.press('Backspace');
  await page.type('#location-search', address);
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    (lat) => {
      const snapshot = window.__creDossier?.getSnapshot();
      return (
        snapshot?.ctx &&
        Math.abs(snapshot.ctx.lat - lat) < 0.08 &&
        ['ready', 'partial'].includes(snapshot.state)
      );
    },
    { timeout: 120000 },
    latitude,
  );
  await delay(500);
  return page.evaluate(() => window.__creDossier.getSnapshot());
}

async function preview(label) {
  const targetReady = browser.waitForTarget(
    (target) => target.opener() === page.target(),
    { timeout: 12000 },
  );
  await page.click('[data-cre-map-preview]');
  const target = await targetReady;
  const popup = await target.page();
  await popup.waitForSelector('.context-map svg', { timeout: 12000 });
  const details = await popup.evaluate(() => ({
    layers: [
      ...document.querySelectorAll('.context-map [data-cre-map-layer]'),
    ].map((node) => node.getAttribute('data-cre-map-layer')),
    triangle: Boolean(
      document.querySelector(
        '.context-map svg path[d="M270 200 287 232H253Z"]',
      ),
    ),
    siteLabel: [...document.querySelectorAll('.context-map svg text')].some(
      (node) => node.textContent === 'SITE',
    ),
    chainLabels: document.querySelectorAll('.context-map svg [data-chain-label]').length,
    caption:
      document.querySelector('.context-map figcaption')?.textContent || '',
    articleLinks: document.querySelectorAll('.context-map a').length,
  }));
  await popup.screenshot({
    path: path.join(output, `${label}-preview.png`),
    fullPage: true,
  });
  await popup.pdf({
    path: path.join(output, `${label}.pdf`),
    printBackground: true,
  });
  await popup.close();
  return details;
}

try {
  await page.setViewport({ width: 990, height: 872 });
  await page.goto(`${base}/?mode=cre&welcome=0`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForFunction(
    () =>
      window.__creDossier &&
      document.getElementById('loading-screen')?.classList.contains('hidden'),
    { timeout: 90000 },
  );
  const dallas = await search('9505 Royal Ln, Dallas, TX 75243', 32.89);
  result.coverage.dallas = Object.fromEntries(
    dallas.sections.map((entry) => [entry.id, entry.status]),
  );
  const workplaceCount = (
    dallas.sections.find((entry) => entry.id === 'destinations')?.result
      ?.overlays || []
  )
    .flatMap((overlay) => overlay.geojson?.features || [])
    .filter(
      (feature) =>
        feature.properties?.category === 'employers' &&
        feature.properties?.named === true,
    ).length;
  result.coverage.workplaceCandidates = workplaceCount;
  if (workplaceCount)
    check(
      'Named workplace source geometry enables its own map layer',
      await page.$eval('[data-layer-id="employers"]', (node) => !node.disabled),
    );
  const nav = await page.evaluate(() =>
    [...document.querySelectorAll('#dossier-panel [data-view]')].map((node) => {
      const a = node.getBoundingClientRect(),
        b = document
          .querySelector('#dossier-panel .cre-dossier-views')
          .getBoundingClientRect();
      return {
        view: node.getAttribute('data-view'),
        visible: a.left >= b.left - 1 && a.right <= b.right + 1,
      };
    }),
  );
  check(
    'All six dossier views remain visible without a horizontal tab scroll',
    nav.length === 6 && nav.every((item) => item.visible),
  );
  await page.screenshot({ path: path.join(output, 'dallas-desktop.png') });
  const site = await page.evaluate(() => {
    const entities = window.__creDossier.overlays.source.entities.values;
    const entry = entities.find((item) => String(item.id).includes(':site:'));
    return {
      billboard: Boolean(entry?.billboard),
      label: entry?.label?.text?.getValue?.() || '',
    };
  });
  check(
    'Live site has a dedicated SITE billboard',
    site.billboard && site.label === 'SITE',
  );
  await page.click('#dossier-panel [data-view="map"]');
  await page.evaluate(() =>
    document
      .querySelector('#dossier-panel .cre-workspace-actions button')
      ?.click(),
  );
  await delay(1900);
  const projectedRing = await page.evaluate(() => {
    const viewer = window.__godsEyeView?.viewer;
    const ring = window.__creDossier.overlays.source.entities.values.find(
      (entry) => String(entry.id).includes('ring-1mi'),
    );
    const positions = ring?.polyline?.positions?.getValue?.(
      viewer?.clock.currentTime,
    );
    const canvas = viewer?.canvas;
    const canvasRect = canvas?.getBoundingClientRect();
    const panelRight =
      document.querySelector('#dossier-panel')?.getBoundingClientRect().right -
      canvasRect.left;
    return {
      width: canvas?.clientWidth,
      height: canvas?.clientHeight,
      panelRight,
      cardinal: [0, 16, 32, 48].map((index) => {
        const point = viewer?.scene.cartesianToCanvasCoordinates(
          positions?.[index],
        );
        return point ? { x: point.x, y: point.y } : null;
      }),
    };
  });
  result.coverage.projectedRing990 = projectedRing;
  check(
    'Framed study-ring cardinal points clear the desktop dossier',
    projectedRing.cardinal.every(
      (point) =>
        point &&
        point.x >= projectedRing.panelRight + 8 &&
        point.x <= projectedRing.width - 8 &&
        point.y >= 8 &&
        point.y <= projectedRing.height - 8,
    ),
  );
  const flood = await page.$('[data-layer-id="flood"]');
  const otherHazards = await page.$('[data-layer-id="hazards"]');
  check(
    'Flood has its own toggle beside other hazards',
    Boolean(flood && otherHazards),
  );
  const otherHazardsAvailable = await page.$eval(
    '[data-layer-id="hazards"]',
    (node) => !node.disabled,
  );
  await page.$eval('[data-layer-id="hazards"]', (node) => {
    if (node.checked && !node.disabled) node.click();
  });
  await page.$eval('[data-layer-id="flood"]', (node) => {
    if (!node.checked && !node.disabled) node.click();
  });
  const category = await page.$eval(
    '[data-cre-crime-category]',
    (node) =>
      [...node.options].find((item) => item.value !== 'all')?.value || 'all',
  );
  await page.select('[data-cre-crime-mode]', 'density');
  if (category !== 'all')
    await page.select('[data-cre-crime-category]', category);
  const selected = await page.evaluate(
    () => window.__creDossier.getExport().mapSelection,
  );
  result.coverage.selectedMapFilter = { requestedCategory: category, selected };
  check(
    'Live filter state is the exported map selection',
    selected.crimeMode === 'density' &&
      selected.crimeCategory === category &&
      (!otherHazardsAvailable || selected.layers.hazards === false),
  );
  const dallasPreview = await preview('dallas');
  check(
    'Export has SITE triangle and label',
    dallasPreview.triangle && dallasPreview.siteLabel,
  );
  check(
    'Export omits disabled other hazards',
    !dallasPreview.layers.includes('hazards'),
  );
  check(
    'Export discloses selected extent and observation dates',
    /Rectangular export extent/.test(dallasPreview.caption) &&
      /retrieval and observation dates/.test(dallasPreview.caption),
  );
  if (
    result.coverage.dallas.neighborhood === 'ready' ||
    result.coverage.dallas.neighborhood === 'partial'
  )
    check(
      'Filtered reported offense layer appears in map export',
      dallasPreview.layers.includes('crime'),
    );
  if (
    !flood ||
    !(await page.$eval('[data-layer-id="flood"]', (node) => !node.disabled))
  )
    result.coverage.flood = 'No selected-radius geometry returned';
  else
    check(
      'FEMA flood geometry appears independently',
      dallasPreview.layers.includes('flood'),
    );
  await page.click('#dossier-panel [data-view="news"]');
  check(
    'News, housing market and projects have visible cards',
    await page.evaluate(() =>
      ['local-news', 'market', 'development'].every((id) =>
        document.querySelector(`[data-cre-topic="${id}"]`),
      ),
    ),
  );
  result.coverage.newsLinks = await page.$$eval(
    '[data-cre-topic="local-news"] .cre-topic-direct',
    (nodes) => nodes.length,
  );
  await page.click('[data-cre-update]');
  await page.waitForFunction(
    () => window.__creDossier.getSnapshot().refreshing === false,
    { timeout: 90000 },
  );
  const refreshed = await page.evaluate(() =>
    window.__creDossier.getSnapshot(),
  );
  check(
    'Manual Update settles every topic with an explicit outcome',
    refreshed.sections.every(
      (entry) => entry.refresh?.status && entry.refresh.status !== 'loading',
    ),
  );
  result.coverage.update = Object.fromEntries(
    refreshed.sections.map((entry) => [entry.id, entry.refresh?.status]),
  );
  await page.screenshot({ path: path.join(output, 'dallas-update.png') });
  await page.setViewport({ width: 390, height: 844 });
  await page.click('#dossier-panel [data-view="map"]');
  const mobile = await page.evaluate(() => {
    const body = document.querySelector('#dossier-panel .cre-dossier-body');
    body.scrollTop = body.scrollHeight;
    return {
      overflow: body.scrollWidth > body.clientWidth + 2,
      mapVisible: !document.querySelector('#dossier-panel [data-view="map"]')
        .hidden,
    };
  });
  check('Mobile dossier has no horizontal overflow', !mobile.overflow);
  await page.click('[data-cre-back-to-top]');
  await page.waitForFunction(
    () =>
      document.querySelector('#dossier-panel .cre-dossier-body').scrollTop < 4,
    { timeout: 5000 },
  );
  await page.click('[data-cre-frame-site]');
  await delay(2300);
  await page.screenshot({ path: path.join(output, 'dallas-mobile.png') });
  await page.setViewport({ width: 990, height: 872 });
  const atlanta = await search('675 Ponce de Leon Ave NE, Atlanta, GA', 33.77);
  result.coverage.atlanta = Object.fromEntries(
    atlanta.sections.map((entry) => [entry.id, entry.status]),
  );
  await page.click('#dossier-panel [data-view="map"]');
  const atlantaPreview = await preview('atlanta');
  result.coverage.atlantaChainLabelCount = atlantaPreview.chainLabels;
  check(
    'At least one neutral retailer mark is embedded in a site map export',
    dallasPreview.chainLabels + atlantaPreview.chainLabels > 0,
  );
  check(
    'Second address replaced the first dossier',
    Math.abs(atlanta.ctx.lat - dallas.ctx.lat) > 0.5,
  );
  const jupiter = await search('12660 Jupiter Road, Dallas, TX', 32.86);
  result.coverage.jupiter = Object.fromEntries(
    jupiter.sections.map((entry) => [entry.id, entry.status]),
  );
  check(
    'Jupiter address replaces Atlanta with Dallas local context',
    /JUPITER/i.test(jupiter.ctx.address || '') &&
      jupiter.sections.find((entry) => entry.id === 'neighborhood')?.result
        ?.jurisdiction?.id === 'dallas-tx',
  );
  const plano = await search('1520 K Ave, Plano, TX 75074', 33.02);
  const planoLocal = plano.sections.find(
    (entry) => entry.id === 'neighborhood',
  )?.result;
  result.coverage.plano = {
    address: plano.ctx.address,
    jurisdiction: planoLocal?.jurisdiction?.status || null,
    crime: planoLocal?.evidence?.crime?.coverage || null,
  };
  check(
    'Uncovered city does not inherit Dallas offense findings',
    planoLocal?.jurisdiction?.id !== 'dallas-tx' &&
      !(planoLocal?.values || []).some((value) =>
        /Dallas reported offense records/.test(value.label),
      ),
  );
  result.finishedAt = new Date().toISOString();
} catch (error) {
  result.errors.push(error.stack || String(error));
  process.exitCode = 1;
} finally {
  await fs.writeFile(
    path.join(output, 'result.json'),
    JSON.stringify(result, null, 2),
  );
  await browser.close();
  console.log(JSON.stringify(result, null, 2));
}
