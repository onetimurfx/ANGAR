/* ADMIN PANEL E2E (stage E): the built app + a real PostgreSQL + the REAL admin-api / admin-pickup handlers (tests/e2e/live-server.ts).
   Access control in the browser, Cart orders, Pickup, products + variants + photos, categories, stock, customers, settings,
   owner-vs-manager, mobile layout (390 / 320 px) and desktop (1280 px). Only Telegram's Bot API and Storage are fake. */
const { chromium } = require('playwright-core')
const { spawn, spawnSync } = require('node:child_process')
const { createHmac } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const API = process.env.AYN_API || 'http://127.0.0.1:54321'
const WEB = process.env.AYN_WEB || 'http://127.0.0.1:4174'
const BOT_TOKEN = '7000000001:AAFakeTokenForE2eOnly_abcdefghijklmnopqrstu'
const SHOTS = path.join(__dirname, 'shots')
const fails = []
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) fails.push(msg) }
const eq = (a, b, msg) => check(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)}${JSON.stringify(a) === JSON.stringify(b) ? '' : `, want ${JSON.stringify(b)}`})`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

function initData(userId) {
  const fields = { auth_date: String(Math.floor(Date.now() / 1000)), query_id: 'AAE2E', user: JSON.stringify({ id: userId, first_name: 'Ali', last_name: 'Valiyev', username: `u${userId}`, language_code: 'uz' }) }
  const c = Object.entries(fields).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('\n')
  const secret = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest()
  return new URLSearchParams({ ...fields, hash: createHmac('sha256', secret).update(c).digest('hex') }).toString()
}
const tgScript = (id, data) => `(() => { const noop = () => {}; window.Telegram = { WebApp: { initData: ${JSON.stringify(data)}, initDataUnsafe: { user: { id: ${id}, first_name: 'Ali', last_name: 'Valiyev', username: 'u${id}' } }, platform: 'android', colorScheme: 'light', viewportStableHeight: 800, BackButton: { show: noop, hide: noop, onClick: noop, offClick: noop }, ready: noop, expand: noop, setHeaderColor: noop, setBackgroundColor: noop, isVersionAtLeast: () => false, onEvent: noop } } })()`
const st = async () => (await fetch(`${API}/__test/admin-state`)).json()
const ctl = async (op, qs = '') => (await fetch(`${API}/__test/${op}${qs ? `?${qs}` : ''}`)).json()

;(async () => {
  fs.mkdirSync(SHOTS, { recursive: true })
  let child = null
  if (!process.env.AYN_API) {
    const b = spawnSync('npx', ['vite', 'build', '--outDir', 'dist-live'], { stdio: 'ignore', env: { ...process.env, VITE_SUPABASE_URL: API, VITE_SUPABASE_ANON_KEY: 'anon-e2e-key-0123456789-abcdefghij' } })
    if (b.status !== 0) throw new Error('live build failed')
    child = spawn('npx', ['tsx', 'tests/e2e/live-server.ts'], { stdio: ['ignore', 'pipe', 'inherit'], detached: true })
    await new Promise((res, rej) => { child.stdout.on('data', (d) => String(d).includes('READY') && res()); setTimeout(() => rej(new Error('live server did not start')), 90000) })
  }
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] })
  const errors = []
  const newCtx = async (tgId, { width = 390, mobile = true } = {}) => {
    const ctx = await browser.newContext({ viewport: { width, height: mobile ? 844 : 900 }, deviceScaleFactor: 2, isMobile: mobile, hasTouch: mobile })
    if (tgId) await ctx.addInitScript(tgScript(tgId, initData(tgId)))
    await ctx.route('**/telegram.org/**', (r) => r.abort())
    const page = await ctx.newPage()
    page.on('pageerror', (e) => errors.push(String(e)))
    page.on('console', (m) => m.type() === 'error' && !/telegram\.org|ERR_|Failed to load resource|INJECTED|net::|403|401/.test(m.text()) && errors.push(m.text()))
    return { ctx, page }
  }
  const go = async (page, p) => { await page.goto(WEB + p, { waitUntil: 'networkidle' }); await sleep(250) }
  const shot = async (page, n) => { await sleep(350); await page.screenshot({ path: path.join(SHOTS, `e-${n}.png`) }) }
  const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  const smallInputs = (page) => page.evaluate(() => [...document.querySelectorAll('input:not([type=checkbox]):not([type=color]):not([type=file]), textarea, select')].filter((e) => e.offsetParent && parseFloat(getComputedStyle(e).fontSize) < 16).length)

  try {
    await ctl('reset-admin')

    // ------------------------------------------------------------ 1. access control in the browser
    {
      const c = await newCtx(700001)
      await go(c.page, '/profil')
      check((await c.page.getByTestId('admin-link').count()) === 0, 'a customer does not see the Admin panel link')
      await go(c.page, '/admin')
      await c.page.getByText("Ruxsat yo'q").waitFor({ timeout: 8000 })
      check((await c.page.getByTestId('admin-dashboard').count()) === 0 && (await c.page.getByText('Buyurtmalar').count()) === 0, 'customer opening /admin gets "Ruxsat yo\'q" and no panel')
      await go(c.page, '/admin/settings')
      check((await c.page.getByTestId('admin-settings').count()) === 0, 'a deep admin URL is refused too')
      // a hand-made request with the customer's session is refused by the SERVER
      const status = await c.page.evaluate(async (api) => {
        const t = await fetch(`${api}/functions/v1/telegram-auth`, { method: 'POST', headers: { 'content-type': 'application/json', apikey: 'x' }, body: JSON.stringify({ initData: window.Telegram.WebApp.initData }) }).then((r) => r.json())
        return (await fetch(`${api}/functions/v1/admin-api?r=settings&tg=900001`, { headers: { 'x-aynimo-session': t.token } })).status
      }, API)
      eq(status, 403, 'admin-api answers 403 to a customer session (tg in the query is ignored)')
      await c.ctx.close()

      const nt = await newCtx(null)
      await go(nt.page, '/admin')
      await nt.page.getByText('Telegram ichida oching').waitFor({ timeout: 8000 })
      check(true, 'outside Telegram /admin asks to open it in Telegram')
      await nt.ctx.close()
    }

    // ------------------------------------------------------------ 2. owner: entry, dashboard, navigation (mobile)
    const O = await newCtx(900001)
    const page = O.page
    await go(page, '/profil')
    await page.getByTestId('admin-link').click()
    await page.getByTestId('admin-dashboard').waitFor({ timeout: 8000 }).catch(async (e) => { console.log('DEBUG', page.url(), (await page.locator('body').innerText()).slice(0, 500)); await page.screenshot({ path: path.join(SHOTS, 'debug-admin.png') }); throw e })
    check(page.url().endsWith('/admin'), 'owner reaches /admin from the Profile link')
    check((await page.getByText('Egasi').count()) > 0, 'role badge shows Egasi')
    check((await page.getByText('Savat buyurtmalari').count()) > 0 && (await page.getByText('Tezkor buyurtmalar').count()) > 0, 'dashboard keeps Cart and Quick (pickup) orders apart')
    check((await page.getByTestId('dock').count()) === 0 && (await page.getByRole('navigation', { name: 'Admin' }).count()) === 1, 'admin has its own navigation (shop dock is not shown)')
    await shot(page, 'dashboard-mobile')
    for (const [label, test] of [['Buyurtmalar', 'admin-orders'], ['Pickup', 'admin-pickup'], ['Mahsulotlar', 'admin-products'], ['Kategoriyalar', 'admin-categories'], ['Ombor', 'admin-inventory'], ['Mijozlar', 'admin-customers'], ['Sozlamalar', 'admin-settings'], ['Dashboard', 'admin-dashboard']]) {
      await page.getByRole('navigation', { name: 'Admin' }).getByRole('link', { name: label }).click()
      await page.getByTestId(test).waitFor({ timeout: 8000 })
      check((await overflow(page)) <= 0, `390px ${label}: no horizontal overflow`)
    }

    // ------------------------------------------------------------ 3. Cart orders
    const seeded = await ctl('seed-cart-order', 'product=P1&size=M&color=Qora&qty=2')
    const orderNo = seeded.order.orderNumber
    const stockM = async () => (await st()).stock.find((s) => s.product_id === 'P1' && s.size === 'M' && s.color_name === 'Qora').quantity
    eq(await stockM(), 3, 'Cart order took 2 pieces from the stock')
    await page.getByRole('navigation', { name: 'Admin' }).getByRole('link', { name: 'Buyurtmalar' }).click()
    await page.getByTestId('order-row').first().waitFor()
    check((await page.getByTestId('order-row').first().innerText()).includes(orderNo), 'Cart order is listed')
    await page.getByTestId('order-row').first().click()
    await page.getByTestId('order-sheet').waitFor()
    check((await page.getByTestId('order-sheet').innerText()).includes('Toshkent, Chilonzor 9'), 'order sheet shows contact + address')
    await shot(page, 'order-sheet-mobile')
    await ctl('delivery', 'fee=')
    await page.getByTestId('to-confirmed').click()
    await page.waitForFunction(() => document.querySelector('[data-testid="order-sheet"]')?.getAttribute('data-status') === 'confirmed')
    eq((await st()).orders[0].status, 'confirmed', 'order moved to confirmed in the database')
    check((await st()).telegram.some((m) => m.chat_id === 700001), 'the customer got a bot message about the status')
    // delivery fee
    await page.getByTestId('fee-input').fill('20000')
    await page.getByTestId('fee-save').click()
    await page.waitForFunction(() => /220 000/.test(document.querySelector('[data-testid="order-total"]')?.textContent?.replace(/\s/g, ' ') ?? ''))
    eq(Number((await st()).orders[0].total), 220000, 'delivery fee recomputed the total (200 000 + 20 000)')
    // cancel needs a reason, restocks
    await page.getByTestId('to-cancelled').click()
    check(await page.getByTestId('cancel-confirm').isDisabled(), 'cancel is disabled until a reason is typed')
    await page.getByTestId('cancel-reason').fill('Mijoz rad etdi')
    await page.getByTestId('cancel-confirm').click()
    await page.waitForFunction(() => document.querySelector('[data-testid="order-sheet"]')?.getAttribute('data-status') === 'cancelled')
    eq(await stockM(), 5, 'cancelling put the pieces back into the stock')
    check((await page.getByTestId('to-confirmed').count()) === 0, 'a cancelled order has no more actions')
    await page.keyboard.press('Escape')
    await page.getByTestId('order-row').first().waitFor()
    await page.getByRole('tab', { name: /Bekor qilindi/ }).click()
    await sleep(500)
    check((await page.getByTestId('order-row').count()) === 1 && (await page.getByTestId('order-row').first().getAttribute('data-status')) === 'cancelled', 'status filter works')
    await page.getByPlaceholder('Raqam, ism yoki telefon').fill('zzzz')
    await sleep(900)
    check((await page.getByTestId('order-row').count()) === 0, 'search with no match shows an empty list')

    // ------------------------------------------------------------ 4. Pickup (separate from Cart)
    const pk = await ctl('seed-pickup-order', 'product=P2&size=42&color=Oq&qty=1')
    await page.getByRole('navigation', { name: 'Admin' }).getByRole('link', { name: 'Pickup' }).click()
    await page.getByTestId('pickup-row').first().waitFor()
    check((await page.getByTestId('pickup-row').first().innerText()).includes(pk.order.orderNumber), 'Quick order is listed under Pickup, not under Buyurtmalar')
    await page.getByTestId('pickup-row').first().click()
    await page.getByTestId('pk-start').click()
    await page.getByTestId('pk-ready').waitFor()
    await page.getByTestId('pk-ready').click()
    await page.getByTestId('pk-complete').waitFor()
    const code = (await st()).pickup[0].pickup_code
    check(!(await page.locator('body').innerText()).includes(code), 'the pickup code is NOT shown to the admin')
    await page.getByTestId('pk-complete').click()
    check(await page.getByTestId('pk-complete-confirm').isDisabled(), 'handing over is disabled until code + payment are confirmed')
    await page.getByTestId('pk-code').fill('WRONG1')
    await page.getByTestId('pk-paid').check()
    await page.getByTestId('pk-complete-confirm').click()
    await page.getByText("Kod noto'g'ri").waitFor({ timeout: 8000 })
    check(true, 'a wrong code is refused with a clear message')
    await page.getByTestId('pk-code').fill(code)
    await page.getByTestId('pk-complete-confirm').click()
    await page.waitForFunction(() => document.querySelector('[data-testid="pickup-sheet"]')?.getAttribute('data-status') === 'completed')
    eq((await st()).pickup[0].status, 'completed', 'pickup order completed in the database')
    await shot(page, 'pickup-sheet-mobile')
    await page.keyboard.press('Escape')

    // ------------------------------------------------------------ 5. Products: create with a variant, photo, edit
    await page.getByRole('navigation', { name: 'Admin' }).getByRole('link', { name: 'Mahsulotlar' }).click()
    await page.getByTestId('product-row').first().waitFor()
    check((await page.getByTestId('product-row').count()) >= 4, 'product list shows catalog products (also hidden ones)')
    await page.getByTestId('product-new').click()
    await page.getByTestId('p-name').waitFor()
    check(await page.getByTestId('p-save').isDisabled(), 'save is disabled while the form is incomplete')
    await page.getByTestId('p-name').fill("Yangi E2E ko'ylak")
    await page.getByTestId('p-brand').selectOption('b1')
    await page.getByTestId('p-category').selectOption('hoodies')
    await page.getByTestId('p-price').fill('180000')
    await page.getByTestId('variant-add').click()
    await page.getByLabel("O'lcham").fill('M')
    await page.getByLabel('Rang nomi').fill('Ko\'k')
    await page.getByLabel('Rang kodi').fill('#1144AA')
    await page.getByLabel("Boshlang'ich miqdor").fill('7')
    check((await smallInputs(page)) === 0, 'all form fields are >= 16px (no iOS zoom)')
    await shot(page, 'product-edit-mobile')
    await page.getByTestId('p-save').click()
    await page.waitForURL(/\/admin\/products\/(?!new)[^/]+$/, { timeout: 8000 })
    let s = await st()
    const created = s.products.find((p) => p.name === "Yangi E2E ko'ylak")
    check(!!created && created.price === 180000, 'product was created in the database')
    eq(s.stock.find((x) => x.product_id === created.id)?.quantity, 7, 'the variant started with the stock entered')
    // photo
    await page.getByTestId('image-input').setInputFiles({ name: 'p.png', mimeType: 'image/png', buffer: PNG })
    await page.getByTestId('image-tile').first().waitFor({ timeout: 8000 })
    s = await st()
    check(s.images.some((i) => i.product_id === created.id && /^products\/.+\.png$/.test(i.path)), 'photo registered for the product')
    check(s.storage.some((x) => x.op === 'put') && s.storage.some((x) => x.op === 'sign'), 'photo went to Storage through the signed URL')
    await page.getByTestId('image-input').setInputFiles({ name: 'bad.gif', mimeType: 'image/gif', buffer: PNG })
    await page.getByText(/Faqat JPG/).waitFor({ timeout: 5000 })
    check(true, 'a GIF is refused before upload')
    // edit price
    await page.getByTestId('p-price').fill('170000')
    await page.getByTestId('p-save').click()
    await page.getByText('Saqlandi').waitFor({ timeout: 8000 })
    eq((await st()).products.find((p) => p.id === created.id).price, 170000, 'price edit saved')
    // shown in the shop
    const cust = await newCtx(700001)
    await go(cust.page, '/')
    check((await cust.page.locator(`[data-testid="product-card"][data-product-id="${created.id}"]`).count()) > 0, 'the new product appears in the customer shop')
    // hide
    await page.getByTestId('p-active').uncheck()
    await page.getByTestId('p-save').click()
    await page.getByText('Saqlandi').waitFor({ timeout: 8000 })
    await go(cust.page, '/')
    check((await cust.page.locator(`[data-testid="product-card"][data-product-id="${created.id}"]`).count()) === 0, 'hiding the product removes it from the shop')
    await cust.ctx.close()
    await shot(page, 'product-edit-photo-mobile')

    // ------------------------------------------------------------ 6. Categories
    await go(page, '/admin/categories')
    await page.getByTestId('cat-new').click()
    await page.getByTestId('cat-name').fill('Yozgi kiyimlar')
    await page.getByTestId('cat-save').click()
    await page.getByText('Yozgi kiyimlar').waitFor({ timeout: 8000 })
    check((await st()).categories.some((c) => c.id === 'yozgi-kiyimlar'), 'category created with a derived id')
    await page.getByTestId('cat-row').filter({ hasText: 'Xudilar' }).click()
    await page.getByLabel('Faol (do\'konda ko\'rinadi)').uncheck()
    await page.getByTestId('cat-save').click()
    await page.getByText('mahsulotlar bog').waitFor({ timeout: 8000 }).catch(() => {})
    check((await page.getByRole('alert').innerText().catch(() => '')).includes('bog'), 'hiding a category with active products is refused with an explanation')
    await page.keyboard.press('Escape')
    await page.getByTestId('cat-row').filter({ hasText: 'Yozgi kiyimlar' }).click()
    await page.getByTestId('cat-delete').click()
    await page.getByTestId('cat-delete-confirm').click()
    await sleep(800)
    check(!(await st()).categories.some((c) => c.id === 'yozgi-kiyimlar'), 'owner deleted the empty category')

    // ------------------------------------------------------------ 7. Inventory
    await go(page, '/admin/inventory')
    await page.getByTestId('inv-row').first().waitFor()
    await page.getByPlaceholder('Mahsulot, rang yoki SKU').fill('Krossovka')
    await sleep(900)
    await page.getByTestId('inv-row').first().click()
    await ctl('seed-pickup-order', 'product=P2&size=42&color=Oq&qty=2')
    await page.getByTestId('inv-value').fill('1')
    check(await page.getByTestId('inv-save').isDisabled() === false, 'client check is only a hint: the server decides')
    await page.getByTestId('inv-save').click()
    await page.getByRole('alert').waitFor({ timeout: 8000 })
    check(/band/.test(await page.getByRole('alert').innerText()), 'stock below the reserved amount is refused by the server')
    await page.getByTestId('inv-value').fill('9')
    await page.getByTestId('inv-save').click()
    await sleep(900)
    eq((await st()).stock.find((x) => x.product_id === 'P2' && x.size === '42').quantity, 9, 'stock counted to 9')
    await page.keyboard.press('Escape')

    // ------------------------------------------------------------ 8. Customers
    await go(page, '/admin/customers')
    await page.getByTestId('customer-row').first().waitFor()
    await page.getByPlaceholder(/Ism, @username/).fill('u700001')
    await sleep(900)
    await page.getByTestId('customer-row').first().click()
    await page.getByTestId('customer-sheet').waitFor()
    check((await page.getByTestId('customer-sheet').innerText()).includes('Savat buyurtmalari') && (await page.getByTestId('customer-sheet').innerText()).includes('pickup'), 'customer sheet lists Cart and pickup orders separately')
    await page.keyboard.press('Escape')

    // ------------------------------------------------------------ 9. Settings (owner)
    await go(page, '/admin/settings')
    await page.getByTestId('s-fee').fill('25000')
    await page.getByTestId('s-save').click()
    await page.getByText('Saqlandi').first().waitFor({ timeout: 8000 })
    eq(Number((await st()).settings.delivery_fee), 25000, 'owner saved the delivery fee')
    await page.getByTestId('s-address').fill('Toshkent, Amir Temur 1')
    await page.getByTestId('s-pickup-save').click()
    await sleep(900)
    eq((await st()).pickupSettings.store_address, 'Toshkent, Amir Temur 1', 'owner saved the store address')
    check((await page.getByText('Administratorlar').count()) === 1 && (await page.getByText('bazasida').count()) > 0, 'admins are listed read-only with the explanation')
    check((await page.getByRole('button', { name: /qo'shish.*administrator/i }).count()) === 0, 'there is no control to add an administrator')
    await shot(page, 'settings-mobile')
    check((await overflow(page)) <= 0, '390px settings: no horizontal overflow')
    await O.ctx.close()

    // ------------------------------------------------------------ 10. manager: can work, cannot change settings
    const M = await newCtx(900002)
    await go(M.page, '/admin/settings')
    await M.page.getByTestId('admin-settings').waitFor({ timeout: 8000 })
    check((await M.page.getByText('Menejer').count()) > 0, 'manager sees the Menejer badge')
    check(await M.page.getByTestId('s-fee').isDisabled() && (await M.page.getByTestId('s-save').count()) === 0, 'manager sees settings read-only (no save button)')
    check((await M.page.getByText('Administratorlar').count()) === 0, 'manager does not see the administrators list')
    await go(M.page, '/admin/orders')
    await M.page.getByTestId('admin-orders').waitFor()
    check(true, 'manager can open orders')
    await M.ctx.close()
    const aud = (await st()).audit
    check(aud.length > 8 && aud.every((a) => a.admin === 900001), 'every change is in the audit log under the owner')
    const adm = (await st()).admins
    eq(adm.map((a) => [a.tg, a.role, a.active]), [[900001, 'owner', true], [900002, 'manager', true]], 'the administrators table was not changed by the panel')

    // ------------------------------------------------------------ 11. desktop + 320px
    const D = await newCtx(900001, { width: 1280, mobile: false })
    await go(D.page, '/admin')
    await D.page.getByTestId('admin-dashboard').waitFor({ timeout: 8000 })
    check((await overflow(D.page)) <= 0, '1280px dashboard: no horizontal overflow')
    check((await D.page.getByRole('navigation', { name: 'Admin' }).evaluate((n) => getComputedStyle(n).flexDirection)) === 'column', 'desktop shows the sidebar navigation')
    await shot(D.page, 'dashboard-desktop')
    await go(D.page, '/admin/products')
    await D.page.getByTestId('product-row').first().waitFor()
    await shot(D.page, 'products-desktop')
    await D.ctx.close()
    const W = await newCtx(900001, { width: 320 })
    for (const p of ['/admin', '/admin/orders', '/admin/pickup', '/admin/products', '/admin/categories', '/admin/inventory', '/admin/customers', '/admin/settings']) {
      await go(W.page, p); await sleep(300)
      check((await overflow(W.page)) <= 0, `320px ${p}: no horizontal overflow`)
    }
    await W.ctx.close()

    check(errors.length === 0, `no unexpected console/page errors ${errors.slice(0, 3).join(' | ')}`)
  } finally {
    await browser.close()
    if (child) { try { process.kill(-child.pid, 'SIGTERM') } catch {} }
  }
  console.log(fails.length ? `\n${fails.length} FAILED:\n - ${fails.join('\n - ')}` : '\nALL PASSED')
  process.exit(fails.length ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(1) })
