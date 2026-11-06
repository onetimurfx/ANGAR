/* LIVE E2E: the built app talks to a real PostgreSQL + the real Edge Function handlers (tests/e2e/live-server.ts).
   Covers: catalog from the backend, per-variant stock, orders stored on the server, stock decrease, duplicate protection,
   idempotent retry, stock conflicts, sample products, server/offline errors, auth (not in Telegram, forged initData),
   user isolation, delivery fee from the database, bot notifications. Only Telegram's Bot API is fake. */
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

function initData(userId, { tamper = false } = {}) {
  const fields = { auth_date: String(Math.floor(Date.now() / 1000)), query_id: 'AAE2E', user: JSON.stringify({ id: userId, first_name: 'Ali', last_name: 'Valiyev', username: `u${userId}`, language_code: 'uz' }) }
  const check = Object.entries(fields).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('\n')
  const secret = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest()
  const hash = createHmac('sha256', secret).update(check).digest('hex')
  return new URLSearchParams({ ...fields, hash: tamper ? hash.replace(/^./, (c) => (c === '0' ? '1' : '0')) : hash }).toString()
}

const tgScript = (id, data) => `(() => { const noop = () => {}; window.Telegram = { WebApp: { initData: ${JSON.stringify(data)}, initDataUnsafe: { user: { id: ${id}, first_name: 'Ali', last_name: 'Valiyev', username: 'u${id}' } }, platform: 'android', colorScheme: 'light', viewportStableHeight: 800, BackButton: { show: noop, hide: noop, onClick: noop, offClick: noop }, ready: noop, expand: noop, setHeaderColor: noop, setBackgroundColor: noop, isVersionAtLeast: () => false, onEvent: noop } } })()`

const state = async () => (await fetch(`${API}/__test/state`)).json()
const ctl = (op, qs = '') => fetch(`${API}/__test/${op}${qs ? `?${qs}` : ''}`)

