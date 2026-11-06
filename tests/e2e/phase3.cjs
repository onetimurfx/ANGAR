/* Phase 3: filters, sorting, product gallery/selection, cart and Quick Order hand-off.
   Expected counts below come from src/data/sample.ts (verified by tests/unit/filters.test.ts). */
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
    const shot = async (name) => { await sleep(450); await page.screenshot({ path: path.join(SHOTS, `p3-${name}.png`) }) }

    // ---------- helpers
    const cards = () => page.locator('main [data-testid="product-card"]')
    const count = async () => digits((await page.getByTestId('result-count').innerText()).split(' ')[0])
    const ids = async () => cards().evaluateAll((els) => els.map((e) => e.getAttribute('data-product-id')))
    const prices = async () => cards().evaluateAll((els) => els.map((e) => Number(e.querySelector('span.whitespace-nowrap.font-extrabold').textContent.replace(/[^\d]/g, ''))))
    const sheet = () => page.getByRole('dialog', { name: 'Filtrlar' })
    const group = (name) => sheet().locator('fieldset').filter({ has: page.getByText(name, { exact: true }) })
    const openFilter = async () => { await page.getByRole('button', { name: /^Filtr/ }).click(); await sheet().waitFor({ timeout: 3000 }); await sleep(450) }
    const applyBtn = () => sheet().getByRole('button', { name: /Natijalarni ko'rsatish/ })
    const applyCount = async () => digits((await applyBtn().innerText()).match(/\((\d+)\)/)[1])
    const apply = async () => { await applyBtn().click(); await sheet().waitFor({ state: 'detached', timeout: 3000 }); await sleep(150) }
    const waitCount = async (n, msg) => {
      const ok = await page.waitForFunction((n) => { const el = document.querySelector('[data-testid="result-count"]'); return el && parseInt(el.textContent) === n }, n, { timeout: 3000 }).then(() => true, () => false)
      check(ok, msg)
    }
    const cart = () => page.evaluate(() => JSON.parse(localStorage.getItem('aynimo:cart') || '[]'))
    const toastText = () => page.getByTestId('toast').last().innerText({ timeout: 2500 }).catch(() => '')
    const go = async (p) => { await page.goto(BASE + p, { waitUntil: 'networkidle' }) }

    // ======================================================= FILTERS
    await go('/katalog')
    await waitCount(22, 'catalog starts with all 22 sample products')
    eq(await cards().count(), 22, 'grid shows 22 cards')
    await shot('01-catalog')

    await openFilter()
    check(await sheet().isVisible(), 'filter sheet opens')
    eq(await applyCount(), 22, 'live result count starts at 22')
    await shot('02-filter-sheet-top')

    // brand
    await group('Brend').getByRole('button', { name: 'AYNIMO Original', exact: true }).click()
    eq(await applyCount(), 11, 'brand AYNIMO Original: live count 11')
    await apply()
    await waitCount(11, 'brand filter applied: 11 results')
    check((await page.evaluate(() => location.search)).includes('brand=aynimo'), 'brand stored in URL')
    const brandTexts = await cards().evaluateAll((els) => els.map((e) => e.textContent.toLowerCase()))
    check(brandTexts.every((t) => t.includes('aynimo original')), 'every shown card is AYNIMO Original')
    eq(await page.getByTestId('filter-badge').innerText(), '1', 'filter badge shows 1 active group')
    await shot('03-filtered-brand')
    await page.getByRole('button', { name: 'AYNIMO Original ×' }).click()
    await waitCount(22, 'removing the brand chip restores 22')
    check(await page.getByTestId('filter-badge').count() === 0, 'badge disappears with no filters')

    // multi brand
    await openFilter()
    await group('Brend').getByRole('button', { name: 'Namuna brend A' }).click()
    eq(await applyCount(), 6, 'brand A: 6')
    await group('Brend').getByRole('button', { name: 'Namuna brend B' }).click()
    eq(await applyCount(), 11, 'brands A+B: 11 (OR within a group)')
    await sheet().getByRole('button', { name: 'Tozalash' }).click()
    eq(await applyCount(), 22, 'sheet "Tozalash" resets the draft to 22')
    await page.keyboard.press('Escape')
    await sheet().waitFor({ state: 'detached', timeout: 3000 })
    await sleep(150)
    await waitCount(22, 'closing with Esc discards draft (still 22)')

    // size
    await openFilter()
    await group("O'lcham").getByRole('button', { name: 'XL', exact: true }).click()
    eq(await applyCount(), 16, 'size XL: 16')
    await group("O'lcham").getByRole('button', { name: 'XL', exact: true }).click()
    await group("O'lcham").getByRole('button', { name: '42', exact: true }).click()
    eq(await applyCount(), 2, 'size 42: 2 (shoes only)')
    await apply()
    await waitCount(2, 'size 42 applied')
    check((await ids()).every((i) => i.startsWith('s-sneaker')), 'size 42 results are shoes')
    await page.getByRole('button', { name: /42 ×/ }).click()
    await waitCount(22, 'size chip removed')

    // colour
    await openFilter()
    await group('Rang').getByRole('button', { name: 'Marjon' }).click()
    eq(await applyCount(), 5, 'colour Marjon: 5')
    await apply()
    await waitCount(5, 'colour applied')
    await shot('04-filtered-color')

    // colour + category -> empty state, then recover
    await page.getByRole('button', { name: 'Poyabzal', exact: true }).click()
    await waitCount(0, 'Marjon + shoes: no results')
    check(await page.getByRole('heading', { name: 'Hech narsa topilmadi' }).isVisible(), 'empty state shown')
    await shot('05-empty-state')
    await page.getByRole('button', { name: 'Hammasini tozalash' }).last().click()
    await waitCount(22, 'clear all from empty state restores 22')

    // price
    await openFilter()
    await sheet().locator('input[type=range]').nth(0).fill('400000')
    await sheet().locator('input[type=range]').nth(1).fill('700000')
    eq(await applyCount(), 10, 'price 400 000-700 000: 10')
    await apply()
    await waitCount(10, 'price applied')
    const pr = await prices()
    check(pr.length === 10 && pr.every((p) => p >= 400000 && p <= 700000), `all shown prices within range (${Math.min(...pr)}-${Math.max(...pr)})`)
    check((await page.getByText('400 000 so\'m - 700 000 so\'m').count()) === 1, 'price chip shown')
    // sliders cannot cross
    await openFilter()
    await sheet().locator('input[type=range]').nth(0).fill('900000')
    const [lo, hi] = await sheet().locator('input[type=range]').evaluateAll((els) => els.map((e) => Number(e.value)))
    check(lo <= hi, `min slider cannot pass max (${lo} <= ${hi})`)
    await page.keyboard.press('Escape')
    await sheet().waitFor({ state: 'detached' })
    await page.getByRole('button', { name: 'Hammasini tozalash' }).click()
    await waitCount(22, 'clear all resets price')

    // availability
    await openFilter()
    await group('Mavjudlik').getByRole('switch').click()
    eq(await applyCount(), 20, 'only in stock: 20')
    await apply()
    await waitCount(20, 'availability applied')
    eq(await page.locator('main').getByText('Tugagan', { exact: true }).count(), 0, 'no "Tugagan" cards when availability filter is on')
    await page.getByRole('button', { name: 'Faqat omborda borlari ×' }).click()
    await waitCount(22, 'availability chip removed')
    check((await page.locator('main').getByText('Tugagan', { exact: true }).count()) === 2, 'out-of-stock cards are marked when not filtered')

    // type tags
    await openFilter()
    await group('Turi').getByRole('button', { name: 'Chegirmada' }).click()
    eq(await applyCount(), 6, 'tag discount: 6')
    await group('Turi').getByRole('button', { name: 'Yangi' }).click()
    eq(await applyCount(), 7, 'tag new replaces discount: 7')
    await page.keyboard.press('Escape'); await sheet().waitFor({ state: 'detached' })

    // combined (category + brand + colour + availability)
    await openFilter()
    await sheet().getByRole('button', { name: 'Tozalash' }).click()
    await group('Kategoriya').getByRole('button', { name: 'Xudi', exact: true }).click()
    await group('Brend').getByRole('button', { name: 'AYNIMO Original' }).click()
    await group('Rang').getByRole('button', { name: 'Marjon' }).click()
    await group('Mavjudlik').getByRole('switch').click()
    eq(await applyCount(), 1, 'combined filters (AND across groups): 1')
    await apply()
    await waitCount(1, 'combined applied')
    eq(await ids(), ['s-hoodie-1'], 'combined result is s-hoodie-1')
    eq(await page.getByTestId('filter-badge').innerText(), '4', 'badge counts 4 groups')
    await shot('06-combined')

    // persistence: reload + back navigation keep the state
    await page.reload({ waitUntil: 'networkidle' })
    await waitCount(1, 'filters survive reload (URL state)')
    await cards().first().click()
    await page.waitForURL(/\/mahsulot\//)
    await page.getByRole('button', { name: 'Orqaga' }).click()
    await page.waitForURL(/\/katalog/)
    await waitCount(1, 'filters survive product -> back')
    await page.getByRole('button', { name: 'Hammasini tozalash' }).click()
    await waitCount(22, 'reset')

    // ======================================================= SORTING
    const sortBtn = () => page.getByRole('button', { name: /Mashhurligi|Yangilari|Arzonroq|Qimmatroq/ })
    const chooseSort = async (label) => {
      await sortBtn().click()
      const d = page.getByRole('dialog', { name: 'Saralash' })
      await d.waitFor({ timeout: 3000 }); await sleep(400)
      await d.getByRole('radio', { name: label }).click()
      await d.waitFor({ state: 'detached', timeout: 3000 })
      await sleep(150)
    }
    eq((await ids()).slice(0, 3), ['s-sneaker-1', 's-dress-1', 's-hoodie-1'], 'default sort = popularity')
    await sortBtn().click(); await sleep(500); await shot('07-sort-sheet')
    await page.keyboard.press('Escape'); await sleep(300)
    await chooseSort('Arzonroq avval')
    let p = await prices()
    check(p.every((v, i) => i === 0 || v >= p[i - 1]), `price ascending (${p[0]} ... ${p[p.length - 1]})`)
    eq((await ids()).slice(0, 3), ['s-tee-1', 's-tee-2', 's-acc-2'], 'cheapest first')
    await chooseSort('Qimmatroq avval')
    p = await prices()
    check(p.every((v, i) => i === 0 || v <= p[i - 1]), `price descending (${p[0]} ... ${p[p.length - 1]})`)
    eq((await ids()).slice(0, 2), ['s-coat-1', 's-coat-2'], 'most expensive first')
    await chooseSort('Yangilari avval')
    eq((await ids()).slice(0, 3), ['s-sneaker-1', 's-sneaker-2', 's-shirt-1'], 'newest first')
    check((await page.evaluate(() => location.search)).includes('sort=newest'), 'sort stored in URL')
    await chooseSort("Mashhurligi bo'yicha")
    eq((await ids()).slice(0, 3), ['s-sneaker-1', 's-dress-1', 's-hoodie-1'], 'popularity restored')
    // sort + filter together
    await go('/katalog?brand=aynimo&sort=price_desc')
    await waitCount(11, 'deep link with brand + sort')
    p = await prices()
    check(p.every((v, i) => i === 0 || v <= p[i - 1]), 'sorted desc inside filtered set')
    // legacy / hostile URLs
    await go('/katalog?cat=zzz&brand=nope&size=ZZ&sort=weird&min=abc')
    await waitCount(22, 'invalid URL params are ignored safely')
    await go('/katalog?f=popular')
    await waitCount(22, 'legacy ?f=popular link still works')

    // ======================================================= PRODUCT DETAILS
    await go('/mahsulot/s-hoodie-1')
    await page.getByRole('heading', { level: 1, name: 'Yumshoq xudi' }).waitFor()
    const scroller = page.getByTestId('gallery-scroller')
    eq(await scroller.locator('> button').count(), 4, 'gallery has 4 slides')
    eq((await page.getByTestId('gallery-counter').innerText()).trim(), '1/4', 'gallery counter starts at 1/4')
    await shot('08-product-top')
    await page.getByRole('tab', { name: '3/4' }).click()
    const settled = await page.waitForFunction(() => { const s = document.querySelector('[data-testid="gallery-scroller"]'); return Math.abs(s.scrollLeft - 2 * s.clientWidth) < 4 }, null, { timeout: 4000 }).then(() => true, () => false)
    check(settled, 'thumbnail 3 scrolls the gallery to slide 3')
    eq((await page.getByTestId('gallery-counter').innerText()).trim(), '3/4', 'counter follows thumbnail (3/4)')
    check((await page.getByRole('tab', { name: '3/4' }).getAttribute('aria-current')) === 'true', 'thumbnail 3 marked current')
    await scroller.evaluate((s) => { s.scrollTo({ left: 3 * s.clientWidth, behavior: 'instant' }) })
    await page.waitForFunction(() => document.querySelector('[data-testid="gallery-counter"]').textContent.trim() === '4/4', null, { timeout: 3000 }).catch(() => {})
    eq((await page.getByTestId('gallery-counter').innerText()).trim(), '4/4', 'swiping/scrolling to the end updates counter (4/4)')
    check((await page.getByRole('tab', { name: '4/4' }).getAttribute('aria-current')) === 'true', 'thumbnail follows swipe')

    // lightbox
    await scroller.locator('> button').nth(3).click()
    const lb = page.getByRole('dialog', { name: 'Yumshoq xudi' })
    await lb.waitFor({ timeout: 3000 })
    eq((await page.getByTestId('lightbox-counter').innerText()).trim(), '4/4', 'lightbox opens on the current image')
    await shot('09-lightbox')
    await lb.getByRole('button', { name: 'Keyingi rasm' }).click()
    eq((await page.getByTestId('lightbox-counter').innerText()).trim(), '1/4', 'next wraps around to 1/4')
    await page.keyboard.press('ArrowLeft')
    eq((await page.getByTestId('lightbox-counter').innerText()).trim(), '4/4', 'ArrowLeft goes back')
    await page.keyboard.press('Escape')
    await lb.waitFor({ state: 'detached', timeout: 3000 })
    check(true, 'lightbox closes with Esc')
    await scroller.locator('> button').first().click()
    await lb.waitFor()
    await lb.getByRole('button', { name: 'Yopish' }).click()
    await lb.waitFor({ state: 'detached', timeout: 3000 })
    check(true, 'lightbox closes with the X button')

    // colour changes the gallery artwork + label
    await page.getByRole('button', { name: 'Marjon', exact: true }).click()
    check((await page.locator('[data-testid="gallery-scroller"] svg path[fill="#D94B59"]').count()) > 0, 'selecting Marjon recolours the gallery')
    check((await page.getByRole('heading', { name: /Rang: Marjon/ }).count()) === 1, 'selected colour name shown')

    // validation: size required (both buttons)
    check(await page.getByTestId('action-bar').isVisible(), 'purchase bar visible on product screen')
    eq(await page.getByRole('navigation', { name: 'Asosiy navigatsiya' }).locator('a').evaluateAll((a) => a.map((x) => x.getAttribute('aria-label'))), ['Asosiy', 'Katalog', 'Tezkor buyurtma', 'Savatcha', 'Profil'], 'all five tab-bar items stay visible on the product screen')
    check(await page.evaluate(() => { const p = document.querySelector('[data-testid="action-bar"]').getBoundingClientRect(); const n = document.querySelector('nav[aria-label="Asosiy navigatsiya"] ul').getBoundingClientRect(); return p.bottom <= n.top + 0.5 && n.bottom <= innerHeight + 1 }), 'purchase panel sits above the tab bar without overlapping it')
    await page.getByTestId('add-to-cart').click()
    check(await page.getByRole('alert').filter({ hasText: "o'lchamni tanlang" }).isVisible(), 'Add to cart without size shows an error')
    eq((await cart()).length, 0, 'nothing added without a size')
    await sleep(300); await shot('10-size-error')
    await page.getByTestId('quick-order').click()
    check(page.url().includes('/mahsulot/'), 'Quick Order without size stays on the product')
    eq(await page.getByTestId('header-cart-badge').count(), 0, 'no cart badge yet')

    // quantity
    const plus = page.getByRole('button', { name: 'Miqdorni oshirish' })
    const minus = page.getByRole('button', { name: 'Miqdorni kamaytirish' })
    check(await minus.isDisabled(), 'minus disabled at quantity 1')
    await page.getByRole('radio', { name: 'M', exact: true }).click()
    check(await page.getByRole('alert').count() === 0, 'size error clears after choosing a size')
    await plus.click(); await plus.click()
    eq((await page.locator('output').first().innerText()).trim(), '3', 'quantity 3')
    eq((await page.getByTestId('total-price').innerText()).trim(), "1 620 000 so'm", 'total = 3 x 540 000')
    for (let i = 0; i < 15; i++) if (await plus.isEnabled()) await plus.click()
    eq((await page.locator('output').first().innerText()).trim(), '12', 'quantity capped at stock (12)')
    check(await plus.isDisabled(), 'plus disabled at stock')
    check(await page.getByText('Omborda atigi 12 dona bor').isVisible(), 'max-stock message shown')
    for (let i = 0; i < 10; i++) await minus.click()
    eq((await page.locator('output').first().innerText()).trim(), '2', 'quantity back to 2')
    eq((await page.getByTestId('stock-status').innerText()).trim(), 'Omborda: 12 dona', 'stock status shown')

    // add to cart
    await page.getByTestId('add-to-cart').click()
    check((await toastText()).includes("Savatchaga qo'shildi"), 'toast confirms add to cart')
    await shot('11-added-toast')
    eq((await page.getByTestId('header-cart-badge').innerText()).trim(), '2', 'header cart badge = 2')
    eq(await cart(), [{ productId: 's-hoodie-1', size: 'M', color: 'Marjon', qty: 2 }], 'cart persisted with chosen variant')
    eq((await page.locator('output').first().innerText()).trim(), '1', 'quantity resets to 1 after adding')
    await page.getByTestId('add-to-cart').click()
    eq((await cart()).length, 1, 'same variant merges into one line')
    eq((await cart())[0].qty, 3, 'merged quantity = 3')
    await page.getByRole('radio', { name: 'L', exact: true }).click()
    await page.getByTestId('add-to-cart').click()
    eq((await cart()).length, 2, 'different size = new line')
    eq((await page.getByTestId('header-cart-badge').innerText()).trim(), '4', 'badge = 4')

    // description / details present
    check(await page.getByRole('heading', { name: 'Tavsif' }).isVisible(), 'description section')
    check((await page.locator('dl dt').count()) === 5, 'details list has 5 facts')
    await page.evaluate(() => window.scrollTo(0, 700)); await shot('12-product-middle')
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)); await shot('13-product-bottom')

    // stock states
    await go('/mahsulot/s-dress-2')
    await page.getByRole('heading', { level: 1, name: 'Kechki libos' }).waitFor()
    check(await page.getByTestId('add-to-cart').isDisabled() && await page.getByTestId('quick-order').isDisabled(), 'out-of-stock: both buttons disabled')
    eq((await page.getByTestId('stock-status').innerText()).trim(), 'Tugagan', 'out-of-stock label')
    await go('/mahsulot/s-sweater-1')
    await page.getByRole('heading', { level: 1, name: 'Trikotaj sviter' }).waitFor()
    eq((await page.getByTestId('stock-status').innerText()).trim(), 'Oxirgi 3 dona qoldi', 'low-stock label')
    await page.getByRole('radio', { name: 'S', exact: true }).click()
    for (let i = 0; i < 5; i++) if (await page.getByRole('button', { name: 'Miqdorni oshirish' }).isEnabled()) await page.getByRole('button', { name: 'Miqdorni oshirish' }).click()
    eq((await page.locator('output').first().innerText()).trim(), '3', 'cannot select more than stock (3)')
    await page.getByTestId('add-to-cart').click()
    await sleep(200)
    const n1 = (await cart()).filter((l) => l.productId === 's-sweater-1').reduce((s, l) => s + l.qty, 0)
    eq(n1, 3, 'added full stock (3) of the low-stock item')
    await page.getByTestId('add-to-cart').click() // quantity is 1 again: this would be the 4th piece
    await sleep(200)
    eq((await cart()).filter((l) => l.productId === 's-sweater-1').reduce((s, l) => s + l.qty, 0), 3, 'cannot exceed stock via repeated adds')
    check((await toastText()).length > 0, 'warning toast shown when stock exceeded')

    // single-size product preselects its size
    await go('/mahsulot/s-bag-1')
    await page.getByRole('heading', { level: 1, name: 'Ayollar sumkasi' }).waitFor()
    check(await page.getByRole('radio', { name: 'Yagona' }).getAttribute('aria-checked') === 'true', 'one-size product has its size preselected')

    // ======================================================= CART PAGE
    await page.getByTestId('header-cart').click()
    await page.waitForURL(/\/savatcha/)
    await page.getByTestId('cart-line').first().waitFor()
    const lineCount = await page.getByTestId('cart-line').count()
    check(lineCount === 3, `cart page lists lines (${lineCount})`)
    const totals = await page.getByTestId('line-total').allInnerTexts()
    const sum = totals.map(digits).reduce((a, b) => a + b, 0)
    eq(digits(await page.getByTestId('cart-total').innerText()), sum, 'cart total equals the sum of line totals')
    eq((await page.getByTestId('nav-cart-badge').innerText()).trim(), '7', 'nav badge = total pieces (3 + 1 hoodies + 3 sweaters = 7)')
    await shot('14-cart')
    const firstLine = page.getByTestId('cart-line').first()
    const before = digits(await page.getByTestId('cart-total').innerText())
    await firstLine.getByRole('button', { name: /Miqdorni oshirish/ }).click()
    check(digits(await page.getByTestId('cart-total').innerText()) > before, 'increasing quantity raises the total')
    await firstLine.getByRole('button', { name: /Miqdorni kamaytirish/ }).click()
    eq(digits(await page.getByTestId('cart-total').innerText()), before, 'decreasing restores the total')
    await page.reload({ waitUntil: 'networkidle' })
    eq(await page.getByTestId('cart-line').count(), 3, 'cart survives reload')
    while (await page.getByTestId('cart-line').count()) {
      await page.getByTestId('cart-line').first().getByRole('button', { name: /Olib tashlash/ }).click()
      await sleep(80)
    }
    check(await page.getByRole('heading', { name: "Savatchangiz bo'sh" }).isVisible(), 'removing all lines shows the empty state')
    eq(await page.getByTestId('nav-cart-badge').count(), 0, 'badge hidden for an empty cart')
    eq(await cart(), [], 'storage emptied')

    // corrupted storage must not crash the app
    await page.evaluate(() => localStorage.setItem('aynimo:cart', '{"bad":true} garbage'))
    await page.reload({ waitUntil: 'networkidle' })
    check(await page.getByRole('heading', { name: "Savatchangiz bo'sh" }).isVisible(), 'corrupted cart storage is ignored')
    await page.evaluate(() => localStorage.setItem('aynimo:cart', JSON.stringify([{ productId: 's-tee-1', size: 'M', color: 'Oq', qty: 999 }, { productId: 'ghost', size: 'M', color: 'Oq', qty: 1 }])))
    await page.reload({ waitUntil: 'networkidle' })
    eq((await cart()).length, 1, 'unknown products dropped from stored cart')
    eq((await cart())[0].qty, 12, 'stored quantity clamped to stock')

    // ======================================================= QUICK ORDER
    await go('/mahsulot/s-jacket-1')
    await page.getByRole('heading', { level: 1, name: 'Yengil kurtka' }).waitFor()
    const badgeBefore = (await page.getByTestId('header-cart-badge').innerText()).trim()
    await page.getByRole('radio', { name: 'L', exact: true }).click()
    await page.getByRole('button', { name: 'Miqdorni oshirish' }).click()
    await page.getByTestId('quick-order').click()
    await page.waitForURL(/\/tezkor-buyurtma/)
    const qi = page.getByTestId('quick-item')
    await qi.waitFor({ timeout: 3000 })
    const qt = await qi.innerText()
    check(qt.includes('Yengil kurtka') && qt.includes('L') && qt.includes('2'), 'quick order shows the selected variant')
    check((await page.getByTestId('cart-total').innerText()).includes('1 780 000'), 'quick order total = 2 x 890 000')
    await shot('15-quick-order')
    eq(await page.getByRole('navigation', { name: 'Asosiy navigatsiya' }).locator('a').count(), 5, 'five-item tab bar on Quick Order screen')
    eq(await page.getByRole('navigation', { name: 'Asosiy navigatsiya' }).locator('a').evaluateAll((a) => a.map((x) => x.getAttribute('aria-label'))), ['Asosiy', 'Katalog', 'Tezkor buyurtma', 'Savatcha', 'Profil'], 'nav order unchanged')
    eq((await page.getByTestId('nav-cart-badge').innerText()).trim(), badgeBefore, 'Quick Order does not touch the cart')
    await page.reload({ waitUntil: 'networkidle' })
    check(await page.getByTestId('quick-item').isVisible(), 'quick selection survives reload (session)')
    await page.evaluate(() => sessionStorage.setItem('aynimo:quick', '{"productId":"s-dress-2","size":"M","color":"Qora","qty":1}'))
    await page.reload({ waitUntil: 'networkidle' })
    eq(await page.getByTestId('quick-item').count(), 0, 'invalid/out-of-stock quick selection is rejected')

    // ======================================================= NO FAVORITES ANYWHERE
    for (const route of ['/', '/katalog', '/mahsulot/s-tee-1', '/savatcha', '/tezkor-buyurtma', '/profil']) {
      await go(route)
      const txt = (await page.locator('body').innerText()).toLowerCase()
      check(!/sevimli|favorit|wishlist|istaklar/.test(txt), `no favorites/wishlist on ${route}`)
    }

    // ======================================================= MOBILE SIZES
    await page.evaluate(() => localStorage.setItem('aynimo:cart', JSON.stringify([{ productId: 's-hoodie-1', size: 'M', color: 'Marjon', qty: 2 }, { productId: 's-jacket-1', size: 'L', color: 'Qora', qty: 1 }])))
    await page.evaluate(() => sessionStorage.setItem('aynimo:quick', '{"productId":"s-jacket-1","size":"L","color":"Qora","qty":2}'))
    for (const [w, h] of [[320, 568], [360, 740], [390, 844], [430, 932]]) {
      await page.setViewportSize({ width: w, height: h })
      for (const route of ['/katalog', '/katalog?brand=aynimo&size=M&color=Marjon&sort=price_asc', '/mahsulot/s-hoodie-1', '/mahsulot/s-dress-2', '/savatcha', '/tezkor-buyurtma']) {
        await go(route)
        await sleep(250)
        const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
        check(over <= 0, `no horizontal overflow ${w}px ${route}`)
        if (route === '/savatcha') {
          const gaps = await page.evaluate(() => {
            const labels = [...document.querySelectorAll('nav[aria-label="Asosiy navigatsiya"] a')].map((a) => {
              const r = document.createRange(); const spans = [...a.querySelectorAll('span')].filter((s) => s.children.length === 0 && s.textContent.trim().length > 2)
              const rects = spans.map((s) => s.getBoundingClientRect()); return { l: Math.min(...rects.map((r) => r.left)), r: Math.max(...rects.map((r) => r.right)) }
            })
            return labels.slice(1).map((x, i) => x.l - labels[i].r)
          })
          check(gaps.every((g) => g >= 0), `tab labels do not collide at ${w}px (gaps ${gaps.map((g) => Math.round(g)).join(',')})`)
        }
        if (route === '/mahsulot/s-hoodie-1') {
          const r = await page.evaluate(() => {
            const bar = document.querySelector('[data-testid="action-bar"]').getBoundingClientRect()
            const nav = document.querySelector('nav[aria-label="Asosiy navigatsiya"] ul').getBoundingClientRect()
            const [a, b] = [...document.querySelectorAll('[data-testid="add-to-cart"],[data-testid="quick-order"]')]
            const A = a.getBoundingClientRect(), B = b.getBoundingClientRect()
            const clipped = [a, b].some((el) => el.scrollWidth > el.clientWidth + 1)
            const wrapped = [a, b].some((el) => el.getBoundingClientRect().height > 58)
            return { inView: bar.bottom <= nav.top + 0.5 && nav.bottom <= innerHeight + 1 && bar.left >= 0 && bar.right <= innerWidth && nav.left >= 0 && nav.right <= innerWidth, overlap: A.right > B.left + 0.5, clipped, wrapped }
          })
          check(r.inView && !r.overlap && !r.clipped && !r.wrapped, `purchase panel + tab bar fit at ${w}px (stacked, in view, buttons separate, labels on one line)`)
        }
      }
      // filter sheet fits the viewport and keeps its apply button reachable
      await go('/katalog')
      await openFilter()
      const fit = await page.evaluate(() => {
        const d = document.querySelector('[role="dialog"]').getBoundingClientRect()
        const btn = [...document.querySelectorAll('[role="dialog"] button')].find((b) => /Natijalarni/.test(b.textContent)).getBoundingClientRect()
        return { sheetH: d.height <= innerHeight, top: d.top >= 0, btn: btn.bottom <= innerHeight + 1 && btn.top >= 0 }
      })
      check(fit.sheetH && fit.top && fit.btn, `filter sheet fits ${w}x${h}, apply button reachable`)
      if (w === 320) { await shot('16-filter-320'); await sheet().locator('input[type=range]').first().scrollIntoViewIfNeeded(); await shot('17-filter-320-price') }
      await page.keyboard.press('Escape'); await sheet().waitFor({ state: 'detached' })
    }
    await page.setViewportSize({ width: 320, height: 568 })
    await go('/mahsulot/s-hoodie-1'); await shot('18-product-320')
    await go('/savatcha'); await shot('19-cart-320')
    await page.setViewportSize({ width: 390, height: 844 })

    check(errors.length === 0, `no console/page errors ${errors.slice(0, 3).join(' || ')}`)
    check(bad.length === 0, `no failed local requests ${bad.slice(0, 3).join(' || ')}`)
    await browser.close()
  } finally { if (server) try { process.kill(-server.pid) } catch {} }
  console.log(fails.length ? `\n${fails.length} FAILED:\n - ${fails.join('\n - ')}` : '\nALL PASSED')
  process.exit(fails.length ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(1) })
