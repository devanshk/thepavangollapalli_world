// Screenshot + error report for any page of the site.
//
//   node tools/shot.mjs '/dev.html?x=light' out.png [--mobile] [--w 1280] [--h 800] [--wait 1500]
//                       [--full] [--dpr 1] [--tests] [--reduced-motion] [--logs]
//
// Waits for window.__ready (if the page sets it), then --wait ms, then captures.
// Prints console errors / uncaught exceptions / failed requests and exits 2 if there were any.
// --tests also waits for window.__tests (dev.html?tests=1) and prints the in-browser results.
import { open } from './browser.mjs';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--') && !['--mobile', '--full', '--tests', '--reduced-motion', '--logs'].includes(args[i - 1])));
const [pathname = '/', out = 'shot.png'] = positional;

const s = await open(pathname, {
  width: +opt('w', 1280),
  height: +opt('h', 800),
  mobile: flag('mobile'),
  dpr: +opt('dpr', 1),
  reducedMotion: flag('reduced-motion'),
});
let code = 0;
try {
  await s.page.waitForFunction(() => window.__ready !== false, null, { timeout: 20000 }).catch(() => {
    s.errors.push('timeout: window.__ready never became true');
  });
  if (flag('tests')) {
    const res = await s.page
      .waitForFunction(() => window.__tests, null, { timeout: 120000 })
      .then((h) => h.jsonValue())
      .catch(() => null);
    if (!res) s.errors.push('timeout: in-browser tests did not finish');
    else {
      for (const r of res.results) if (!r.ok) console.log(`  ✗ ${r.name}\n      ${r.error}`);
      console.log(`in-browser tests: ${res.passed} passed, ${res.failed} failed, ${res.skipped} skipped (${Math.round(res.ms)} ms)`);
      if (res.failed) code = 2;
    }
  }
  await s.page.waitForTimeout(+opt('wait', 1500));
  await s.page.screenshot({ path: out, fullPage: flag('full') });
  const overflow = await s.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (overflow > 1) s.errors.push(`layout: page scrolls horizontally by ${overflow}px`);
  if (flag('logs')) for (const l of s.logs) console.log(l);
  console.log(`saved ${out}`);
  if (s.external.length) console.log(`external requests (should be none):\n  ${[...new Set(s.external)].join('\n  ')}`);
  if (s.errors.length) {
    console.log(`errors (${s.errors.length}):\n  ${s.errors.join('\n  ')}`);
    code = 2;
  } else console.log('no page errors');
} finally {
  await s.close();
}
process.exit(code);