;(async () => {
  fs.mkdirSync(SHOTS, { recursive: true })
  let child = null
  if (!process.env.AYN_API) {
    // build the app against the live API, then start it
    const b = spawnSync('npx', ['vite', 'build', '--outDir', 'dist-live'], { stdio: 'ignore', env: { ...process.env, VITE_SUPABASE_URL: API, VITE_SUPABASE_ANON_KEY: 'anon-e2e-key-0123456789-abcdefghij' } })
    if (b.status !== 0) throw new Error('live build failed')
    child = spawn('npx', ['tsx', 'tests/e2e/live-server.ts'], { stdio: ['ignore', 'pipe', 'inherit'], detached: true })
    await new Promise((res, rej) => { child.stdout.on('data', (d) => String(d).includes('READY') && res()); setTimeout(() => rej(new Error('live server did not start')), 90000) })
  }
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] })
  const errors = []
  const newCtx = async (tgId, opts = {}) => {
    const ctx = await browser.newContext({ viewport: { width: opts.width || 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
    if (tgId) await ctx.addInitScript(tgScript(tgId, initData(tgId, opts)))
    await ctx.route('**/telegram.org/**', (r) => r.abort())
    const page = await ctx.newPage()
    page.on('pageerror', (e) => errors.push(String(e)))
    page.on('console', (m) => m.type() === 'error' && !/telegram\.org|ERR_|Failed to load resource|INJECTED|net::/.test(m.text()) && errors.push(m.text()))
    return { ctx, page }
  }
  try {
    const { ctx, page } = await newCtx(700001)
    const go = async (p) => { await page.goto(WEB + p, { waitUntil: 'networkidle' }); await sleep(300) }
    const shot = async (n) => { await sleep(400); await page.screenshot({ path: path.join(SHOTS, `p5-${n}.png`) }) }
    const fill = async ({ name = 'Ali Valiyev', phone = '901234567', address = 'Toshkent sh., Chilonzor 9, 12-uy', comment = 'Ertalab' } = {}) => {
      await page.getByTestId('f-name').fill(name); await page.getByTestId('f-phone').fill(phone); await page.getByTestId('f-address').fill(address); await page.getByTestId('f-comment').fill(comment)
    }
    const quickPick = async (id, size) => {
      await go('/tezkor-buyurtma')
      await page.locator(`[data-testid="quick-pick"][data-product-id="${id}"]`).click()
      if (size) await page.getByRole('radio', { name: size, exact: true }).click()
    }
    const problem = async () => { await page.getByTestId('submit-problem').waitFor({ timeout: 15000 }); return (await page.getByTestId('submit-problem').innerText()) }

    // ------------------------------------------------------------ 1. catalog comes from the backend
    await ctl('reset-orders')
    await go('/')
    const ids = await page.getByTestId('product-card').evaluateAll((els) => els.map((e) => e.getAttribute('data-product-id')))
    check(ids.includes('P1') && ids.includes('P2') && ids.includes('SMP'), 'home shows the products from the database')
    check(!ids.includes('GONE') && !ids.some((i) => /^s-/.test(i)), 'inactive product and built-in sample products are NOT shown')
    check(!(await page.getByTestId('no-backend-notice').count()), 'no "server not connected" notice when the backend is configured')
    const p1card = page.locator('[data-testid="product-card"][data-product-id="P1"]').first()
    const smpcard = page.locator('[data-testid="product-card"][data-product-id="SMP"]').first()
    check(!/NAMUNA/i.test(await p1card.innerText()), 'a real (non-sample) product has no NAMUNA badge')
    check(/NAMUNA/i.test(await smpcard.innerText()), 'a sample product from the database is marked NAMUNA')
    check((await page.locator('body').innerText()).includes('Xudilar'), 'category names come from the database')
    await shot('01-home-server')

    // ------------------------------------------------------------ 2. per-variant stock on the product page
    await go('/mahsulot/P1')
    const sizes = await page.getByRole('radio').allInnerTexts()
    eq(sizes.map((s) => s.trim()).sort(), ['L', 'M'], 'only active sizes are offered (inactive XL is hidden)')
    await page.getByRole('radio', { name: 'L', exact: true }).click()
    check((await page.getByTestId('stock-status').innerText()).includes('2'), 'stock line shows the chosen variant (L / Qora = 2)')
    await page.getByRole('button', { name: 'Oq' }).click()
    check(await page.getByRole('radio', { name: 'M', exact: true }).isDisabled(), 'size M is disabled in colour Oq (stock 0)')
    await shot('02-product-variant')

    // ------------------------------------------------------------ 3. quick order stored on the server, duplicate taps, stock, bot
    await quickPick('P1', 'M')
    await fill()
    await page.getByTestId('submit-order').scrollIntoViewIfNeeded()
    await page.getByTestId('submit-order').dblclick()
    await page.getByTestId('order-confirmed').waitFor({ timeout: 15000 })
    check(/\/buyurtma\/[0-9a-f-]{36}$/.test(page.url()), 'confirmation URL carries the SERVER order id')
    check(!(await page.getByTestId('not-sent').count()) && !(await page.getByTestId('draft-badge').count()), 'confirmation does not claim "not sent" and shows no draft badge')
    const num = (await page.getByTestId('order-ref').innerText()).trim()
    check(/^AYN-\d{6}-\d{5}$/.test(num), `official order number shown (${num})`)
    await shot('03-confirmation-server')
    let st = await state()
    eq(st.orders.length, 1, 'double tap created exactly ONE order')
    eq(st.stock.find((s) => s.product_id === 'P1' && s.size === 'M' && s.color_name === 'Qora').quantity, 4, 'stock decreased 5 -> 4 on the server')
    eq(st.orders[0].order_number, num, 'number on screen = number in the database')
    check(st.orders[0].delivery_pending === true, 'delivery fee is pending (the shop has not set one)')
    const admin = st.telegram.find((m) => m.chat_id === 900001)
    const cust = st.telegram.find((m) => m.chat_id === 700001)
    check(admin && admin.text.includes(num) && admin.text.includes('Yangi buyurtma') && admin.text.includes('Server Xudi'), 'admin (Telegram id 900001) got the new-order message via the bot')
    check(cust && cust.text.includes('qabul qilindi'), 'customer got the confirmation message')
    const orderUrl = page.url()

    await page.reload({ waitUntil: 'networkidle' })
    await page.getByTestId('order-confirmed').waitFor({ timeout: 15000 })
    eq((await page.getByTestId('order-ref').innerText()).trim(), num, 'order is reloaded from the SERVER after refresh')
    await ctx.clearCookies()
    await page.evaluate(() => localStorage.clear())
    await go('/profil')
    await page.getByTestId('profile-order').first().waitFor({ timeout: 15000 })
    eq(await page.getByTestId('profile-order').count(), 1, 'profile lists the server order even with empty local storage')
    check(/yangi/i.test(await page.getByTestId('profile-order').innerText()), 'profile shows the server status (Yangi)')
    check(/serverda tasdiqlangan/i.test(await page.locator('body').innerText()), 'profile says the Telegram account is verified by the server')
    await shot('04-profile-server')

    // ------------------------------------------------------------ 4. cart saved on the server, restored, then ordered
    await go('/mahsulot/P2')
    await page.getByRole('radio', { name: '42', exact: true }).click()
    await page.getByTestId('add-to-cart').click()
    await page.getByTestId('toast').waitFor()
    await sleep(1500)
    st = await state()
    eq(st.cart.map((c) => `${c.product_id}|${c.size}|${c.color_name}|${c.qty}`), ['P2|42|Oq|1'], 'cart row exists on the server')
    await page.evaluate(() => localStorage.clear())
    await go('/savatcha')
    await page.getByTestId('cart-line').first().waitFor({ timeout: 15000 })
    eq(await page.getByTestId('cart-line').count(), 1, 'cart is restored from the server after local storage was wiped')
    await go('/savatcha/buyurtma')
    await fill({ name: 'Vali Karimov', phone: '+998 93 555 44 33', address: 'Samarqand sh., Registon 5-uy' })
    await page.getByTestId('submit-order').click()
    await page.getByTestId('order-confirmed').waitFor({ timeout: 15000 })
    await sleep(1500)
    st = await state()
    eq(st.orders.length, 2, 'cart order stored (2 orders now)')
    eq(st.cart.length, 0, 'server cart is empty after the order')
    eq(st.stock.find((s) => s.product_id === 'P2').quantity, 2, 'stock of P2 decreased 3 -> 2')

    // ------------------------------------------------------------ 5. stock conflict (somebody else bought it meanwhile)
    await quickPick('P1', 'M')
    await fill()
    await ctl('set-stock', 'product=P1&size=M&color=Qora&qty=0')
    await page.getByTestId('submit-order').click()
    const t5 = await problem()
    check(/Zaxira yetarli emas/.test(t5) && t5.includes('Server Xudi'), 'stock conflict is explained with the product name')
    eq((await state()).orders.length, 2, 'no order was created for the conflicting request')
    check((await page.getByTestId('f-name').inputValue()) === 'Ali Valiyev', 'form data is kept after the failure')
    await shot('05-stock-conflict')
    await ctl('set-stock', 'product=P1&size=M&color=Qora&qty=4')

    // ------------------------------------------------------------ 6. sample product cannot be ordered
    await quickPick('SMP', 'M')
    await fill()
    await page.getByTestId('submit-order').click()
    check(/namunaviy/i.test(await problem()), 'sample product order is refused with a clear message')
    eq((await state()).orders.length, 2, 'no order was created for a sample product')

    // ------------------------------------------------------------ 7. server error then retry = exactly one order
    await sleep(1200)
    await quickPick('P1', 'M')
    await fill()
    await ctl('fail', 'n=1')
    await page.getByTestId('submit-order').click()
    check(/vaqtincha nosozlik/i.test(await problem()), 'server error: clear message')
    check(/yuborilmadi/i.test(await page.getByTestId('submit-problem').innerText()), 'server error: says the order was NOT sent')
    eq((await state()).orders.length, 2, 'server error created nothing')
    await shot('06-server-error')
    await page.getByTestId('submit-order').click()
    await page.getByTestId('order-confirmed').waitFor({ timeout: 15000 })
    eq((await state()).orders.length, 3, 'retry after the error created exactly one order')

    // ------------------------------------------------------------ 8. offline then online
    await quickPick('P1', 'L')
    await fill()
    await ctx.setOffline(true)
    await page.getByTestId('submit-order').click()
    check(/internet aloqasi/i.test(await problem()), 'offline: clear message')
    eq((await state()).orders.length, 3, 'offline created nothing')
    await shot('07-offline')
    await ctx.setOffline(false)
    await page.getByTestId('submit-order').click()
    await page.getByTestId('order-confirmed').waitFor({ timeout: 15000 })
    eq((await state()).orders.length, 4, 'back online: the same form went through once')

    // ------------------------------------------------------------ 9. delivery fee only from the database
    await quickPick('P2', '42')
    check(/belgilanmagan/i.test(await page.locator('body').innerText()), 'delivery is shown as "not set" when the shop has not configured it')
    await ctl('delivery', 'fee=25000&free=')
    await go('/tezkor-buyurtma')
    await page.locator('[data-testid="quick-pick"][data-product-id="P2"]').click()
    await page.getByRole('radio', { name: '42', exact: true }).click()
    check((await page.locator('body').innerText()).includes('25 000'), 'a fee saved in the database is shown (test value)')
    await ctl('delivery', 'fee=')

    // ------------------------------------------------------------ 10. another user sees nothing of ours
    const b = await newCtx(700002)
    await b.page.goto(WEB + '/profil', { waitUntil: 'networkidle' })
    await b.page.getByTestId('profile-order').first().waitFor({ timeout: 3000 }).catch(() => {})
    eq(await b.page.getByTestId('profile-order').count(), 0, 'a different Telegram user has no orders')
    await b.page.goto(orderUrl.replace(WEB, WEB), { waitUntil: 'networkidle' })
    await sleep(500)
    check(!(await b.page.getByTestId('order-confirmed').count()), 'another user cannot open our order by its URL')
    await b.ctx.close()

    // ------------------------------------------------------------ 11. not in Telegram / forged initData
    const n = await newCtx(null)
    await n.page.goto(WEB + '/tezkor-buyurtma', { waitUntil: 'networkidle' })
    await n.page.locator('[data-testid="quick-pick"][data-product-id="P1"]').click()
    await n.page.getByRole('radio', { name: 'M', exact: true }).click()
    check(await n.page.getByTestId('auth-notice').isVisible(), 'outside Telegram the form says why ordering is not possible')
    await n.page.getByTestId('f-name').fill('Ali Valiyev'); await n.page.getByTestId('f-phone').fill('901234567'); await n.page.getByTestId('f-address').fill('Toshkent sh., Chilonzor 9, 12-uy')
    await n.page.getByTestId('submit-order').click()
    check(/Telegram ichidagi/i.test(await n.page.getByTestId('submit-problem').innerText()), 'submit outside Telegram is refused with a clear message')
    await n.ctx.close()
    const f = await newCtx(700003, { tamper: true })
    await f.page.goto(WEB + '/tezkor-buyurtma', { waitUntil: 'networkidle' })
    await sleep(800)
    check(await f.page.getByTestId('auth-notice').isVisible(), 'forged initData is rejected by the server (auth notice shown)')
    await f.ctx.close()
    eq((await state()).orders.length, 4, 'unauthenticated attempts created no orders')

    // ------------------------------------------------------------ 12. layout 320 px on the new screens
    const s = await newCtx(700001, { width: 320 })
    for (const p of ['/', '/profil', orderUrl.replace(WEB, '')]) {
      await s.page.goto(WEB + p, { waitUntil: 'networkidle' }); await sleep(500)
      const over = await s.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
      check(over <= 0, `320px ${p.slice(0, 20)}: no horizontal overflow`)
    }
    await s.ctx.close()

    check(errors.length === 0, `no unexpected console/page errors ${errors.slice(0, 3).join(' | ')}`)
    await ctx.close()
  } finally {
    await browser.close()
    if (child) { try { process.kill(-child.pid, 'SIGTERM') } catch {} }
  }
  console.log(fails.length ? `\n${fails.length} FAILED:\n - ${fails.join('\n - ')}` : '\nALL PASSED')
  process.exit(fails.length ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(1) })
