/* Phase 4: Quick Order form, cart (change/remove/totals), checkout, honest "not sent" confirmation,
   duplicate-submit protection, persistence across reloads, nav on every screen, 320-430 px layouts.
   Delivery pricing when configured is covered by phase4-delivery.cjs (needs a second build). */
const { chromium } = require('playwright-core')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const BASE = (process.env.AYN_BASE || 'http://127.0.0.1:4173').replace(/\/$/, '')
const SHOTS = path.join(__dirname, 'shots')
const fails = []
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) fails.push(msg) }
const eq = (a, b, msg) => check(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)}${JSON.stringify(a) === JSON.stringify(b) ? '' : `, want ${JSON.stringify(b)}`})`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const digits = (s) => Number(String(s).replace(/[^\d]/g, ''))

async function waitFor(url, ms = 15000) {
  const end = Date.now() + ms
  while (Date.now() < end) { try { if ((await fetch(url)).ok) return } catch {} await sleep(250) }
  throw new Error('server did not start')
}

;(async () => {
  fs.mkdirSync(SHOTS, { recursive: true })
  const server = process.env.AYN_BASE ? null : spawn('npx', ['vite', 'preview', '--host', '127.0.0.1', '--port', '4173', '--strictPort'], { stdio: 'ignore', detached: true })
  try {
    await waitFor(BASE + '/')
    const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] })
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
    const page = await ctx.newPage()
    const errors = [], bad = []
    page.on('pageerror', (e) => errors.push(String(e)))
    page.on('console', (m) => m.type() === 'error' && !/telegram\.org|ERR_|Failed to load resource/.test(m.text()) && errors.push(m.text()))
    page.on('response', (r) => { if (r.status() >= 400 && r.url().startsWith(BASE)) bad.push(`${r.status()} ${r.url()}`) })
    await page.route('**/telegram.org/**', (r) => r.abort())
    const shot = async (name) => { await sleep(500); await page.screenshot({ path: path.join(SHOTS, `p4-${name}.png`) }) }

    const go = async (p) => { await page.goto(BASE + p, { waitUntil: 'networkidle' }); await sleep(250) }
    const orders = () => page.evaluate(() => JSON.parse(localStorage.getItem('aynimo:orders') || '[]'))
    const cart = () => page.evaluate(() => JSON.parse(localStorage.getItem('aynimo:cart') || '[]'))
    const nav = page.getByRole('navigation', { name: 'Asosiy navigatsiya' })
    const NAV = ['Asosiy', 'Katalog', 'Tezkor buyurtma', 'Savatcha', 'Profil']
    const navLabels = () => nav.locator('a').evaluateAll((a) => a.map((x) => x.getAttribute('aria-label')))
    const err = (field) => page.locator(`[data-testid$="-${field}-error"]`)
    const fillContact = async ({ name = 'Ali Valiyev', phone = '901234567', address = "Toshkent sh., Chilonzor 9, 12-uy", comment = '' } = {}) => {
      await page.getByTestId('f-name').fill(name)
      await page.getByTestId('f-phone').fill(phone)
      await page.getByTestId('f-address').fill(address)
      if (comment) await page.getByTestId('f-comment').fill(comment)
    }
    const addToCart = async (id, size, plus = 0, color) => {
      await go(`/mahsulot/${id}`)
      if (color) await page.getByRole('button', { name: color, exact: true }).click()
      await page.getByRole('radio', { name: size, exact: true }).click()
      for (let i = 0; i < plus; i++) await page.getByRole('button', { name: 'Miqdorni oshirish' }).click()
      await page.getByTestId('add-to-cart').click()
      await page.getByTestId('toast').waitFor()
    }
    const wipe = async () => { await go('/'); await page.evaluate(() => { localStorage.clear(); sessionStorage.clear() }) }

    // ================================================== NAV ON EVERY SCREEN
    await wipe()
    await addToCart('s-tee-1', 'M')
    await wipe()
    for (const route of ['/', '/katalog', '/mahsulot/s-hoodie-1', '/komplekt/o-classic', '/tezkor-buyurtma', '/savatcha', '/savatcha/buyurtma', '/profil', '/buyurtma/none', '/nope']) {
      await go(route)
      eq(await navLabels(), NAV, `five-item tab bar on ${route}`)
      const vis = await page.evaluate(() => { const r = document.querySelector('nav[aria-label="Asosiy navigatsiya"] ul').getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight + 1 })
      check(vis, `tab bar fully inside the viewport on ${route}`)
    }
    check(!/sevimli|favorit|wishlist|istaklar/i.test(await page.locator('body').innerText()), 'no favorites/wishlist on last screen')

    // ================================================== QUICK ORDER: STRUCTURE + VALIDATION
    await go('/')
    await nav.getByRole('link', { name: 'Tezkor buyurtma', exact: true }).click()
    await page.waitForURL(/\/tezkor-buyurtma$/)
    await page.getByTestId('quick-form').waitFor()
    check(await page.getByTestId('no-backend-notice').isVisible(), 'Quick Order states that the shop server is not connected')
    for (const id of ['f-name', 'f-phone', 'f-address', 'f-comment']) check(await page.getByTestId(id).isVisible(), `field ${id} present`)
    const pickIds = await page.getByTestId('quick-pick').evaluateAll((els) => els.map((e) => e.getAttribute('data-product-id')))
    eq(pickIds.length, 20, 'product picker lists the 20 in-stock products')
    check(!pickIds.includes('s-dress-2') && !pickIds.includes('s-coat-2'), 'out-of-stock products are not offered')
    eq(await page.getByTestId('quick-item').count(), 0, 'no product preselected when opened from the tab bar')
    await shot('01-quick-empty')

    await page.getByTestId('submit-order').click()
    check(await page.getByTestId('err-product').isVisible(), 'empty submit: product error shown')
    check(await err('name').isVisible() && await err('phone').isVisible() && await err('address').isVisible(), 'empty submit: name, phone and address errors shown')
    eq((await err('name').innerText()).trim(), 'Ismingizni kiriting', 'name error text (Uzbek)')
    eq((await orders()).length, 0, 'invalid submit saved nothing')
    eq(page.url().includes('/buyurtma/'), false, 'invalid submit did not navigate')
    await shot('02-quick-errors')

    await page.locator('[data-testid="quick-pick"][data-product-id="s-hoodie-1"]').click()
    check(await page.getByTestId('quick-item').isVisible(), 'picking a product shows its options')
    check(!(await page.getByTestId('err-product').count()), 'product error clears after picking')
    await page.getByTestId('submit-order').click()
    check(await page.getByTestId('err-size').isVisible(), 'submit without size: size error')
    eq((await orders()).length, 0, 'still nothing saved')
    await page.getByRole('radio', { name: 'M', exact: true }).click()
    check(!(await page.getByTestId('err-size').count()), 'size error clears after choosing a size')
    await page.getByRole('button', { name: 'Marjon', exact: true }).click()
    await page.getByRole('button', { name: 'Miqdorni oshirish' }).click()
    check((await page.getByTestId('cart-total').innerText()).includes('1 080 000'), 'quick total follows quantity (2 x 540 000)')

    // field-level validation + phone mask
    await page.getByTestId('f-name').fill('1234'); await page.getByTestId('f-name').blur()
    eq((await err('name').innerText()).trim(), "Ism harflardan iborat bo'lishi kerak", 'digits-only name rejected')
    await page.getByTestId('f-name').fill('Ali Valiyev')
    check((await err('name').count()) === 0, 'name error disappears once valid')
    await page.getByTestId('f-phone').fill('90123'); await page.getByTestId('f-phone').blur()
    check((await err('phone').innerText()).includes('+998 XX XXX XX XX'), 'incomplete phone rejected')
    await page.getByTestId('f-phone').fill('901234567')
    eq(await page.getByTestId('f-phone').inputValue(), '+998 90 123 45 67', 'phone is masked as +998 XX XXX XX XX')
    check((await err('phone').count()) === 0, 'phone error disappears once valid')
    await page.getByTestId('f-address').fill('kichik'); await page.getByTestId('f-address').blur()
    check((await err('address').count()) === 1, 'too-short address rejected')
    await page.getByTestId('f-address').fill('x'.repeat(250))
    eq((await page.getByTestId('f-address').inputValue()).length <= 260, true, 'address length is capped in the input')
    await page.getByTestId('f-comment').fill('y'.repeat(320)); await page.getByTestId('f-comment').blur()
    check((await err('comment').count()) === 1, 'comment over 300 characters rejected')
    await page.getByTestId('f-comment').fill('Iltimos, qo\'ng\'iroq qiling')
    await page.getByTestId('f-address').fill('Toshkent sh., Chilonzor 9, 12-uy')

    // typed text and selection survive a refresh
    await page.reload({ waitUntil: 'networkidle' })
    eq(await page.getByTestId('f-name').inputValue(), 'Ali Valiyev', 'typed name survives refresh')
    eq(await page.getByTestId('f-phone').inputValue(), '+998 90 123 45 67', 'typed phone survives refresh')
    check((await page.getByTestId('f-address').inputValue()).startsWith('Toshkent'), 'typed address survives refresh')
    check(await page.getByTestId('quick-item').isVisible(), 'product selection survives refresh')
    check((await page.getByRole('radio', { name: 'M', exact: true }).getAttribute('aria-checked')) === 'true', 'chosen size survives refresh')
    await shot('03-quick-filled')

    // ================================================== QUICK ORDER: SUBMIT (double tap)
    await page.getByTestId('submit-order').scrollIntoViewIfNeeded()
    await page.evaluate(() => { const b = document.querySelector('[data-testid="submit-order"]'); b.click(); b.click(); b.click() }) // three taps in the same frame
    await page.waitForURL(/\/buyurtma\/.+/)
    await page.getByTestId('not-sent').waitFor()
    const after1 = await orders()
    eq(after1.length, 1, 'triple tap created exactly ONE order')
    const o1 = after1[0]
    eq(o1.sync, 'local_only', 'stored order is flagged local_only (not on a server)')
    eq([o1.source, o1.items.length, o1.items[0].qty, o1.items[0].size, o1.items[0].color], ['quick', 1, 2, 'M', 'Marjon'], 'order holds the chosen variant')
    eq(o1.contact.phone, '+998901234567', 'phone stored normalised')
    eq(o1.total, 1080000, 'order total = 2 x 540 000')
    check(/^LOC-\d{6}-[2-9A-Z]{4}$/.test(o1.ref), `local reference format (${o1.ref})`)

    // confirmation is honest
    const body = await page.locator('body').innerText()
    check(/YUBORILMADI/.test(body), 'confirmation says the order was NOT sent to the shop')
    check(await page.getByTestId('draft-badge').first().isVisible(), '"Yuborilmagan" badge visible')
    check(!/qabul qilindi|tasdiqlandi|muvaffaqiyatli|rahmat|yuborildi|buyurtmangiz qabul/i.test(body), 'confirmation never claims success/receipt')
    check(/AYNIMO buyurtma raqami emas/.test(body), 'reference is explained as NOT an official order number')
    eq((await page.getByTestId('order-ref').innerText()).trim(), o1.ref, 'reference shown')
    check(/Yumshoq xudi/.test(body) && /Marjon/.test(body) && /Ali Valiyev/.test(body) && /\+998 ?901234567|\+998901234567/.test(body), 'confirmation lists product, variant and customer')
    check((await page.getByTestId('order-total').innerText()).includes('1 080 000'), 'confirmation total')
    check((await page.getByTestId('order-totals').innerText()).includes('Hali belgilanmagan'), 'delivery fee shown as "not set yet" (not invented)')
    eq(await navLabels(), NAV, 'tab bar visible on the confirmation')
    await shot('04-confirmation')

    // after success: nothing left behind, no way back into the submitted form
    eq(await page.evaluate(() => sessionStorage.getItem('aynimo:quick')), null, 'quick selection cleared after saving')
    eq(await page.evaluate(() => sessionStorage.getItem('aynimo:draft:quick')), null, 'typed form data cleared after saving')
    eq(await page.evaluate(() => sessionStorage.getItem('aynimo:attempt:quick')), null, 'attempt key cleared after saving')
    eq((await cart()).length, 0, 'Quick Order never touched the cart')
    await page.goBack({ waitUntil: 'networkidle' })
    check(!page.url().includes('/tezkor-buyurtma') && !page.url().includes('/buyurtma/'), `Back skips the submitted form (now ${new URL(page.url()).pathname})`)
    await go('/tezkor-buyurtma')
    eq(await page.getByTestId('f-name').inputValue(), '', 'form is empty again')
    eq(await page.getByTestId('quick-item').count(), 0, 'no product preselected again')

    // persistence of the saved draft
    await go(`/buyurtma/${o1.id}`)
    eq((await page.getByTestId('order-ref').innerText()).trim(), o1.ref, 'saved order survives a reload/new visit')
    await go('/profil')
    eq(await page.getByTestId('profile-order').count(), 1, 'profile lists the saved draft')
    check(/yuborilmagan/i.test(await page.getByTestId('profile-order').innerText()), 'profile marks it as not sent') // badge is CSS-uppercased
    await shot('05-profile-with-draft')
    await page.getByTestId('profile-order').click()
    await page.waitForURL(/\/buyurtma\//)

    // ================================================== IDEMPOTENCY (same attempt key, even with edited data)
    await go('/tezkor-buyurtma')
    await page.locator('[data-testid="quick-pick"][data-product-id="s-tee-1"]').click()
    await page.getByRole('radio', { name: 'L', exact: true }).click()
    await fillContact({ name: 'Vali Aliyev', phone: '+998 93 555 44 33', address: 'Samarqand sh., Registon 5' })
    await page.evaluate(() => sessionStorage.setItem('aynimo:attempt:quick', 'fixed-attempt'))
    await page.getByTestId('submit-order').click()
    await page.waitForURL(/\/buyurtma\/fixed-attempt$/)
    eq((await orders()).length, 2, 'second order saved')
    await go('/tezkor-buyurtma')
    await page.locator('[data-testid="quick-pick"][data-product-id="s-hoodie-2"]').click()
    await page.getByRole('radio', { name: 'S', exact: true }).click()
    await fillContact({ name: 'Boshqa Odam', phone: '+998 97 111 22 33', address: 'Buxoro sh., Navoiy 1-uy' })
    await page.evaluate(() => sessionStorage.setItem('aynimo:attempt:quick', 'fixed-attempt')) // simulates a retry of the same attempt
    await page.getByTestId('submit-order').click()
    await page.waitForURL(/\/buyurtma\/fixed-attempt$/)
    const dupe = await orders()
    eq(dupe.length, 2, 'a retry with the same attempt key did NOT create a third order')
    eq(dupe.find((o) => o.id === 'fixed-attempt').contact.name, 'Vali Aliyev', 'the first saved order was kept unchanged')

    // stock limit in the picker
    await go('/tezkor-buyurtma')
    await page.locator('[data-testid="quick-pick"][data-product-id="s-bag-2"]').click()
    await page.getByRole('button', { name: 'Miqdorni oshirish' }).click() // 1 -> 2 (= stock)
    check(await page.getByRole('button', { name: 'Miqdorni oshirish' }).isDisabled(), 'quantity cannot exceed stock (bag: 2)')

    // delete a draft (with confirmation)
    await go(`/buyurtma/fixed-attempt`)
    await page.getByTestId('delete-draft').click()
    await page.getByRole('button', { name: 'Bekor qilish' }).click()
    eq((await orders()).length, 2, 'cancel keeps the draft')
    await page.getByTestId('delete-draft').click()
    await page.getByTestId('delete-confirm').click()
    await page.waitForURL(/\/profil$/)
    eq((await orders()).length, 1, 'confirmed delete removes only that draft')
    await go('/buyurtma/fixed-attempt')
    check(await page.getByRole('heading', { name: 'Qoralama topilmadi' }).isVisible(), 'deleted draft shows a not-found state')

    // ================================================== CART: change / remove / totals
    // Clear only the cart + drafts in progress; the two saved orders from the sections above must stay (checkout expects them).
    await go('/'); await page.evaluate(() => { localStorage.removeItem('aynimo:cart'); sessionStorage.clear() })
    await addToCart('s-tee-1', 'M', 1)          // tee M x2 (Marjon)
    await addToCart('s-hoodie-1', 'L')          // hoodie L x1
    await go('/savatcha')
    eq(await page.getByTestId('cart-line').count(), 2, 'cart has 2 lines')
    eq(digits(await page.getByTestId('cart-subtotal').innerText()), 2 * 190000 + 540000, 'subtotal = 2 x 190 000 + 540 000')
    eq((await page.getByTestId('delivery-fee').innerText()).trim(), 'Hali belgilanmagan', 'delivery fee shows "not set yet" while unconfigured')
    eq(digits(await page.getByTestId('cart-total').innerText()), 920000, 'total (without delivery) = subtotal')
    check(/yetkazib berishsiz/i.test(await page.getByTestId('totals').innerText()), 'total is labelled "without delivery"')
    eq(digits(await page.getByTestId('panel-total').innerText()), 920000, 'sticky panel total matches')
    await shot('06-cart')
    // quantity
    const teeLine = page.getByTestId('cart-line').filter({ hasText: 'Oddiy futbolka' })
    await teeLine.getByRole('button', { name: 'Miqdorni oshirish' }).click()
    eq(digits(await page.getByTestId('cart-total').innerText()), 3 * 190000 + 540000, 'quantity + updates the total')
    await teeLine.getByRole('button', { name: 'Miqdorni kamaytirish' }).click()
    eq(digits(await page.getByTestId('cart-total').innerText()), 920000, 'quantity - restores the total')
    // change variant
    await addToCart('s-tee-1', 'S')            // tee S x1 -> 3 lines
    await go('/savatcha')
    eq(await page.getByTestId('cart-line').count(), 3, 'a different size is its own line')
    const sLine = page.getByTestId('cart-line').filter({ hasText: "O'lcham S" })
    await sLine.getByTestId('change-variant').click()
    await page.getByRole('dialog').waitFor()
    await shot('07-cart-change-variant')
    await page.getByRole('dialog').getByRole('radio', { name: 'M', exact: true }).click()
    await page.getByTestId('apply-variant').click()
    await page.getByRole('dialog').waitFor({ state: 'detached' })
    eq(await page.getByTestId('cart-line').count(), 2, 'changing S -> M merged into the existing M line')
    check((await page.getByTestId('cart-line').filter({ hasText: 'Oddiy futbolka' }).getByTestId('line-total').innerText()).includes('570 000'), 'merged line = 3 x 190 000')
    eq(digits(await page.getByTestId('cart-total').innerText()), 3 * 190000 + 540000, 'total unchanged by variant merge')
    await page.getByTestId('cart-line').filter({ hasText: 'Oddiy futbolka' }).getByTestId('change-variant').click()
    await page.getByRole('dialog').getByRole('radio', { name: 'L', exact: true }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Oq', exact: true }).click()
    await page.getByTestId('apply-variant').click()
    await page.getByRole('dialog').waitFor({ state: 'detached' })
    check((await page.getByTestId('line-variant').first().innerText()).length > 0 && (await page.getByTestId('cart-line').filter({ hasText: 'Oddiy futbolka' }).getByTestId('line-variant').innerText()).includes("Oq · O'lcham L"), 'variant changed to Oq / L')
    eq((await cart()).find((l) => l.productId === 's-tee-1').qty, 3, 'quantity kept after changing variant')
    // remove
    await page.getByTestId('cart-line').filter({ hasText: 'Yumshoq xudi' }).getByTestId('remove-line').click()
    eq(await page.getByTestId('cart-line').count(), 1, 'remove deletes the line')
    eq(digits(await page.getByTestId('cart-total').innerText()), 3 * 190000, 'total updates after removing')
    await page.reload({ waitUntil: 'networkidle' })
    eq(await page.getByTestId('cart-line').count(), 1, 'cart survives refresh')
    await page.getByTestId('cart-line').getByTestId('remove-line').click()
    check(await page.getByRole('heading', { name: "Savatchangiz bo'sh" }).isVisible(), 'empty cart state')
    eq(await page.getByTestId('checkout').count(), 0, 'no checkout button for an empty cart')
    await go('/savatcha/buyurtma')
    check(await page.getByRole('heading', { name: "Savatchangiz bo'sh" }).isVisible(), 'checkout with an empty cart shows the empty state (cannot submit)')

    // ================================================== CHECKOUT
    await addToCart('s-tee-1', 'L', 1)         // tee L x2 (Marjon)
    await addToCart('s-hoodie-1', 'L')         // hoodie L x1
    await go('/savatcha')
    await page.getByTestId('checkout').click()
    await page.waitForURL(/\/savatcha\/buyurtma$/)
    await page.getByTestId('checkout-line').first().waitFor() // page transition (exit animation) finishes after the URL changes
    eq(await page.getByTestId('checkout-line').count(), 2, 'checkout lists both lines')
    check(await page.getByTestId('no-backend-notice').isVisible(), 'checkout states that nothing is sent to the shop')
    eq(digits(await page.getByTestId('cart-total').innerText()), 920000, 'checkout total')
    check((await page.locator('nav[aria-label="Asosiy navigatsiya"] a[aria-current="page"]').getAttribute('aria-label')) === 'Savatcha', 'Savatcha stays highlighted during checkout')
    await page.getByTestId('submit-order').click()
    eq([await err('name').count(), await err('phone').count(), await err('address').count()], [1, 1, 1], 'checkout: empty submit shows 3 errors')
    eq((await orders()).length, 1, 'checkout: invalid submit saved nothing')
    check(await page.evaluate(() => document.activeElement && document.activeElement.getAttribute('aria-invalid') === 'true'), 'focus moves to the first invalid field')
    await shot('08-checkout-errors')
    await page.getByTestId('f-name').fill('Nodira Karimova')
    await page.getByTestId('f-address').fill("Andijon sh., Bobur ko'chasi 7")
    await page.reload({ waitUntil: 'networkidle' })
    eq(await page.getByTestId('f-name').inputValue(), 'Nodira Karimova', 'checkout draft text survives refresh')
    eq(await page.getByTestId('checkout-line').count(), 2, 'cart still intact after refresh')
    await page.getByTestId('f-phone').fill('+998 99 876 54 32')
    await page.getByTestId('f-comment').fill('Ertalab yetkazing')
    await shot('09-checkout-filled')
    await page.evaluate(() => { const b = document.querySelector('[data-testid="submit-order"]'); b.click(); b.click() })
    await page.waitForURL(/\/buyurtma\/.+/)
    await page.getByTestId('not-sent').waitFor()
    const after2 = await orders()
    eq(after2.length, 2, 'checkout double tap created exactly ONE more order')
    const o2 = after2.find((o) => o.source === 'cart')
    eq([o2.items.length, o2.subtotal, o2.total, o2.sync, o2.contact.comment], [2, 920000, 920000, 'local_only', 'Ertalab yetkazing'], 'cart order stored with both lines and total')
    check((await page.getByTestId('order-item').count()) === 2 && /YUBORILMADI/.test(await page.locator('body').innerText()), 'cart confirmation lists both lines and says NOT sent')
    check(/Savatchadan/.test(await page.locator('body').innerText()), 'confirmation shows the source (cart)')
    eq((await cart()).length, 0, 'cart emptied after saving')
    check((await nav.getByTestId('nav-cart-badge').count()) === 0, 'cart badge cleared')
    await shot('10-confirmation-cart')
    await go('/savatcha/buyurtma')
    check(await page.getByRole('heading', { name: "Savatchangiz bo'sh" }).isVisible(), 'returning to checkout cannot resubmit (cart is empty)')
    eq((await orders()).length, 2, 'still two orders')
    await go('/profil')
    eq(await page.getByTestId('profile-order').count(), 2, 'profile lists both drafts')

    // ================================================== TELEGRAM IDENTITY (mock) + BackButton
    const tg = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
    await tg.addInitScript(() => {
      window.__bb = []
      window.Telegram = { WebApp: {
        initData: 'query_id=x', initDataUnsafe: { user: { id: 424242, first_name: 'Test', last_name: 'User', username: 'testuser' } }, platform: 'ios', colorScheme: 'light', viewportStableHeight: 800,
        ready() {}, expand() {}, setHeaderColor() {}, setBackgroundColor() {}, isVersionAtLeast() { return true }, onEvent() {}, disableVerticalSwipes() {},
        HapticFeedback: { selectionChanged() {} },
        BackButton: { show() { window.__bb.push('show') }, hide() { window.__bb.push('hide') }, onClick() {}, offClick() {} },
      } }
    })
    const tp = await tg.newPage()
    await tp.route('**/telegram.org/**', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: '' }))
    await tp.goto(BASE + '/tezkor-buyurtma', { waitUntil: 'networkidle' })
    eq(await tp.getByTestId('f-name').inputValue(), 'Test User', 'name prefilled from the Telegram profile')
    check(await tp.getByText('Telegram profilingizdan olindi').isVisible(), 'prefill is explained and editable')
    eq((await tp.evaluate(() => window.__bb)).slice(-1)[0], 'hide', 'BackButton hidden on a main tab')
    await tp.goto(BASE + '/savatcha/buyurtma', { waitUntil: 'networkidle' })
    eq((await tp.evaluate(() => window.__bb)).slice(-1)[0], 'show', 'BackButton shown on the inner checkout screen')
    await tp.goto(BASE + '/mahsulot/s-bag-1', { waitUntil: 'networkidle' })
    await tp.getByRole('radio', { name: 'Yagona' }).waitFor().catch(() => {})
    await tp.getByTestId('add-to-cart').click()
    await tp.goto(BASE + '/savatcha/buyurtma', { waitUntil: 'networkidle' })
    await tp.getByTestId('f-phone').fill('900001122')
    await tp.getByTestId('f-address').fill('Toshkent sh., Mirzo Ulugbek 3')
    await tp.getByTestId('submit-order').click()
    await tp.waitForURL(/\/buyurtma\//)
    const tgOrders = await tp.evaluate(() => JSON.parse(localStorage.getItem('aynimo:orders') || '[]'))
    eq(tgOrders[0] && tgOrders[0].telegramUserId, 424242, 'unverified Telegram id kept with the draft (backend will verify later)')
    await tg.close()

    // ================================================== MOBILE LAYOUTS 320-430
    await wipe()
    await page.evaluate(() => {
      const line = (productId, size, color, qty) => ({ productId, size, color, qty })
      localStorage.setItem('aynimo:cart', JSON.stringify([line('s-hoodie-1', 'M', 'Marjon', 2), line('s-jacket-1', 'L', 'Qora', 1), line('s-sneaker-1', '42', 'Oq', 1)]))
      sessionStorage.setItem('aynimo:quick', JSON.stringify({ productId: 's-jacket-1', size: 'L', color: 'Qora', qty: 2 }))
      const base = { source: 'cart', contact: { name: 'Ali Valiyev', phone: '+998901234567', address: "Toshkent shahri, Yunusobod tumani, Amir Temur ko'chasi 108-uy, 45-xonadon", comment: "Iltimos, yetkazishdan oldin qo'ng'iroq qiling" }, items: [{ productId: 's-hoodie-1', name: 'Yumshoq xudi', brandId: 'aynimo', categoryId: 'hoodies', size: 'M', color: 'Marjon', colorHex: '#D94B59', qty: 2, unitPrice: 540000 }], subtotal: 1080000, deliveryFee: null, deliveryPending: true, total: 1080000, sync: 'local_only' }
      localStorage.setItem('aynimo:orders', JSON.stringify([{ ...base, id: 'layout-order', ref: 'LOC-261105-ABCD', createdAt: '2026-11-05T09:00:00.000Z' }]))
    })
    for (const [w, h] of [[320, 568], [360, 740], [390, 844], [430, 932]]) {
      await page.setViewportSize({ width: w, height: h })
      for (const route of ['/tezkor-buyurtma', '/savatcha', '/savatcha/buyurtma', '/buyurtma/layout-order', '/profil', '/mahsulot/s-hoodie-1']) {
        await go(route)
        const r = await page.evaluate(() => {
          const over = document.documentElement.scrollWidth - document.documentElement.clientWidth
          const navUl = document.querySelector('nav[aria-label="Asosiy navigatsiya"] ul').getBoundingClientRect()
          const panel = document.querySelector('[data-testid="dock-panel"]')
          const pr = panel && panel.children.length ? panel.getBoundingClientRect() : null
          const fields = [...document.querySelectorAll('input, textarea')]
          const tooSmall = fields.filter((f) => parseFloat(getComputedStyle(f).fontSize) < 16).length // < 16px makes iOS zoom the page
          const outside = fields.filter((f) => { const b = f.getBoundingClientRect(); return b.left < 0 || b.right > innerWidth + 0.5 }).length
          return { over, navOk: navUl.top >= 0 && navUl.bottom <= innerHeight + 1 && navUl.left >= 0 && navUl.right <= innerWidth, panelOk: !pr || (pr.bottom <= navUl.top + 0.5 && pr.left >= 0 && pr.right <= innerWidth), tooSmall, outside }
        })
        check(r.over <= 0 && r.navOk && r.panelOk && r.tooSmall === 0 && r.outside === 0, `${w}px ${route}: no overflow, tab bar + panel in view and stacked, inputs >=16px and inside the screen`)
        // the last control must be reachable above the tab bar
        const last = route === '/tezkor-buyurtma' || route === '/savatcha/buyurtma' ? '[data-testid="submit-order"]' : route === '/savatcha' ? '[data-testid="checkout"]' : route.startsWith('/buyurtma/') ? '[data-testid="delete-draft"]' : null
        if (last) {
          await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)); await sleep(200)
          const ok = await page.evaluate((sel) => {
            const el = document.querySelector(sel); const b = el.getBoundingClientRect()
            const navUl = document.querySelector('nav[aria-label="Asosiy navigatsiya"] ul').getBoundingClientRect()
            const panel = document.querySelector('[data-testid="dock-panel"]'); const pr = panel && panel.children.length ? panel.getBoundingClientRect() : null
            const limit = pr ? pr.top : navUl.top
            return sel.includes('checkout') ? b.bottom <= navUl.top + 0.5 && b.top >= 0 : b.bottom <= limit + 0.5 && b.top >= 0
          }, last)
          check(ok, `${w}px ${route}: last control (${last.match(/"(.+)"/)[1]}) is reachable and not hidden by the bottom bars`)
        }
      }
    }
    await page.setViewportSize({ width: 320, height: 568 })
    await go('/tezkor-buyurtma'); await shot('11-quick-320')
    await go('/savatcha'); await shot('12-cart-320')
    await go('/savatcha/buyurtma'); await shot('13-checkout-320')
    await go('/buyurtma/layout-order'); await shot('14-confirmation-320')
    await page.setViewportSize({ width: 390, height: 844 })
    await go('/mahsulot/s-hoodie-1'); await shot('15-product-with-nav')

    // ================================================== NO FAVORITES ANYWHERE
    for (const route of ['/', '/katalog', '/mahsulot/s-tee-1', '/savatcha', '/savatcha/buyurtma', '/tezkor-buyurtma', '/buyurtma/layout-order', '/profil']) {
      await go(route)
      check(!/sevimli|favorit|wishlist|istaklar/i.test(await page.locator('body').innerText()), `no favorites/wishlist on ${route}`)
    }

    check(errors.length === 0, `no console/page errors ${errors.slice(0, 3).join(' || ')}`)
    check(bad.length === 0, `no failed local requests ${bad.slice(0, 3).join(' || ')}`)
    await browser.close()
  } finally { if (server) try { process.kill(-server.pid) } catch {} }
  console.log(fails.length ? `\n${fails.length} FAILED` : '\nALL PASSED')
  process.exit(fails.length ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(1) })
