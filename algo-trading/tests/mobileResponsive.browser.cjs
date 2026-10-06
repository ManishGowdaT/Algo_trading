const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.MOBILE_PREVIEW_URL || 'http://127.0.0.1:4179';
const output = path.resolve(__dirname, '../mobile-verification.local');
fs.mkdirSync(output, { recursive: true });
const widths = [360, 375, 390, 414, 430];
const routes = ['/login', '/register', '/dashboard', '/strategies', '/strategies/manual-trading',
  '/strategies/heikenashi', '/strategies/modified-heikenashi', '/strategies/5-min-breakout',
  '/strategies/ichimoku', '/strategies/vwap-smma', '/strategies/expiry', '/strategies/plugin/mobile-test', '/trades'];
const symbol = 'BANKNIFTY30OCT202652000PE';
const manifest = { id: 'mobile-test', name: 'Long Custom Premium Breakout Strategy', engineVersion: '1.0.0',
  version: '1.0.0', description: 'Mobile presentation fixture', parameters: { period: { type: 'number', label: 'Lookback period', default: 5 } } };
const status = { isRunning: true, state: 'POSITION_PROTECTED', trend: 'BULLISH', message: 'Monitoring an existing protected position after recovery.',
  monitoredPremiums: { ce: symbol, pe: symbol }, checkpoints: [{ id: 'broker', label: 'Broker connection', status: 'success' }],
  activeTradeId: 'trade-1', activeTradePremium: symbol, entryPrice: 300, currentLtp: 310, stopLoss: 290, target: 330,
  logs: [symbol.repeat(8)], recoveryState: 'READY' };
