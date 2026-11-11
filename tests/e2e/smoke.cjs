/* Smoke test + screenshots. Run: npm run build && npm run test:e2e
   Uses the system Chrome (CHROME_PATH to override). Serves dist/ with `vite preview`. */
const { chromium } = require('playwright-core')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const BASE = (process.env.AYN_BASE || 'http://127.0.0.1:4173').replace(/\/$/, '')
const SHOTS = path.join(__dirname, 'shots')
const fails = []
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) fails.push(msg) }

async function waitFor(url, ms = 15000) {
  const end = Date.now() + ms
  while (Date.now() < end) { try { if ((await fetch(url)).ok) return } catch {} await new Promise(r => setTimeout(r, 250)) }
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
    const errors = []
    page.on('pageerror', e => errors.push(String(e)))
    page.on('console', m => m.type() === 'error' && !/telegram\.org|ERR_|Failed to load resource/.test(m.text()) && errors.push(m.text()))
    const bad = []
    page.on('response', r => { if (r.status() >= 400 && r.url().startsWith(BASE)) bad.push(`${r.status()} ${r.url()}`) })
    await page.route('**/telegram.org/**', r => r.abort()) // preview mode: app must work without Telegram

    await page.goto(BASE + '/', { waitUntil: 'networkidle' })
    const nav = page.getByRole('navigation', { name: 'Asosiy navigatsiya' })
    const items = await nav.locator('a').allInnerTexts()
    check(items.length === 5, `bottom nav has exactly 5 items (${items.length})`)
    const labels = (await nav.locator('a').evaluateAll(els => els.map(e => e.getAttribute('aria-label'))))
    check(JSON.stringify(labels) === JSON.stringify(['Asosiy', 'Katalog', 'Tezkor buyurtma', 'Savatcha', 'Profil']), `nav order/labels: ${labels.join(' | ')}`)
    const centerBg = await nav.locator('a').nth(2).locator('span').first().evaluate(e => getComputedStyle(e).backgroundColor)
    check(centerBg === 'rgb(217, 75, 89)', `center Quick Order is Coral Red #D94B59 (${centerBg})`)
    check(await nav.locator('a').nth(2).locator('svg').count() === 1, 'center item has the lightning icon')
    const logoOk = await page.locator('img[alt="ANGAR"]').first().evaluate(i => i.complete && i.naturalWidth > 0)
    check(logoOk, 'ANGAR wordmark loads')

    const body = (await page.locator('body').innerText()).toLowerCase()
    check(!/sevimli|favorit|wishlist|istaklar/.test(body), 'no favorites/wishlist text on home')
    for (const h of ['Yangi kolleksiya', 'ANGAR Original', 'Boshqa brendlar', 'Mashhur mahsulotlar', 'Yangi kelganlar', 'Chegirmadagi mahsulotlar', 'Poyabzal kolleksiyasi', 'Kiyim kolleksiyasi', 'Uslub ilhomi'])
      check(await page.getByRole('heading', { name: h, exact: true }).first().isVisible().catch(() => false) || (await page.getByRole('heading', { name: h, exact: true }).count()) > 0, `home section: ${h}`)
    check((await page.locator('text=NAMUNA').count()) > 5, 'products are marked NAMUNA (sample)')
    await page.screenshot({ path: path.join(SHOTS, '01-home-top.png') })
    await page.evaluate(() => window.scrollTo(0, 900)); await page.waitForTimeout(200)
    await page.screenshot({ path: path.join(SHOTS, '02-home-scrolled.png') })
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)); await page.waitForTimeout(200)
    await page.screenshot({ path: path.join(SHOTS, '03-home-bottom.png') })
    await page.evaluate(() => window.scrollTo(0, 0))

    // notification + search buttons are real
    await page.getByRole('button', { name: 'Bildirishnomalar' }).click()
    check(await page.getByRole('dialog').isVisible(), 'notification sheet opens')
    await page.screenshot({ path: path.join(SHOTS, '04-notifications.png') })
    await page.keyboard.press('Escape')
    check(await page.getByRole('dialog').waitFor({ state: 'detached', timeout: 3000 }).then(() => true, () => false), 'notification sheet closes')
    await page.getByRole('button', { name: 'Qidirish' }).click()
    await page.waitForURL(/\/katalog/)
    const focused = await page.waitForFunction(() => document.activeElement && document.activeElement.tagName === 'INPUT', null, { timeout: 3000 }).then(() => true, () => false)
    check(focused, 'search opens catalog with focused input')

    // catalog filters
    await page.getByRole('button', { name: 'Poyabzal', exact: true }).click()
    await page.waitForFunction(() => document.querySelectorAll('a[href*="/mahsulot/"]').length === 2, null, { timeout: 3000 }).catch(() => {})
    const shoeCount = await page.locator('a[href*="/mahsulot/"]').count()
    check(shoeCount === 2, `category filter Poyabzal -> ${shoeCount} products`)
    await page.getByPlaceholder('Mahsulot nomi yoki brend').fill('zzzz')
    check(await page.getByRole('heading', { name: 'Hech narsa topilmadi' }).waitFor({ timeout: 3000 }).then(() => true, () => false), 'empty search state')
    await page.getByPlaceholder('Mahsulot nomi yoki brend').fill('')
    await page.getByRole('button', { name: 'Poyabzal', exact: true }).click() // toggle? stays selected -> use Barcha
    await page.getByRole('button', { name: 'Barcha mahsulotlar' }).click()
    await page.waitForTimeout(300); await page.screenshot({ path: path.join(SHOTS, '05-catalog.png') })

    // product detail, every card clickable, recent
    const firstName = (await page.locator('a[href*="/mahsulot/"] p.font-semibold').nth(1).innerText()).trim()
    await page.locator('a[href*="/mahsulot/"]').first().click()
    await page.waitForURL(/\/mahsulot\//)
    check(await page.locator('h1', { hasText: 'Oq krossovka' }).waitFor({ timeout: 3000 }).then(() => true, () => false), `product page renders (${firstName ? 'card name read' : ''})`)
    await page.waitForTimeout(300)
    const logoOnDetail = await page.locator('img[alt="ANGAR"]').count()
    check(logoOnDetail === 0 || await page.locator('img[alt="ANGAR"]').first().evaluate(i => i.naturalWidth > 0), 'no broken logo on nested route')
    await page.screenshot({ path: path.join(SHOTS, '06-product.png') })
    await page.getByRole('button', { name: 'Orqaga' }).click()

    // five tabs navigate
    for (const [name, url, heading] of [['Savatcha', '/savatcha', 'Savatchangiz bo\'sh'], ['Tezkor buyurtma', '/tezkor-buyurtma', 'Tezkor buyurtma'], ['Profil', '/profil', 'Profil'], ['Katalog', '/katalog', 'Katalog'], ['Asosiy', '/', null]]) {
      await nav.getByRole('link', { name, exact: true }).click()
      await page.waitForURL(u => (new URL(u).pathname.replace(/^\/AYNIMO/, '') || '/') === url)
      check(true, `tab ${name} -> ${url}`)
      if (heading) check(await page.getByRole('heading', { name: heading, exact: true }).first().waitFor({ state: 'visible', timeout: 3000 }).then(() => true, () => false), `${name} screen shows "${heading}"`)
      await page.waitForTimeout(300)
      if (url === '/tezkor-buyurtma') await page.screenshot({ path: path.join(SHOTS, '07-quick-order.png') })
      if (url === '/profil') await page.screenshot({ path: path.join(SHOTS, '08-profile.png') })
    }
    // recently viewed shows on home after visiting a product
    await page.getByRole('heading', { name: 'Yangi kolleksiya', exact: true }).first().waitFor({ timeout: 3000 })
    check(await page.getByRole('heading', { name: "Yaqinda ko'rilganlar" }).count() > 0, 'recently viewed appears after viewing a product')

    // outfit page
    await page.locator('a[href*="/komplekt/"]').first().click()
    await page.waitForURL(/\/komplekt\//)
    await page.getByRole('heading', { level: 1, name: 'Kundalik klassika' }).waitFor({ timeout: 3000 })
    check(await page.locator('main a[href*="/mahsulot/"]').count() === 3, 'outfit lists 3 individual products')
    await page.waitForTimeout(300)
    await page.screenshot({ path: path.join(SHOTS, '09-outfit.png') })

    // deep link on a nested route (SPA fallback) + unknown route
    await page.goto(BASE + '/mahsulot/s-bag-1', { waitUntil: 'networkidle' })
    check(await page.getByRole('heading', { name: 'Ayollar sumkasi' }).isVisible(), 'deep link /mahsulot/:id works')
    await page.goto(BASE + '/nope', { waitUntil: 'networkidle' })
    check(await page.getByRole('heading', { name: 'Sahifa topilmadi' }).first().isVisible(), '404 route handled')

    // Telegram launch params live in the URL hash and must not break routing
    await page.goto(BASE + '/#tgWebAppData=query_id%3DAAA&tgWebAppVersion=8.0', { waitUntil: 'networkidle' })
    check(await page.getByRole('heading', { name: 'Yangi kolleksiya', exact: true }).first().isVisible(), 'Telegram hash params do not break routing')

    // no horizontal overflow at small widths
    for (const w of [320, 360, 390, 430]) {
      await page.setViewportSize({ width: w, height: 800 })
      for (const p of ['/', '/katalog', '/mahsulot/s-hoodie-1', '/profil']) {
        await page.goto(BASE + p, { waitUntil: 'networkidle' })
        const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
        check(over <= 0, `no horizontal overflow ${w}px ${p}`)
      }
    }
    await page.setViewportSize({ width: 320, height: 700 })
    await page.goto(BASE + '/', { waitUntil: 'networkidle' })
    await page.screenshot({ path: path.join(SHOTS, '10-home-320.png') })

    check(errors.length === 0, `no console/page errors ${errors.slice(0, 3).join(' || ')}`)
    check(bad.length === 0, `no failed local requests ${bad.slice(0, 3).join(' || ')}`)
    await browser.close()
  } finally { if (server) try { process.kill(-server.pid) } catch {} }
  console.log(fails.length ? `\n${fails.length} FAILED` : '\nALL PASSED')
  process.exit(fails.length ? 1 : 0)
})().catch(e => { console.error(e); process.exit(1) })
