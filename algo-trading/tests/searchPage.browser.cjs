const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const output = path.resolve(__dirname, '../search-verification.local');

test('market search renders live stock/option charts on desktop and mobile and releases streams on navigation', async () => {
  const instruments = [
    { exchange: 'NSE', symboltoken: '2885', tradingsymbol: 'RELIANCE-EQ', name: 'RELIANCE', instrumentType: 'EQUITY', expiry: null, lotSize: 1 },
    { exchange: 'NFO', symboltoken: '77', tradingsymbol: 'NIFTY30DEC209926000CE', name: 'NIFTY', instrumentType: 'OPTIDX', expiry: '2099-12-30', lotSize: 65 },
  ];
  let activeStreams = 0, connected = true, writes = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const base = `http://127.0.0.1:${server.address().port}`;
    res.setHeader('Access-Control-Allow-Origin', base);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    if (req.method === 'OPTIONS') { res.end(); return; }
    if (url.pathname.includes('/api/v1/')) {
      if (req.method !== 'GET') writes++;
      const endpoint = url.pathname.split('/api/v1')[1];
      if (endpoint === '/instruments/live') {
        assert.equal(url.searchParams.get('brokerAccountId'), 'aaaaaaaaaaaaaaaaaaaaaaaa');
        const instrument = instruments.find(item => item.symboltoken === url.searchParams.get('symboltoken'));
        activeStreams++;
        res.setHeader('Content-Type', 'text/event-stream');
        const emit = () => {
          const end = Math.floor(Date.now() / 300000) * 300;
          const candles = Array.from({ length: 40 }, (_, i) => ({ time: end - (40 - i) * 300, open: 100 + i, high: 105 + i, low: 98 + i, close: 102 + i }));
          res.write(`data: ${JSON.stringify({ instrument, interval: url.searchParams.get('interval'), status: 'LIVE', serverTime: Date.now(), historyStatus: 'READY', candles,
            quote: { ltp: 141.5, timestamp: Date.now(), receivedAt: Date.now(), source: 'ANGEL_WEBSOCKET' } })}\n\n`);
        };
        emit(); const timer = setInterval(emit, 500);
        res.once('close', () => { clearInterval(timer); activeStreams--; });
        return;
      }
      let data = {};
      if (endpoint === '/users/me') data = { data: { user: { _id: '111111111111111111111111', email: 'chart-test@example.com' } } };
      if (endpoint === '/angel/status') data = { connected, brokerAccountId: connected ? 'aaaaaaaaaaaaaaaaaaaaaaaa' : null };
      if (endpoint === '/system/health') data = { ready: true, pythonStatus: 'ready' };
      if (endpoint === '/instruments/search') data = { items: instruments.filter(item => item.name.includes(url.searchParams.get('query').toUpperCase())) };
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data)); return;
    }
    const root = path.resolve(__dirname, '../dist');
    const requested = path.resolve(root, '.' + url.pathname);
    const file = requested.startsWith(root + path.sep) && fs.existsSync(requested) && fs.statSync(requested).isFile() ? requested : path.join(root, 'index.html');
    res.setHeader('Content-Type', file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
    res.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    fs.mkdirSync(output, { recursive: true });
    for (const width of [1440, 390]) {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/api/v1/**', route => route.continue({ url: base + new URL(route.request().url()).pathname + new URL(route.request().url()).search }));
      await page.goto(base + '/search');
      await page.getByLabel('Symbol or company').fill(width === 1440 ? 'RELIANCE' : 'NIFTY');
      await page.getByRole('button', { name: new RegExp(width === 1440 ? 'RELIANCE-EQ' : 'NIFTY30DEC') }).click();
      await page.getByText('Live', { exact: true }).waitFor();
      await page.getByText('₹141.50').waitFor();
      await page.getByRole('button', { name: '30m', exact: true }).click();
      await page.getByText('Live', { exact: true }).waitFor();
      await page.screenshot({ path: path.join(output, `${width}.png`), fullPage: true });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'page must fit viewport');
      assert.equal(await page.locator('canvas').count() > 0, true);
      assert.deepEqual(errors, []);
      await page.goto(base + '/strategies');
      await page.waitForTimeout(250);
      assert.equal(activeStreams, 0, 'leaving Search must close the live stream');
      await context.close();
    }
    connected = false;
    const page = await browser.newPage();
    await page.route('**/api/v1/**', route => route.continue({ url: base + new URL(route.request().url()).pathname + new URL(route.request().url()).search }));
    await page.goto(base + '/search');
    await page.getByRole('button', { name: 'Connect Angel One', exact: true }).waitFor();
    assert.equal(writes, 0, 'market search must not call mutation endpoints');
  } finally {
    await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
});
