// End-to-end check of the assembled site in headless Chromium:
//   node tools/browser-test.mjs [--mobile] [--shots dir]
// Scrolls to every exhibit so it mounts and runs, presses "Run all tests", and fails (exit 1) on
// any console error, uncaught exception, failed request, external request, horizontal overflow,
// exhibit that did not reach the "ready" state, or failing in-browser test.
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { open } from './browser.mjs';

const args = process.argv.slice(2);
const mobile = args.includes('--mobile');
const shotsAt = args.indexOf('--shots');
const shots = shotsAt >= 0 ? args[shotsAt + 1] : null;
if (shots) await mkdir(shots, { recursive: true });

const s = await open('/index.html', { mobile, width: 1440, height: 900 });
const problems = [];
try {
  await s.page.waitForFunction(() => window.__ready === true, null, { timeout: 20000 });
  if (shots) await s.page.screenshot({ path: path.join(shots, `top-${mobile ? 'mobile' : 'desktop'}.png`) });
  const ids = await s.page.$$eval('section[data-exhibit]', (els) => els.map((e) => e.dataset.exhibit));
  for (const id of ids) {
    const stage = s.page.locator(`section[data-exhibit="${id}"] [data-stage]`);
    await stage.scrollIntoViewIfNeeded();
    const ok = await s.page
      .waitForFunction((x) => ['ready', 'failed'].includes(document.querySelector(`section[data-exhibit="${x}"] [data-stage]`).dataset.state), id, { timeout: 60000 })
      .then(() => true, () => false);
    const state = await stage.getAttribute('data-state');
    if (!ok || state !== 'ready') problems.push(`${id}: stage state is "${state}"`);
    await s.page.waitForTimeout(1200);
    if (shots) await stage.screenshot({ path: path.join(shots, `${id}-${mobile ? 'mobile' : 'desktop'}.png`) }).catch(() => {});
    console.log(`  ${state === 'ready' ? '✓' : '✗'} ${id} mounted`);
  }
  const run = s.page.locator('[data-proof-run]');
  if (await run.count()) {
    await run.scrollIntoViewIfNeeded();
    await run.click();
    await s.page.waitForFunction(() => ['pass', 'fail'].includes(document.querySelector('[data-proof]').dataset.state), null, { timeout: 300000 });
    const summary = await s.page.locator('[data-proof-summary]').textContent();
    console.log(`  proof: ${summary}`);
    const failures = await s.page.$$eval('.proof-failure', (els) => els.map((e) => e.textContent));
    for (const f of failures) problems.push(`test failed: ${f}`);
    if (shots) await s.page.locator('[data-proof]').screenshot({ path: path.join(shots, `proof-${mobile ? 'mobile' : 'desktop'}.png`) }).catch(() => {});
  }
  const overflow = await s.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (overflow > 1) problems.push(`page scrolls horizontally by ${overflow}px`);
  if (shots) {
    await s.page.evaluate(() => window.scrollTo(0, 0));
    await s.page.waitForTimeout(400);
    await s.page.screenshot({ path: path.join(shots, `full-${mobile ? 'mobile' : 'desktop'}.png`), fullPage: true });
  }
} finally {
  for (const e of s.errors) problems.push(e);
  for (const u of new Set(s.external)) problems.push(`external request: ${u}`);
  await s.close();
}
if (problems.length) {
  console.log(`\n${problems.length} problem(s):\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log('\nsite OK');
