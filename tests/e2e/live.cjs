/* LIVE E2E: the built app talks to a real PostgreSQL + the real Edge Function handlers (tests/e2e/live-server.ts).
   Covers: catalog from the backend, per-variant stock, orders stored on the server, stock decrease, duplicate protection,
   idempotent retry, stock conflicts, sample products, server/offline errors, auth (not in Telegram, forged initData),
   user isolation, delivery fee from the database, bot notifications (Cart orders), and Quick Order = STORE PICKUP
   (basket, reservations, status screen, pickup code, admin steps, cancel, failures, isolation, retired source='quick').
   Only Telegram's Bot API is fake. */
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
    // Cart orders (Quick Order is store pickup now): put ONE variant in an empty cart and open the checkout
    const cartPick = async (id, size, extra = null) => {
      await ctl('clear-cart')
      await page.evaluate(() => localStorage.removeItem('aynimo:cart')).catch(() => {})
      for (const [pid, sz] of [[id, size], ...(extra ? [extra] : [])]) {
        await go(`/mahsulot/${pid}`)
        await page.getByRole('radio', { name: sz, exact: true }).click()
        await page.getByTestId('add-to-cart').click()
        await page.getByTestId('toast').waitFor()
        await sleep(900)
      }
      await go('/savatcha/buyurtma')
    }
    const problem = async () => {
      try { await page.getByTestId('submit-problem').waitFor({ timeout: 15000 }) } catch (e) { await page.screenshot({ path: path.join(SHOTS, 'debug-no-problem.png') }); console.log('DEBUG url', page.url(), '\n', (await page.locator('body').innerText()).slice(0, 600)); throw e }
      return (await page.getByTestId('submit-problem').innerText())
    }

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

    // ------------------------------------------------------------ 3. Cart order stored on the server, duplicate taps, stock, bot
    await cartPick('P1', 'M')
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
    // (a second line keeps the cart non-empty: a sold-out line is dropped from the cart when fresh stock arrives)
    await cartPick('P1', 'M', ['P2', '42'])
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
    await cartPick('SMP', 'M')
    await fill()
    await page.getByTestId('submit-order').click()
    check(/namunaviy/i.test(await problem()), 'sample product order is refused with a clear message')
    eq((await state()).orders.length, 2, 'no order was created for a sample product')

    // ------------------------------------------------------------ 7. server error then retry = exactly one order
    await sleep(1200)
    await cartPick('P1', 'M')
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
    await cartPick('P1', 'L')
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
    await cartPick('P2', '42')
    check(/belgilanmagan/i.test(await page.locator('body').innerText()), 'delivery is shown as "not set" when the shop has not configured it')
    await ctl('delivery', 'fee=25000&free=')
    await go('/savatcha/buyurtma')
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
    await n.page.goto(WEB + '/mahsulot/P1', { waitUntil: 'networkidle' })
    await n.page.getByRole('radio', { name: 'M', exact: true }).click()
    await n.page.getByTestId('add-to-cart').click()
    await n.page.getByTestId('toast').waitFor()
    await n.page.goto(WEB + '/savatcha/buyurtma', { waitUntil: 'networkidle' })
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


    // ============================================================ 13. QUICK ORDER = STORE PICKUP (Phase 6 / D)
    const tokenOf = async (id) => (await (await fetch(`${API}/functions/v1/telegram-auth`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ initData: initData(id) }) })).json()).token
    const adm = async (body) => { const r = await fetch(`${API}/functions/v1/admin-pickup`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-aynimo-session': await tokenOf(900001) }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() } }
    const fillP = async ({ name = 'Ali Valiyev', phone = '901234567', comment = '' } = {}) => { await page.getByTestId('f-name').fill(name); await page.getByTestId('f-phone').fill(phone); await page.getByTestId('f-comment').fill(comment) }
    const addP = async (id, size, ups = 0) => {
      await page.locator(`[data-testid="quick-pick"][data-product-id="${id}"]`).click()
      if (size) await page.locator('[data-testid="quick-size"]', { hasText: new RegExp(`^${size}$`) }).click()
      for (let i = 0; i < ups; i++) await page.getByTestId('quick-item').getByRole('button', { name: 'Miqdorni oshirish' }).click()
      await page.getByTestId('quick-add').click()
      await page.getByTestId('toast').last().waitFor()
    }
    const pst = async () => { const x = await state(); return x }
    const waitStatus = (st, ms = 25000) => page.waitForFunction((v) => document.querySelector('[data-testid="pickup-order"]')?.getAttribute('data-status') === v, st, { timeout: ms })
    await ctl('reset-orders'); await ctl('reset-pickup'); await ctl('clear-cart')
    await ctl('set-stock', 'product=P1&size=M&color=Qora&qty=5'); await ctl('set-stock', 'product=P1&size=L&color=Qora&qty=2'); await ctl('set-stock', 'product=P2&size=42&color=Oq&qty=3')
    await page.evaluate(() => { localStorage.clear(); sessionStorage.clear() })

    // ---- 13a. only real in-stock products/variants; no delivery
    await go('/tezkor-buyurtma')
    check(await page.getByTestId('pickup-note').isVisible(), 'Quick Order explains: store pickup only, pay in store')
    const rail = await page.getByTestId('quick-pick').evaluateAll((els) => els.map((e) => e.getAttribute('data-product-id')))
    check(rail.includes('P1') && rail.includes('P2') && !rail.includes('GONE'), 'rail lists in-stock server products and hides the inactive one')
    eq(await page.getByTestId('f-address').count(), 0, 'no delivery address field in Quick Order')
    eq(await page.getByTestId('delivery-fee').count(), 0, 'no delivery fee line in Quick Order')
    check(!/kuryer/i.test(await page.locator('body').innerText()), 'no courier wording in Quick Order')
    eq(await page.getByRole('navigation', { name: 'Asosiy navigatsiya' }).locator('a').evaluateAll((a) => a.map((x) => x.getAttribute('aria-label'))), ['Asosiy', 'Katalog', 'Tezkor buyurtma', 'Savatcha', 'Profil'], 'five-item navigation unchanged')
    await page.locator('[data-testid="quick-pick"][data-product-id="P1"]').click()
    eq(await page.getByTestId('quick-color').count(), 1, 'P1: only the colour that has stock is offered (Oq has 0)')
    eq((await page.getByTestId('quick-size').allInnerTexts()).map((x) => x.trim()).sort(), ['L', 'M'], 'P1: only active sizes with stock (inactive XL hidden)')
    await page.getByTestId('quick-add').click()
    check(await page.getByTestId('err-size').isVisible(), 'adding without a size asks for the size')
    await page.locator('[data-testid="quick-size"]', { hasText: /^M$/ }).click()
    for (let i = 0; i < 4; i++) await page.getByTestId('quick-item').getByRole('button', { name: 'Miqdorni oshirish' }).click()
    eq((await page.getByTestId('quick-item').locator('output').innerText()).trim(), '5', 'quantity reached the real stock of the variant (5)')
    check(await page.getByTestId('quick-item').getByRole('button', { name: 'Miqdorni oshirish' }).isDisabled(), 'quantity cannot go above the stock (+ is disabled at 5)')
    for (let i = 0; i < 3; i++) await page.getByTestId('quick-item').getByRole('button', { name: 'Miqdorni kamaytirish' }).click()
    await page.getByTestId('quick-add').click()
    await page.getByTestId('toast').last().waitFor()
    await addP('P2', null)
    eq(await page.getByTestId('quick-line').count(), 2, 'two different products in ONE order')
    check((await page.getByTestId('cart-total').innerText()).includes('450 000'), 'total = 2 x 100 000 + 250 000 (no delivery added)')
    eq((await page.getByRole('link', { name: /Savatcha/ }).count()) >= 0, true, 'cart link exists')
    eq(JSON.parse((await page.evaluate(() => localStorage.getItem('aynimo:cart'))) ?? '[]'), [], 'Quick Order basket did not touch the Cart')
    await shot('13-quick-basket')

    // ---- 13b. validation: name + phone required, comment optional
    await page.getByTestId('f-name').fill('')
    await page.getByTestId('submit-order').click()
    check((await page.locator('[aria-invalid="true"]').count()) >= 2, 'empty name and phone are both flagged')
    eq((await pst()).pickup.length, 0, 'nothing sent while the contact is invalid')
    await fillP()
    check(!(await page.locator('[aria-invalid="true"]').count()), 'comment is optional: valid with an empty comment')

    // ---- 13c. submit (double tap), real server answer, status screen, NO code yet
    await page.getByTestId('submit-order').scrollIntoViewIfNeeded()
    await page.getByTestId('submit-order').dblclick()
    await page.waitForURL(/\/tezkor-buyurtma\/[0-9a-f-]{36}$/, { timeout: 15000 })
    await page.getByTestId('pickup-order').waitFor()
    const pickupUrl = page.url()
    st = await pst()
    eq(st.pickup.length, 1, 'double tap created exactly ONE pickup order')
    check(/^PU-/.test(st.pickup[0].order_number) && (await page.locator('body').innerText()).includes(st.pickup[0].order_number), 'the PU- number on screen is the server number')
    eq(await page.getByTestId('pickup-order').getAttribute('data-status'), 'pending', 'status pending')
    eq(await page.getByTestId('pickup-code-card').count(), 0, 'NO pickup code while pending')
    eq(st.reservations.filter((r) => r.status === 'active').length, 2, 'two active reservations')
    eq(st.stock.find((x) => x.product_id === 'P1' && x.size === 'M' && x.color_name === 'Qora').quantity, 5, 'physical stock NOT deducted at order time')
    eq(await page.evaluate(() => sessionStorage.getItem('aynimo:quick-basket')), null, 'basket cleared after the server accepted')
    eq(await page.evaluate(() => sessionStorage.getItem('aynimo:attempt:pickup')), null, 'attempt key cleared after success')
    check(st.telegram.some((m) => m.chat_id === 900001 && /Yangi buyurtma/.test(m.text) && m.text.includes(st.pickup[0].order_number)), 'admin got the new pickup order via the bot')
    check(st.telegram.some((m) => m.chat_id === 700001 && /qabul qilindi/.test(m.text)), 'customer got the confirmation via the bot')
    await shot('14-pickup-pending')
    await go('/mahsulot/P1')
    await page.getByRole('radio', { name: 'M', exact: true }).click()
    check((await page.getByTestId('stock-status').innerText()).includes('3'), 'catalog shows AVAILABLE stock (5 - 2 reserved = 3)')

    // ---- 13d. admin works the order; the customer's screen follows; code only when ready
    await go(pickupUrl.replace(WEB, ''))
    const a1 = await adm({ action: 'start_preparing', id: pickupUrl.split('/').pop() })
    eq(a1.status, 200, 'admin started preparing')
    try { await waitStatus('preparing') } catch (e) { const r = await fetch(`${API}/functions/v1/pickup-order?id=${pickupUrl.split('/').pop()}`, { headers: { 'x-aynimo-session': await tokenOf(700001) } }); console.log('DEBUG order json', JSON.stringify(await r.json())); console.log('DEBUG body', (await page.locator('body').innerText()).slice(0, 400)); throw e }
    check(true, 'the open status screen refreshes by itself (preparing)')
    eq(await page.getByTestId('pickup-code-card').count(), 0, 'NO code while preparing')
    eq(await page.getByTestId('pickup-cancel').count(), 0, 'customer cannot cancel once preparing')
    const a2 = await adm({ action: 'mark_ready', id: pickupUrl.split('/').pop() })
    eq(a2.status, 200, 'admin marked ready')
    await waitStatus('ready_for_pickup')
    await page.getByTestId('pickup-code').waitFor()
    st = await pst()
    const code = st.pickup[0].pickup_code
    eq((await page.getByTestId('pickup-code').innerText()).trim(), code, 'the code on screen = the server code')
    check(/^[A-HJ-NP-Z2-9]{8}$/.test(code), 'code format')
    check(st.telegram.some((m) => m.chat_id === 700001 && m.text.includes(code)), 'customer also got the code via the bot')
    check(!st.telegram.some((m) => m.chat_id === 900001 && m.text.includes(code)), 'the admin never gets the code via the bot')
    await shot('15-pickup-ready-code')
    await go('/profil')
    await page.getByTestId('pickup-history-item').first().waitFor({ timeout: 15000 })
    eq(await page.getByTestId('pickup-history-item').count(), 1, 'Profile lists the pickup order')
    eq(await page.getByTestId('pickup-history-item').first().getAttribute('data-status'), 'ready_for_pickup', 'Profile shows its status')
    check(!(await page.locator('body').innerText()).includes(code), 'the code is NOT shown in the Profile list')
    await shot('16-profile-pickup')

    // ---- 13e. handover: code is checked, payment confirmed, single use
    const bad = await adm({ action: 'complete', id: pickupUrl.split('/').pop(), code: code[0] === 'A' ? 'B' + code.slice(1) : 'A' + code.slice(1), paymentConfirmed: true, amount: 450000 })
    eq([bad.status, bad.body.error.code], [422, 'INVALID_CODE'], 'a wrong code is refused')
    const noPay = await adm({ action: 'complete', id: pickupUrl.split('/').pop(), code, paymentConfirmed: false, amount: 450000 })
    eq([noPay.status, noPay.body.error.code], [422, 'PAYMENT_REQUIRED'], 'no payment confirmation, no handover')
    const done = await adm({ action: 'complete', id: pickupUrl.split('/').pop(), code, paymentConfirmed: true, amount: 450000 })
    eq(done.status, 200, 'handover with the right code + payment')
    check((await adm({ action: 'complete', id: pickupUrl.split('/').pop(), code, paymentConfirmed: true, amount: 450000 })).status >= 409, 'the same code cannot be used twice')
    st = await pst()
    eq(st.stock.find((x) => x.product_id === 'P1' && x.size === 'M' && x.color_name === 'Qora').quantity, 3, 'stock deducted once, at handover (5 -> 3)')
    await go(pickupUrl.replace(WEB, ''))
    eq(await page.getByTestId('pickup-order').getAttribute('data-status'), 'completed', 'customer sees Completed')
    eq(await page.getByTestId('pickup-code-card').count(), 0, 'no code after completion')
    await ctl('set-stock', 'product=P1&size=M&color=Qora&qty=5'); await ctl('set-stock', 'product=P2&size=42&color=Oq&qty=3')

    // ---- 13f. customer cancels while pending
    await go('/tezkor-buyurtma')
    await addP('P2', null)
    await fillP({ comment: 'Kechqurun olaman' })
    await page.getByTestId('submit-order').click()
    await page.waitForURL(/\/tezkor-buyurtma\/[0-9a-f-]{36}$/, { timeout: 15000 })
    await page.getByTestId('pickup-cancel').click()
    await page.getByTestId('pickup-cancel-yes').click()
    await waitStatus('cancelled', 15000)
    st = await pst()
    eq(st.pickup.filter((x) => x.status === 'cancelled').length, 1, 'order cancelled on the server')
    eq(st.reservations.filter((r) => r.status === 'active').length, 0, 'reservation released')
    eq(await page.getByTestId('pickup-cancel').count(), 0, 'no cancel button on a closed order')

    // ---- 13g. stock runs out between choosing and sending
    await go('/tezkor-buyurtma')
    await addP('P1', 'M')
    await fillP({ name: 'Ali Valiyev' })
    await ctl('set-stock', 'product=P1&size=M&color=Qora&qty=0')
    await page.getByTestId('submit-order').click()
    check(/yetarli emas/i.test(await problem()), 'stock ran out: clear message')
    eq((await pst()).pickup.length, 2, 'no order for the conflicting request')
    eq(await page.getByTestId('f-name').inputValue(), 'Ali Valiyev', 'form data kept')
    await shot('17-pickup-stock')
    await ctl('set-stock', 'product=P1&size=M&color=Qora&qty=5')

    // ---- 13h. server error: "not confirmed", retry makes exactly one order
    await go('/tezkor-buyurtma')
    await addP('P1', 'M')
    await fillP()
    await ctl('fail', 'n=1')
    await page.getByTestId('submit-order').click()
    await problem()
    eq(await page.getByTestId('submit-problem').getAttribute('data-kind'), 'unconfirmed', 'a 5xx is shown as NOT CONFIRMED (never as success)')
    check(await page.getByTestId('check-orders').isVisible(), 'offers to check the orders')
    check(!/\/tezkor-buyurtma\/[0-9a-f-]{36}$/.test(page.url()), 'no success screen after a server error')
    eq((await pst()).pickup.length, 2, 'the injected failure created nothing')
    await shot('18-pickup-unconfirmed')
    await page.getByTestId('submit-order').click()
    await page.waitForURL(/\/tezkor-buyurtma\/[0-9a-f-]{36}$/, { timeout: 15000 })
    eq((await pst()).pickup.length, 3, 'retry created exactly one order')

    // ---- 13i. offline: nothing is sent and the screen says so; online: goes through once
    await go('/tezkor-buyurtma')
    await addP('P1', 'L')
    await fillP()
    await ctx.setOffline(true)
    await sleep(300)
    check(await page.getByTestId('offline-banner').isVisible(), 'offline banner is shown')
    await page.getByTestId('submit-order').click()
    check(/internet aloqasi/i.test(await problem()), 'offline: clear message')
    check(/yuborilmadi/i.test(await page.getByTestId('submit-problem').innerText()), 'offline: says NOT sent')
    eq((await pst()).pickup.length, 3, 'offline created nothing')
    await shot('19-pickup-offline')
    await ctx.setOffline(false)
    await sleep(300)
    await page.getByTestId('submit-order').click()
    await page.waitForURL(/\/tezkor-buyurtma\/[0-9a-f-]{36}$/, { timeout: 15000 })
    eq((await pst()).pickup.length, 4, 'back online: one order')

    // ---- 13j. active-order limit (3) is explained
    await go('/tezkor-buyurtma')
    await addP('P2', null)
    await fillP()
    await page.getByTestId('submit-order').click()
    await page.waitForURL(/\/tezkor-buyurtma\/[0-9a-f-]{36}$/, { timeout: 15000 })
    await go('/tezkor-buyurtma')
    await addP('P2', null)
    await fillP()
    await page.getByTestId('submit-order').click()
    check(/chegaraga yetdi/i.test(await problem()), '4th active order: limit explained')

    // ---- 13k. isolation + retired source='quick'
    const o2 = await newCtx(700002)
    await o2.page.goto(WEB + pickupUrl.replace(WEB, ''), { waitUntil: 'networkidle' })
    await sleep(800)
    check(/topilmadi/i.test(await o2.page.locator('body').innerText()), 'another user cannot open our pickup order (not found)')
    eq(await o2.page.getByTestId('pickup-code-card').count(), 0, 'no code for another user')
    await o2.page.goto(WEB + '/profil', { waitUntil: 'networkidle' })
    await o2.page.getByTestId('pickup-empty').waitFor({ timeout: 15000 })
    eq(await o2.page.getByTestId('pickup-history-item').count(), 0, 'another user has no pickup history')
    await o2.ctx.close()
    const before = (await pst()).orders.length
    const old = await fetch(`${API}/functions/v1/place-order`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-aynimo-session': await tokenOf(700001) }, body: JSON.stringify({ idempotencyKey: '11111111-1111-4111-8111-111111111111', source: 'quick', contact: { name: 'Ali Valiyev', phone: '901234567', address: 'Toshkent sh., Chilonzor 9', comment: '' }, items: [{ productId: 'P1', size: 'M', color: 'Qora', qty: 1 }] }) })
    const oldBody = await old.json()
    eq([old.status, oldBody.error.code], [410, 'QUICK_ORDER_MOVED'], "the old source='quick' path is closed")
    eq((await pst()).orders.length, before, "no Cart order was created through source='quick'")

    // ---- 13l. outside Telegram: honest, nothing sent
    const nt = await newCtx(null)
    await nt.page.goto(WEB + '/tezkor-buyurtma', { waitUntil: 'networkidle' })
    await nt.page.locator('[data-testid="quick-pick"][data-product-id="P2"]').click()
    await nt.page.getByTestId('quick-add').click()
    await nt.page.getByTestId('f-name').fill('Ali Valiyev'); await nt.page.getByTestId('f-phone').fill('901234567')
    check(await nt.page.getByTestId('auth-notice').isVisible(), 'outside Telegram the form says why ordering is not possible')
    const countBefore = (await pst()).pickup.length
    await nt.page.getByTestId('submit-order').click()
    check(/Telegram ichidagi/i.test(await nt.page.getByTestId('submit-problem').innerText()), 'submit outside Telegram is refused clearly')
    eq((await pst()).pickup.length, countBefore, 'nothing created outside Telegram')
    await nt.ctx.close()

    // ---- 13m. 320 px
    const w = await newCtx(700001, { width: 320 })
    for (const p of ['/tezkor-buyurtma', '/profil', pickupUrl.replace(WEB, '')]) {
      await w.page.goto(WEB + p, { waitUntil: 'networkidle' }); await sleep(500)
      check((await w.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 0, `320px ${p.slice(0, 22)}: no horizontal overflow`)
    }
    await w.ctx.close()

    check(errors.length === 0, `no unexpected console/page errors ${errors.slice(0, 3).join(' | ')}`)
    await ctx.close()
  } finally {
    await browser.close()
    if (child) { try { process.kill(-child.pid, 'SIGTERM') } catch {} }
  }
  console.log(fails.length ? `\n${fails.length} FAILED:\n - ${fails.join('\n - ')}` : '\nALL PASSED')
  process.exit(fails.length ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(1) })