async function mock(page, state = { connected: true, authenticated: true }) {
  const writes = [];
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.includes('/api/v1/')) {
      const endpoint = url.pathname.split('/api/v1')[1];
      if (route.request().method() !== 'GET') writes.push(endpoint);
      let data = { status: 'success' }, code = 200;
      if (endpoint === '/users/me') {
        if (state.authenticated) data = { data: { user: { _id: '111111111111111111111111', email: 'long.trading.account@example.com' } } };
        else { code = 401; }
      } else if (endpoint === '/users/refresh') { code = 401; }
      else if (endpoint === '/system/health') data = { ready: true, pythonStatus: 'ready' };
      else if (endpoint === '/angel/status') data = { connected: state.connected, brokerAccountId: state.connected ? 'aaaaaaaaaaaaaaaaaaaaaaaa' : null };
      else if (endpoint === '/angel/margins') data = { data: { net: '123456789.50', utiliseddebits: '123456.50', availablecash: '1234567.50' } };
      else if (endpoint === '/strategies/manifests') data = { manifests: [manifest] };
      else if (endpoint === '/strategies') data = { status: 'success', data: { strategies: [{ _id: 's1', name: manifest.name }] } };
      else if (endpoint.startsWith('/strategies/settings/')) data = { data: { config: {} } };
      else if (endpoint.startsWith('/strategies/') && endpoint.endsWith('/status')) data = { ...status, data: status };
      else if (endpoint === '/market/index-ltp' || endpoint === '/chart/index-ltp') data = { ltp: 24500.50, close: 24000.00 };
      else if (endpoint === '/chart/market-data') data = { data: { candles: Array.from({length: 12}, (_, i) => ({ time: 1791263700 + i * 300, open: 100+i, high: 105+i, low: 98+i, close: 102+i })), indicators: {}, tradeOverlays: {} } };
      else if (endpoint === '/trades') data = { status: 'success', total: 120, pages: 12,
        analytics: { totalPnl: 123456.78, totalTrades: 120, taxes: 1234, netPnl: 122222.78 },
        data: { trades: [{ _id: 'trade-1', strategyId: { _id: 's1', name: manifest.name }, index: 'BANKNIFTY', premium: 52000,
          qty: 30, buyPrice: 300, exitPrice: 330, pnl: 900, exitReason: 'Target', createdAt: '2026-10-06T05:00:00Z' }] } };
      return route.fulfill({ status: code, contentType: 'application/json', body: JSON.stringify(data) });
    }
    if (url.origin === base || url.protocol === 'data:') return route.fallback();
    return route.abort(); // No real backend, broker, or external network traffic.
  });
  return writes;
}
async function measure(page) {
  return page.evaluate(() => {
    const visible = e => {
      const s = getComputedStyle(e), r = e.getBoundingClientRect();
      return s.visibility !== 'hidden' && s.display !== 'none' && r.width > 0 && r.height > 0
        && r.right > 0 && r.left < innerWidth;
    };
    const target = e => e.matches('input[type="checkbox"],input[type="radio"]') ? (e.closest('label') || e) : e;
    const small = [...document.querySelectorAll('button,input,select,textarea,a,summary,.mobile-filter-option,.react-datepicker__day')]
      .filter(visible).filter(e => { const r = target(e).getBoundingClientRect(); return r.width < 43.5 || r.height < 43.5; })
      .map(e => ({ tag: e.tagName, text: (e.textContent || e.getAttribute('aria-label') || e.getAttribute('type') || '').slice(0, 65), width: e.getBoundingClientRect().width, height: e.getBoundingClientRect().height }));
    const nav = document.querySelector('.mobile-bottom-nav')?.getBoundingClientRect();
    const actions = document.querySelector('.mobile-trading-actions')?.getBoundingClientRect();
    return { width: innerWidth, scrollWidth: document.documentElement.scrollWidth, small,
      nav: nav && { top: nav.top, bottom: nav.bottom }, actions: actions && { top: actions.top, bottom: actions.bottom } };
  });
}
module.exports = { mock, routes };
if (require.main === module) (async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const report = [], failures = [];
  try {
    for (const width of widths) {
      const context = await browser.newContext({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true });
      const page = await context.newPage();
      const writes = await mock(page);
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.goto(base + '/login');
      await page.waitForTimeout(500);
      for (const route of routes) {
        await page.evaluate(route => { history.pushState({}, '', route); dispatchEvent(new PopStateEvent('popstate')); }, route);
        await page.waitForTimeout(450);
        if (route === '/dashboard') {
          await page.locator('button').getByText('24,500.50', { exact: true }).first().waitFor();
          await page.waitForTimeout(150);
        }
        const metrics = await measure(page);
        report.push({ route, ...metrics });
        if (metrics.scrollWidth > width + 1 || metrics.small.length) failures.push({ route, ...metrics });
        if (!['/login', '/register'].includes(route)) {
          assert(metrics.nav, `Missing mobile navigation ${route}`);
          if (metrics.actions) assert(metrics.actions.bottom <= metrics.nav.top + 1, `Overlapping bars ${route}`);
        }
        if (route === '/trades') {
          await page.locator('details').first().click();
          assert(await page.locator('table').isHidden());
          await page.locator('input[placeholder="Start Date"]').click();
          const calendar = await measure(page);
          if (calendar.small.length) failures.push({ route: route + '/calendar', ...calendar });
          const box = await page.locator('.react-datepicker').boundingBox();
          assert(box.x >= -1 && box.x + box.width <= width + 1, `Calendar clipped at ${width}`);
          await page.keyboard.press('Escape');
          await page.getByText('All Strategies', { exact: true }).first().click();
          const menu = await measure(page);
          if (menu.small.length) failures.push({ route: route + '/filters', ...menu });
          await page.getByText(manifest.name, { exact: true }).first().click();
        }
        if (route === '/dashboard') {
          const chart = await page.locator('.mobile-chart-viewport').boundingBox();
          assert(chart.height <= 421 && chart.height >= 280, `Chart sizing at ${width}`);
          await page.getByRole('button', { name: /SENSEX/ }).click();
          await page.getByRole('heading', { name: /SENSEX Real-Time Execution Chart/i }).waitFor();
          await page.getByRole('button', { name: 'Indicators & Overlays' }).click();
          const panel = await measure(page);
          if (panel.small.length) failures.push({ route: route + '/indicators', ...panel });
          await page.getByRole('button', { name: 'Apply', exact: true }).click();
        }
        if (width === 360 || width === 430) await page.screenshot({ path: path.join(output, `${width}-${route.replaceAll('/', '_') || 'root'}.png`), fullPage: true });
      }
      await page.goto(base + '/strategies/5-min-breakout');
      await page.waitForTimeout(300);
      await page.getByRole('button', { name: 'Account', exact: true }).click();
      assert(await page.getByRole('dialog', { name: 'Account', exact: true }).isVisible());
      await page.getByRole('button', { name: 'Close account' }).click();
      assert(await page.getByRole('button', { name: 'Open account menu', includeHidden: true }).isHidden());
      if (width === 430) {
        // Exercise the actual CSS rules with synthetic notch/home-indicator insets.
        // This is a spacing test, not physical iPhone safe-area emulation.
        const safeCss = await page.evaluate(() => {
          const copies = [];
          const walk = rules => {
            for (const rule of rules) {
              if (rule.type === CSSRule.STYLE_RULE) {
                if (rule.cssText.includes('env(safe-area-inset-')) copies.push(rule.cssText);
              } else if (rule.cssRules && (!rule.conditionText || matchMedia(rule.conditionText).matches)) walk(rule.cssRules);
            }
          };
          for (const sheet of document.styleSheets) walk(sheet.cssRules);
          return copies.join('\n').replaceAll('env(safe-area-inset-top)', '20px')
            .replaceAll('env(safe-area-inset-bottom)', '34px')
            .replaceAll('env(safe-area-inset-left)', '0px').replaceAll('env(safe-area-inset-right)', '0px');
        });
        await page.addStyleTag({ content: safeCss });
        const safe = await measure(page);
        assert.equal(Math.round(safe.nav.bottom - safe.nav.top), 98);
        assert(safe.actions.bottom <= safe.nav.top + 1, 'Safe-area bars overlap');
        const header = await page.locator('.mobile-app-header').boundingBox();
        assert.equal(Math.round(header.height), 76);
        await page.screenshot({ path: path.join(output, 'safe-area-430.png') });
      }
      assert(!writes.some(p => /\/(start|exit|stop|orders)$/.test(p)), 'Layout audit submitted an execution action');
      assert.deepEqual(errors, []);
      await context.close();
    }
    const context = await browser.newContext({ viewport: { width: 360, height: 640 }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    await mock(page, { authenticated: true, connected: false });
    await page.goto(base + '/dashboard');
    await page.getByRole('button', { name: 'Connect Angel One broker' }).click();
    assert(await page.getByRole('dialog', { name: 'Connect to Angel One' }).isVisible());
    const modal = await measure(page);
    if (modal.small.length) failures.push({ route: 'connect-modal', ...modal });
    await page.setViewportSize({ width: 360, height: 400 });
    await page.getByRole('button', { name: 'Connect', exact: true }).scrollIntoViewIfNeeded();
    const button = await page.getByRole('button', { name: 'Connect', exact: true }).boundingBox();
    assert(button.y >= 0 && button.y + button.height <= 400, 'Modal actions inaccessible in short viewport');
    await page.screenshot({ path: path.join(output, 'connect-short-viewport.png') });
    await context.close();
  } finally {
    await browser.close();
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ report, failures }, null, 2));
  }
  console.log(JSON.stringify({ routeChecks: report.length, failures }, null, 2));
  assert.equal(failures.length, 0, 'Mobile layout failures');
})().catch(e => { console.error(e); process.exitCode = 1; });
