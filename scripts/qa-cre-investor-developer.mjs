// Opt-in live beta: real address entry, role views, reports, and mobile layout.
// AI research stays off; paid model behavior is tested separately with fixtures.
import puppeteer from 'puppeteer';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { buildComparisonHtml } from '../src/cre/printPage.js';
import { probeSiteScreen, judgeSiteOnScreen } from './qa-cre-screen-check.mjs';

const output = process.env.QA_OUTPUT_DIR || '/tmp/gods-eye-cre-role-beta';
await fs.mkdir(output, { recursive: true });
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
const report = {
  startedAt: new Date().toISOString(),
  examples: [],
  checks: [],
  errors: [],
};
const documents = [];
let testedPage;
try {
  const page = await browser.newPage();
  testedPage = page;
  report.networkFailures = [];
  page.on('response', (response) => {
    if (response.status() >= 400) {
      const url = new URL(response.url());
      report.networkFailures.push({
        status: response.status(),
        url: `${url.origin}${url.pathname}`,
      });
    }
  });
  page.on('console', (m) => {
    if (m.type() === 'error') report.errors.push(m.text().slice(0, 500));
  });
  await page.setViewport({ width: 1440, height: 1000 });
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
  const click = async (label) => {
    const handle = await page.evaluateHandle(
      (text) =>
        [...document.querySelectorAll('#dossier-panel button')].find(
          (b) => b.textContent.trim() === text && !b.hidden,
        ),
      label,
    );
    const button = handle.asElement();
    assert.ok(button, `Button: ${label}`);
    await button.click();
    await handle.dispose();
  };
  for (const [name, address, latitude] of [
    ['johnson-city', '601 E Main St, Johnson City, TN', 36.32],
    ['atlanta', '675 Ponce de Leon Ave NE, Atlanta, GA', 33.77],
  ]) {
    const started = Date.now();
    await page.click('#location-search', { clickCount: 3 });
    await page.keyboard.press('Backspace');
    await page.type('#location-search', address);
    await page.keyboard.press('Enter');
    await page.waitForFunction(
      (lat) => {
        const s = window.__creDossier.getSnapshot();
        return (
          s.ctx &&
          Math.abs(s.ctx.lat - lat) < 0.08 &&
          ['ready', 'partial'].includes(s.state)
        );
      },
      { timeout: 120000 },
      latitude,
    );
    const snapshot = await page.evaluate(() =>
      window.__creDossier.getSnapshot(),
    );
    report.examples.push({
      name,
      address: snapshot.ctx.address,
      seconds: (Date.now() - started) / 1000,
      status: snapshot.state,
      sections: snapshot.sections.map((s) => ({
        id: s.id,
        status: s.status,
        message: s.result?.message,
      })),
    });
    await new Promise((resolve) => setTimeout(resolve, 2800));
    const probe = await page.evaluate(
      `(${probeSiteScreen})(${snapshot.ctx.lat},${snapshot.ctx.lon})`,
    );
    assert.equal(
      judgeSiteOnScreen(probe).ok,
      true,
      'Map camera settles on the selected site',
    );
    for (const role of ['investor', 'developer']) {
      await click(role === 'investor' ? 'Investor' : 'Developer');
      await page.screenshot({ path: path.join(output, `${name}-${role}.png`) });
      const text = await page.$eval('#dossier-panel', (el) => el.innerText);
      assert.match(text, /Reported incidents|Crime/i);
      assert.match(
        text,
        role === 'investor' ? /Acquisition|Investor/i : /Parcel|Developer/i,
      );
      if (name === 'johnson-city')
        assert.match(text, /Johnson City|local source/i);
      const targetPromise = browser.waitForTarget(
        (t) => t.opener() === page.target(),
        { timeout: 15000 },
      );
      await click('Report');
      const target = await targetPromise;
      const printed = await target.page();
      await printed.waitForSelector('.screening', { timeout: 15000 });
      const html = await printed.content();
      assert.match(
        html,
        new RegExp(
          `${role === 'investor' ? 'Investor' : 'Developer'} location brief`,
        ),
      );
      assert.match(html, /Full dossier and source appendix/);
      assert.match(html, /Additional research/);
      await fs.writeFile(path.join(output, `${name}-${role}.html`), html);
      await printed.pdf({
        path: path.join(output, `${name}-${role}.pdf`),
        printBackground: true,
        preferCSSPageSize: true,
      });
      const overflow = await printed.evaluate(
        () =>
          document.documentElement.scrollWidth >
          document.documentElement.clientWidth + 2,
      );
      assert.equal(overflow, false, 'Report has no horizontal overflow');
      await printed.close();
    }
    documents.push(await page.evaluate(() => window.__creDossier.getExport()));
    await click('Analysis');
    assert.ok(
      await page.$('input[type="checkbox"]'),
      'Analysis has selectable research',
    );
    await page.screenshot({ path: path.join(output, `${name}-analysis.png`) });
    report.checks.push(
      `${name}: address entry, both role views, both report buttons/PDF generation, Analysis selections`,
    );
  }
  await page.setViewport({ width: 390, height: 844 });
  for (const role of ['Investor', 'Developer']) {
    await click(role);
    await page.$eval('.cre-dossier-body', (el) => (el.scrollTop = 0));
    await page.screenshot({
      path: path.join(output, `mobile-${role.toLowerCase()}.png`),
    });
    const geometry = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth > innerWidth + 2,
      crime: [...document.querySelectorAll('#dossier-panel .cre-insight-title')]
        .filter((e) => /Reported incidents|Crime/i.test(e.textContent))
        .map((e) => ({
          top: e.getBoundingClientRect().top,
          bottom: e.getBoundingClientRect().bottom,
          visible: e.getClientRects().length > 0,
        })),
    }));
    assert.equal(geometry.overflow, false, 'Mobile does not overflow');
    assert.ok(
      geometry.crime.some((r) => r.visible && r.top >= 0 && r.bottom < 844),
      `${role}: crime visible without scrolling ${JSON.stringify(geometry)}`,
    );
  }
  const comparison = await browser.newPage();
  await comparison.setContent(buildComparisonHtml(documents), {
    waitUntil: 'domcontentloaded',
  });
  await comparison.pdf({
    path: path.join(output, 'comparison.pdf'),
    printBackground: true,
    preferCSSPageSize: true,
  });
  await fs.writeFile(
    path.join(output, 'comparison.html'),
    await comparison.content(),
  );
  await fs.writeFile(
    path.join(output, 'snapshots.json'),
    JSON.stringify(documents, null, 2),
  );
  report.checks.push(
    '390x844: both roles show crime without scrolling, no horizontal overflow; two-site comparison PDF',
  );
} catch (error) {
  report.errors.push(error.stack || String(error));
  if (testedPage) {
    await testedPage
      .screenshot({ path: path.join(output, 'failure.png') })
      .catch(() => {});
    report.diagnostic = await testedPage
      .evaluate(() => ({
        handle: Boolean(window.__creDossier),
        loader: document.getElementById('loading-screen')?.className,
        text: document.body.innerText.slice(0, 4500),
      }))
      .catch(() => null);
    console.log(JSON.stringify(report.diagnostic));
  }
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(
    path.join(output, 'results.json'),
    JSON.stringify(report, null, 2),
  );
  console.log(
    JSON.stringify(
      {
        examples: report.examples.map((e) => ({
          name: e.name,
          status: e.status,
          seconds: e.seconds,
        })),
        checks: report.checks,
        errors: report.errors,
        output,
      },
      null,
      2,
    ),
  );
  await browser.close();
}
