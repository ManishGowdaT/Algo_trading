const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { mock, routes } = require('./mobileResponsive.browser.cjs');
function serve(root, port) {
  const server = http.createServer((req, res) => {
    const relative = new URL(req.url, 'http://localhost').pathname;
    let file = path.join(root, relative);
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, 'index.html');
    const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
    res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
    res.end(fs.readFileSync(file));
  });
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve(server)));
}
(async () => {
  const baselinePath = process.env.MOBILE_BASELINE_DIST;
  assert(baselinePath && fs.existsSync(path.join(baselinePath, 'index.html')), 'Set MOBILE_BASELINE_DIST to the built frontend from the pre-change revision.');
  const baseline = await serve(baselinePath, 4180);
  const current = await serve(path.resolve(__dirname, '../dist'), 4181);
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const output = path.resolve(__dirname, '../mobile-verification.local/desktop');
  fs.mkdirSync(output, { recursive: true });
  const results = [];
  try {
    for (const width of [1024, 1440]) {
      const pages = [];
      for (const port of [4180, 4181]) {
        const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
        const page = await context.newPage();
        // Serve both builds through the fixture's local origin; block real APIs.
        await page.route('http://127.0.0.1:4179/**', async route => {
          const url = route.request().url().replace(':4179', ':' + port);
          const response = await page.request.get(url);
          await route.fulfill({ response });
        });
        await mock(page);
        await page.goto('http://127.0.0.1:4179/login');
        await page.waitForTimeout(500);
        pages.push({ page, context });
      }
      for (const route of routes) {
        const shots = [];
        for (let i = 0; i < pages.length; i++) {
          const page = pages[i].page;
          await page.evaluate(route => { history.pushState({}, '', route); dispatchEvent(new PopStateEvent('popstate')); }, route);
          if (['/strategies/heikenashi', '/strategies/modified-heikenashi', '/strategies/5-min-breakout'].includes(route)) {
            await page.getByText('Monitoring an existing protected position after recovery.', { exact: true }).waitFor();
          }
          await page.waitForTimeout(500);
          shots.push(await page.screenshot({ animations: 'disabled', fullPage: true, mask: [page.locator('.tv-lightweight-charts')],
            path: path.join(output, `${width}-${i ? 'current' : 'baseline'}-${route.replaceAll('/', '_')}.png`) }));
        }
        results.push({ width, route, identical: shots[0].equals(shots[1]) });
      }
      for (const { context } of pages) await context.close();
    }
  } finally {
    await browser.close();
    await new Promise(resolve => baseline.close(resolve));
    await new Promise(resolve => current.close(resolve));
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(results, null, 2));
  }
  console.log(JSON.stringify(results, null, 2));
  assert(results.every(r => r.identical), 'Desktop screenshots changed');
})().catch(e => { console.error(e); process.exitCode = 1; });
