// Screenshot every Flow Desk panel in demo mode.
// Usage: npm run build && npx next start -p 3100 & node scripts/flowdesk-screenshots.mjs [baseUrl] [outDir] [scale]
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright'); // pre-installed globally; not a project dependency
import fs from 'node:fs';

const base = process.argv[2] || 'http://localhost:3100';
const out = process.argv[3] || 'docs/flow-desk';
const scale = Number(process.argv[4] || 2);
fs.mkdirSync(out, { recursive: true });

const shots = [
  { panel: 'flow', sel: '[data-panel="options-flow"]', file: '01-options-flow.png' },
  { panel: 'flow', sel: '[data-panel="top-symbols"]', file: '02-top-symbols.png' },
  { panel: 'flow', sel: '[data-panel="by-expiration"]', file: '03-by-expiration.png' },
  { panel: 'flow', sel: '[data-panel="recent-flow"]', file: '04-recent-flow.png' },
  { panel: 'heatmap', sel: '[data-panel="flow-heatmap"]', file: '05-flow-heatmap.png', hover: 'svg rect[fill^="rgba"]' },
  { panel: 'greeks', sel: '[data-panel="dealer-greeks"]', file: '06-dealer-greeks.png' },
  { panel: 'greeks', sel: '[data-panel="dealer-greeks"]', file: '06b-dealer-greeks-compare.png', click: 'text=Compare Greeks', check: ['VEGA', 'VANNA', 'CHARM'] },
  { panel: 'vol', sel: '[data-panel="volatility"]', file: '07-volatility.png' },
  { panel: 'tape', sel: '[data-panel="tape"]', file: '08-tape.png' },
  { panel: 'msi', sel: '[data-panel="msi"]', file: '09-msi.png' },
  { panel: 'summary', sel: '[data-panel="daily-summary"]', file: '10-daily-summary.png', waitFor: '[data-testid="daily-summary-table"] tbody tr:nth-child(3)' },
  { panel: 'elmod', sel: '[data-panel="elmod"]', file: '11-elmod-chart.png' },
];

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1100 }, deviceScaleFactor: scale });
const errors = [];
for (const s of shots) {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${s.file}: ${e.message}`));
  await page.goto(`${base}/?tab=flowdesk&demo=1&panel=${s.panel}`, { waitUntil: 'networkidle' });
  // the dashboard header is sticky; unstick it so element screenshots aren't overlapped
  await page.addStyleTag({ content: 'header.sticky{position:static !important}' });
  const el = page.locator(s.sel).first();
  await el.waitFor({ state: 'visible', timeout: 30000 });
  if (s.waitFor) await page.locator(s.waitFor).first().waitFor({ timeout: 30000 });
  if (s.click) await page.locator(s.sel).locator(s.click).first().click();
  for (const label of s.check ?? []) await page.locator(s.sel).getByLabel(label, { exact: true }).check().catch(() => page.locator(s.sel).locator(`label:has-text("${label}") input`).check());
  await page.waitForTimeout(800);
  if (s.hover) {
    const cells = page.locator(s.sel).locator(s.hover);
    const n = await cells.count();
    await cells.nth(Math.floor(n * 0.45)).hover();
    await page.waitForTimeout(200);
  }
  await el.screenshot({ path: `${out}/${s.file}` });
  console.log('saved', s.file);
  await page.close();
}
// live mode with no keys → "no data source configured" state
const page = await ctx.newPage();
await page.goto(`${base}/?tab=flowdesk&demo=0&panel=flow`, { waitUntil: 'networkidle' });
await page.locator('[data-state="no-source"]').first().waitFor({ timeout: 30000 }).then(
  () => page.locator('[data-panel="options-flow"]').screenshot({ path: `${out}/00-live-no-source.png` }).then(() => console.log('saved 00-live-no-source.png')),
  () => console.log('live mode has a data source; skipped no-source shot'),
);
await browser.close();
if (errors.length) { console.error('PAGE ERRORS:\n' + errors.join('\n')); process.exit(1); }
