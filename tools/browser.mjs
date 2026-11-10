// Headless-browser helper used by the dev tooling. Starts a private static server on a free
// port plus a Chromium page, and records everything that goes wrong on that page.
//
//   import { open } from './browser.mjs';
//   const s = await open('/dev.html?x=light', { width: 1280, height: 800 });
//   await s.page.waitForFunction(() => window.__ready);
//   await s.page.screenshot({ path: 'out.png' });
//   console.log(s.errors);          // console errors, uncaught exceptions, failed requests
//   await s.close();
import { createRequire } from 'node:module';
import { startServer } from './serve.mjs';

const require = createRequire(import.meta.url);

export async function open(pathname = '/', opts = {}) {
  const { chromium } = require('playwright');
  const { width = 1280, height = 800, mobile = false, dpr = 1, reducedMotion = false } = opts;
  const srv = await startServer(0);
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const context = await browser.newContext({
    viewport: mobile ? { width: 390, height: 780 } : { width, height },
    deviceScaleFactor: dpr,
    isMobile: mobile,
    hasTouch: mobile,
    reducedMotion: reducedMotion ? 'reduce' : 'no-preference',
  });
  const page = await context.newPage();
  const errors = [];
  const logs = [];
  page.on('console', (m) => {
    const text = m.text();
    logs.push(`[${m.type()}] ${text}`);
    if (m.type() === 'error') errors.push(`console.error: ${text}`);
  });
  page.on('pageerror', (e) => errors.push(`uncaught: ${e.message}`));
  page.on('requestfailed', (r) => errors.push(`request failed: ${r.url()} (${r.failure() && r.failure().errorText})`));
  page.on('response', (r) => {
    if (r.status() >= 400) errors.push(`HTTP ${r.status()}: ${r.url()}`);
  });
  const external = [];
  page.on('request', (r) => {
    const u = r.url();
    if (!u.startsWith(srv.url) && !u.startsWith('data:') && !u.startsWith('blob:')) external.push(u);
  });
  await page.goto(srv.url + pathname, { waitUntil: 'load' });
  return {
    page,
    context,
    browser,
    errors,
    logs,
    external,
    baseURL: srv.url,
    async close() {
      await browser.close();
      await srv.close();
    },
  };
}
