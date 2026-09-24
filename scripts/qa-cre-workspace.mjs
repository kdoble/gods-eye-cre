// Opt-in live browser acceptance. Uses public sources; no keys are required.
import puppeteer from 'puppeteer';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { probeSiteScreen, judgeSiteOnScreen } from './qa-cre-screen-check.mjs';
const output = process.env.QA_OUTPUT_DIR || '/tmp/gods-eye-cre-workspace-qa';
await fs.mkdir(output, { recursive: true });
const browser = await puppeteer.launch({
  headless: true,
  args:
    process.platform === 'darwin'
      ? ['--use-angle=metal', '--enable-gpu']
      : [
          '--use-gl=angle',
          '--use-angle=swiftshader',
          '--enable-webgl',
          '--no-sandbox',
        ],
});
let testedPage = null;
const report = {
  startedAt: new Date().toISOString(),
  examples: [],
  checks: [],
  errors: [],
};
try {
  const page = await browser.newPage();
  testedPage = page;
  await page.setViewport({ width: 1440, height: 900 });
  page.on('pageerror', (e) => report.errors.push(e.message));
  await page.goto(
    `${process.env.QA_BASE_URL || 'http://127.0.0.1:4188'}/?mode=cre&welcome=0`,
    { waitUntil: 'domcontentloaded' },
  );
  await page.waitForFunction(
    () =>
      window.__creDossier &&
      document.getElementById('loading-screen')?.classList.contains('hidden'),
    { timeout: 90000 },
  );
  const button = async (text) => {
    const handle = await page.evaluateHandle(
      (t) =>
        [...document.querySelectorAll('#dossier-panel button')].find(
          (b) => b.textContent.trim() === t,
        ),
      text,
    );
    const element = handle.asElement();
    assert.ok(element, `Button ${text}`);
    await element.click();
  };
  const map = () => button('Map');
  const checkCamera = async () => {
    await new Promise((resolve) => setTimeout(resolve, 2800));
    const ctx = await page.evaluate(
      () => window.__creDossier.getSnapshot().ctx,
    );
    const probe = await page.evaluate(
      `(${probeSiteScreen})(${ctx.lat},${ctx.lon})`,
    );
    const verdict = judgeSiteOnScreen(probe);
    assert.equal(verdict.ok, true, JSON.stringify(verdict));
  };
  async function search(address) {
    await page.click('#location-search', { clickCount: 3 });
    await page.keyboard.press('Backspace');
    await page.type('#location-search', address);
    await page.keyboard.press('Enter');
    await page.waitForFunction(
      () =>
        window.__creDossier.getSnapshot().ctx &&
        ['ready', 'partial'].includes(window.__creDossier.getSnapshot().state),
      { timeout: 60000 },
    );
    const snapshot = await page.evaluate(() =>
      window.__creDossier.getSnapshot(),
    );
    assert.ok(snapshot.ctx.address);
    return snapshot;
  }
  for (const [name, address] of [
    ['testpoint', '601 E Main St, Johnson City, TN'],
    ['atlanta', '675 Ponce de Leon Ave NE, Atlanta, GA'],
    ['chicago', '1212 S Michigan Ave, Chicago, IL'],
  ]) {
    const start = Date.now(),
      snapshot = await search(address);
    report.examples.push({
      name,
      address: snapshot.ctx.address,
      seconds: (Date.now() - start) / 1000,
      status: snapshot.state,
      sections: snapshot.sections.map((e) => ({
        id: e.id,
        status: e.status,
        message: e.result?.message,
      })),
    });
    await button('Investor');
    await checkCamera();
    await page.screenshot({ path: path.join(output, `${name}-summary.png`) });
    await map();
    await page.screenshot({ path: path.join(output, `${name}-map.png`) });
    if (name === 'atlanta') {
      await button('Move location on map');
      const pixel = await page.evaluate(() => {
        const C = window.__CESIUM__,
          viewer = window.__godsEyeView.viewer;
        const p = C.SceneTransforms.worldToWindowCoordinates(
          viewer.scene,
          C.Cartesian3.fromDegrees(-84.3655, 33.7727),
        );
        const r = viewer.canvas.getBoundingClientRect();
        return { x: p.x + r.left, y: p.y + r.top };
      });
      await page.mouse.click(pixel.x, pixel.y);
      await page.waitForFunction(
        () => {
          const s = window.__creDossier.getSnapshot();
          return (
            s.ctx?.locationConfirmed === true &&
            Math.abs(s.ctx.lat - 33.7727) < 0.00003 &&
            ['ready', 'partial'].includes(s.state)
          );
        },
        { timeout: 60000 },
      );
      await checkCamera();
      const parcel = await page.evaluate(
        () =>
          window.__creDossier
            .getSnapshot()
            .sections.find((s) => s.id === 'neighborhood')?.result,
      );
      assert.ok(
        parcel?.overlays?.find((o) => o.id === 'parcel'),
        'Atlanta parcel geometry at user-selected point',
      );
      assert.match(JSON.stringify(parcel.values), /14 00170010003/);
      report.checks.push(
        'Atlanta: moved and Census-confirmed point returns official parcel polygon; address-to-parcel identity still unverified',
      );
      await page.screenshot({
        path: path.join(output, 'atlanta-confirmed-parcel.png'),
      });
    }
    const checkbox = await page.$('[data-layer-id="roads"]');
    if (checkbox && !(await checkbox.evaluate((e) => e.disabled))) {
      await checkbox.click();
      assert.equal(
        await page.evaluate(() => {
          const expected = document.querySelector(
            '[data-layer-id="roads"]',
          ).checked;
          const entities = [
            ...window.__creDossier.overlays.sectionSource.entities.values,
          ].filter((e) => e.id.includes('neighborhood-roads'));
          return (
            entities.length > 0 && entities.every((e) => e.show === expected)
          );
        }),
        true,
      );
      report.checks.push(`${name}: road overlay toggled`);
    }
    for (const id of ['crime', 'parcel']) {
      const control = await page.$(`[data-layer-id="${id}"]`);
      if (control && !(await control.evaluate((e) => e.disabled))) {
        if (!(await control.evaluate((e) => e.checked))) await control.click();
        const count = await page.evaluate(
          (id) =>
            [
              ...window.__creDossier.overlays.sectionSource.entities.values,
            ].filter((e) => e.id.includes(`neighborhood-${id}`) && e.show)
              .length,
          id,
        );
        assert.ok(count > 0, `${id} mapped geometry`);
        report.checks.push(`${name}: ${id} mapped ${count} shapes`);
      }
    }
    if (name === 'testpoint') {
      await page.click('.cre-dossier-workspace-slot > details > summary');
      await page.type(
        'textarea[name="notes"]',
        'Synthetic beta test note. Verify taxes, insurance and property access.',
      );
      const dismissed = new Promise((resolve) =>
        page.once('dialog', async (dialog) => {
          assert.match(dialog.message(), /unsaved/);
          await dialog.dismiss();
          resolve();
        }),
      );
      await page.click('#location-search', { clickCount: 3 });
      await page.keyboard.press('Backspace');
      await page.type(
        '#location-search',
        '675 Ponce de Leon Ave NE, Atlanta, GA',
      );
      await page.keyboard.press('Enter');
      await dismissed;
      await page.waitForFunction(
        () =>
          document
            .querySelector('.cre-workspace-notice')
            ?.textContent.includes('Search cancelled'),
        { timeout: 30000 },
      );
      assert.match(
        await page.$eval('textarea[name="notes"]', (e) => e.value),
        /Synthetic beta test/,
      );
      assert.match(
        await page.evaluate(
          () => window.__creDossier.getSnapshot().ctx.address,
        ),
        /601 E MAIN/,
      );
      report.checks.push(
        'cancelled search preserves unsaved notes and the current site',
      );
      await page.click(
        '.cre-dossier-workspace-slot > details > details > summary',
      );
      const sample = path.join(output, 'synthetic-comp.csv');
      await fs.writeFile(
        sample,
        'name,unit_type,asking_rent,lease_months,concession_total,as_of,source_url\nSynthetic QA comp (not market data),2BR,1500,12,1200,2026-09-22,https://example.com/qa\n',
      );
      await page.select('[aria-label="Import type"]', 'comps');
      await (
        await page.$('[aria-label="Choose evidence file"]')
      ).uploadFile(sample);
      await page.waitForFunction(
        () =>
          ![...document.querySelectorAll('button')].find(
            (b) => b.textContent === 'Add reviewed import',
          ).disabled,
      );
      await button('Add reviewed import');
    }
    await button('Save this site');
    const saved = await page.evaluate(() =>
      window.__creDossier.getCandidates(),
    );
    assert.equal(saved.length, report.examples.length, `saved ${name}`);
  }
  const ids = await page.evaluate(() =>
    window.__creDossier.getCandidates().map((c) => c.id),
  );
  assert.equal(ids.length, 3);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () =>
      window.__creDossier &&
      document.getElementById('loading-screen')?.classList.contains('hidden'),
    { timeout: 90000 },
  );
  await map();
  assert.equal(
    await page.evaluate(() => window.__creDossier.getCandidates().length),
    3,
  );
  report.checks.push('three saved candidates survive reload');
  const select = await page.$('.cre-candidate-select');
  await select.click();
  const savedTime = await page.evaluate(
    () => window.__creDossier.getCandidates()[0].generatedAt,
  );
  await button('Investor');
  assert.equal(await page.$eval('[data-cre-glance]', (e) => e.hidden), false);
  await map();
  await button('Investor');
  assert.equal(await page.$eval('[data-cre-glance]', (e) => e.hidden), false);
  report.checks.push('Investor view remains visible after tab round-trip');
  const popupPromise = new Promise((resolve) => page.once('popup', resolve));
  await button('Report');
  const popup = await popupPromise;
  await popup.waitForSelector('h1');
  const text = await popup.$eval('body', (e) => e.innerText);
  assert.ok(text.includes('Analyst inputs'));
  assert.ok(text.includes('Source query references'));
  assert.ok(text.includes('Selected area'));
  assert.ok(text.includes('Synthetic QA comp (not market data)'));
  assert.ok(text.includes('1,400'));
  assert.ok(text.includes('Synthetic beta test note'));
  assert.ok(await popup.$('a[href="https://example.com/qa"]'));
  report.checks.push(
    'imported synthetic rent comp exports with calculated effective rent, notes and source',
  );
  await fs.writeFile(
    path.join(output, 'site-report.html'),
    await popup.content(),
  );
  await popup.pdf({
    path: path.join(output, 'site-report.pdf'),
    printBackground: true,
  });
  await popup.close();
  assert.equal(
    await page.evaluate(
      () => window.__creDossier.getCandidates()[0].generatedAt,
    ),
    savedTime,
  );
  report.checks.push('report generated without refreshing the saved snapshot');
  await map();
  const checks = await page.$$('.cre-candidate input[type="checkbox"]');
  assert.ok(checks.length >= 3);
  await checks[0].click();
  await checks[2].click();
  const comparisonPromise = new Promise((resolve) =>
    page.once('popup', resolve),
  );
  await button('Compare selected');
  const compare = await comparisonPromise;
  await compare.waitForSelector('h1');
  const comparison = await compare.$eval('body', (e) => e.innerText);
  assert.ok(comparison.includes('601 E MAIN'));
  assert.ok(comparison.includes('1212 S MICHIGAN'));
  assert.ok(!comparison.includes('675 PONCE'));
  await fs.writeFile(
    path.join(output, 'selected-comparison.html'),
    await compare.content(),
  );
  await compare.pdf({
    path: path.join(output, 'selected-comparison.pdf'),
    printBackground: true,
  });
  await compare.close();
  report.checks.push('comparison includes A and C, excludes B');
  const downloads = path.join(output, 'downloads');
  await fs.mkdir(downloads, { recursive: true });
  const cdp = await page.createCDPSession();
  await cdp.send('Page.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: downloads,
  });
  await button('Backup selected (JSON)');
  await button('Table selected (CSV)');
  for (let i = 0; i < 30; i++) {
    try {
      await fs.access(path.join(downloads, 'selected-sites.json'));
      await fs.access(path.join(downloads, 'selected-sites.csv'));
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  const backup = JSON.parse(
    await fs.readFile(path.join(downloads, 'selected-sites.json'), 'utf8'),
  );
  assert.deepEqual(
    backup.candidates.map((c) => c.id),
    [ids[0], ids[2]],
  );
  const csv = await fs.readFile(
    path.join(downloads, 'selected-sites.csv'),
    'utf8',
  );
  assert.ok(
    csv.includes('601 E MAIN') &&
      csv.includes('1212 S MICHIGAN') &&
      !csv.includes('675 PONCE'),
  );
  report.checks.push(
    'JSON and CSV downloads contain only explicitly selected sites',
  );

  await page.setViewport({ width: 390, height: 844 });
  await button('Investor');
  await checkCamera();
  await page.screenshot({ path: path.join(output, 'phone-summary.png') });
  assert.equal(
    await page.evaluate(
      () =>
        document.getElementById('dossier-panel').scrollWidth >
        document.getElementById('dossier-panel').clientWidth,
    ),
    false,
  );
  report.checks.push('phone panel has no horizontal overflow');
  assert.deepEqual(report.errors, []);
  report.ok = true;
} catch (error) {
  if (testedPage) {
    await testedPage.screenshot({ path: path.join(output, 'failure.png') });
    await fs.writeFile(
      path.join(output, 'failure-export.json'),
      JSON.stringify(
        await testedPage.evaluate(() => window.__creDossier?.getExport()),
        null,
        2,
      ),
    );
    await fs.writeFile(
      path.join(output, 'failure.html'),
      await testedPage.content(),
    );
  }
  report.ok = false;
  report.failure = error.stack;
  process.exitCode = 1;
} finally {
  await fs.writeFile(
    path.join(output, 'results.json'),
    JSON.stringify(report, null, 2),
  );
  await browser.close();
  console.log(JSON.stringify(report, null, 2));
}
