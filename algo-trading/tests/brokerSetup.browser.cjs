const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

test('signup setup and returning MPIN-only connections work on desktop/mobile without storing secrets in the browser', async () => {
  let signedIn = false, configured = false, connected = false, metadataReads = 0;
  const writes = [], errors = [];
  const user = { _id: '111111111111111111111111', email: 'broker-test@example.com' };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/v1/')) {
      const endpoint = url.pathname.slice('/api/v1'.length);
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
      if (req.method !== 'GET') writes.push({ endpoint, method: req.method, body });
      let data = {};
      if (endpoint === '/users/me') {
        if (signedIn) data = { data: { user } }; else res.statusCode = 401;
      } else if (endpoint === '/users/refresh') {
        res.statusCode = 401;
      } else if (endpoint === '/users/register' || endpoint === '/users/login') {
        signedIn = true; data = { token: 'test-app-token', data: { user } };
      } else if (endpoint === '/users/logout') {
        signedIn = false;
      } else if (endpoint === '/angel/status') {
        data = { connected, brokerAccountId: connected ? 'aaaaaaaaaaaaaaaaaaaaaaaa' : null };
      } else if (endpoint === '/angel/credentials/status') {
        metadataReads++; data = { configured };
      } else if (endpoint === '/angel/credentials') {
        if (req.method !== 'POST' || Object.keys(body).some(key => !['apiKey', 'clientCode', 'totpSecret', 'consent', 'currentPassword'].includes(key))) {
          res.statusCode = 400; data = { message: 'Invalid setup request.' };
        } else { configured = true; data = { configured: true }; }
      } else if (endpoint === '/angel/login') {
        if (body.mpin === 'wrong') { res.statusCode = 400; data = { message: 'Invalid MPIN' }; }
        else { connected = true; data = { status: true, connected: true, brokerAccountId: 'aaaaaaaaaaaaaaaaaaaaaaaa' }; }
      } else if (endpoint === '/angel/logout') {
        connected = false;
      } else if (endpoint === '/system/health') {
        data = { ready: true, pythonStatus: 'ready' };
      } else if (endpoint.startsWith('/chart/')) {
        data = { data: { candles: [] } };
      } else if (endpoint.startsWith('/trades')) {
        data = { data: { trades: [] }, total: 0 };
      } else if (endpoint.startsWith('/instruments/search')) {
        data = { items: [] };
      }
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data)); return;
    }
    const root = path.resolve(__dirname, '../dist');
    const requested = path.resolve(root, '.' + url.pathname);
    const file = requested.startsWith(root + path.sep) && fs.existsSync(requested) && fs.statSync(requested).isFile()
      ? requested : path.join(root, 'index.html');
    res.setHeader('Content-Type', file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
    res.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    for (const width of [1440, 390]) {
      signedIn = false; configured = false; connected = false; writes.length = 0; metadataReads = 0;
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
      // Keep the application origin while routing its configured API to the
      // fixture, avoiding any dependence on a running broker or app backend.
      await page.route('**/api/v1/**', async route => {
        const url = new URL(route.request().url());
        const response = await route.fetch({ url: base + url.pathname + url.search });
        await route.fulfill({ response });
      });
      await page.goto(base + '/register');
      await page.getByPlaceholder('user@example.com').fill(user.email);
      await page.getByPlaceholder('At least 8 characters').fill('app-password');
      await page.getByPlaceholder('Repeat password').fill('app-password');
      await page.getByRole('button', { name: 'Create Account' }).click();
      const dialog = page.getByRole('dialog', { name: 'Connect to Angel One' });
      await dialog.waitFor({ state: 'visible' });
      await dialog.getByLabel(/^API Key/).fill('test-broker-api-key');
      await dialog.getByLabel(/^Client ID/).fill('CLIENT-A');
      await dialog.getByLabel(/^TOTP authenticator setup secret/).fill('JBSWY3DPEHPK3PXP');
      await dialog.getByLabel(/^Angel One MPIN/).fill('0123');
      await dialog.getByRole('checkbox').check();
      await dialog.getByRole('button', { name: 'Connect', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
      const setup = writes.find(call => call.endpoint === '/angel/credentials');
      assert.equal(setup.method, 'POST'); assert.equal(setup.body.mpin, undefined); assert.equal(setup.body.consent, true);
      const login = writes.find(call => call.endpoint === '/angel/login');
      assert.deepEqual(login.body, { mpin: '0123', useSavedCredentials: true });
      const stored = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
      for (const secret of ['test-broker-api-key', 'JBSWY3DPEHPK3PXP', '0123', 'app-password']) assert.ok(!stored.includes(secret));
      await page.getByRole('button', { name: 'Disconnect Angel One broker' }).click();
      await page.getByRole('button', { name: 'Connect Angel One broker' }).click();
      await dialog.waitFor({ state: 'visible' });
      assert.equal(await dialog.getByLabel(/^API Key/).count(), 0);
      await dialog.getByLabel(/^Angel One MPIN/).fill('wrong');
      await dialog.getByRole('button', { name: 'Connect', exact: true }).click();
      await dialog.getByRole('alert').filter({ hasText: 'Invalid MPIN' }).waitFor();
      assert.equal(await dialog.getByLabel(/^Angel One MPIN/).inputValue(), '');
      await dialog.getByLabel(/^Angel One MPIN/).fill('0456');
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await page.getByRole('button', { name: 'Connect Angel One broker' }).click();
      assert.equal(await dialog.getByLabel(/^Angel One MPIN/).inputValue(), '');
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      // A full page reload models returning to the app with the saved setup.
      await page.reload();
      await page.getByRole('button', { name: 'Connect Angel One broker' }).click();
      await dialog.waitFor({ state: 'visible' });
      assert.equal(await dialog.getByLabel(/^API Key/).count(), 0);
      assert.equal(await dialog.getByLabel(/^Angel One MPIN/).inputValue(), '');
      assert.equal(writes.filter(call => call.endpoint === '/angel/credentials').length, 1);
      assert.ok(!writes.some(call => /orders|strategies.*start/.test(call.endpoint)));
      assert.ok(metadataReads >= 2);
      await context.close();
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
});
