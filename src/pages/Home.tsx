import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Bell, Search } from 'lucide-react'
import { Logo } from '../components/Logo'
import { BannerCarousel } from '../components/BannerCarousel'
import { ProductCard, ProductRail } from '../components/ProductCard'
import { OutfitCard } from '../components/OutfitCard'
import { NotificationsSheet } from '../components/NotificationsSheet'
import { Section } from '../components/ui'
import { activeProducts, categories, getProduct, outfits } from '../data/sample'
import { useRecent } from '../lib/recent'
import { t } from '../i18n'

const NON_CLOTHING = new Set(['shoes', 'accessories', 'bags'])

export function Home() {
  const navigate = useNavigate()
  const [sheet, setSheet] = useState(false)
  const recent = useRecent()
  const all = activeProducts()

  const byDate = [...all].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const newest = byDate.filter((p) => p.isNew)
  const popular = [...all].sort((a, b) => b.popularity - a.popularity).slice(0, 8)
  const discounted = all.filter((p) => p.oldPrice)
  const clothing = all.filter((p) => !NON_CLOTHING.has(p.categoryId))
  const recentProducts = recent.map(getProduct).filter((p) => p !== undefined)

  return (
    <div className="pb-36">
      <header
        className="sticky top-0 z-30 flex items-center justify-between bg-ivory/85 px-4 pb-2 backdrop-blur-xl"
        style={{ paddingTop: 'calc(var(--safe-top) + 10px)' }}
      >
        <Logo className="h-10" />
        <div className="flex gap-2">
          <button type="button" aria-label={t('home.search')} onClick={() => navigate('/katalog?focus=1')} className="glass grid size-10 place-items-center rounded-full">
            <Search className="size-[19px]" />
          </button>
          <button type="button" aria-label={t('home.notifications')} onClick={() => setSheet(true)} className="glass grid size-10 place-items-center rounded-full">
            <Bell className="size-[19px]" />
          </button>
        </div>
      </header>

      <p className="mx-4 mb-4 mt-1 rounded-2xl bg-beige-soft px-3.5 py-2 text-[12px] font-medium text-navy-soft">{t('home.demo')}</p>

      <BannerCarousel />

      <div className="no-scrollbar mt-6 flex gap-2 overflow-x-auto px-4" aria-label={t('home.categories')}>
        {categories.map((c) => (
          <Link key={c.id} to={c.id === 'all' ? '/katalog' : `/katalog?cat=${c.id}`} className="glass shrink-0 rounded-full px-4 py-2 text-[13px] font-semibold">
            {c.name}
          </Link>
        ))}
      </div>

      <Section title={t('home.newCollection')} to="/katalog?f=new">
        <div className="grid grid-cols-2 gap-3 px-4">
          {newest.slice(0, 2).map((p) => (
            <ProductCard key={p.id} product={p} grid />
          ))}
        </div>
      </Section>

      <Section title={t('home.original')} to="/katalog?f=original">
        <ProductRail items={all.filter((p) => p.type === 'original').slice(0, 8)} />
      </Section>

      <Section title={t('home.otherBrands')} to="/katalog?f=other">
        <ProductRail items={all.filter((p) => p.type === 'other').slice(0, 8)} />
      </Section>

      <Section title={t('home.popular')} to="/katalog?f=popular">
        <ProductRail items={popular} />
      </Section>

      <Section title={t('home.newArrivals')} to="/katalog?f=new">
        <ProductRail items={byDate.slice(0, 8)} />
      </Section>

      <Section title={t('home.discounted')} to="/katalog?f=discount">
        <ProductRail items={discounted} />
      </Section>

      <Section title={t('home.shoes')} to="/katalog?cat=shoes">
        <ProductRail items={all.filter((p) => p.categoryId === 'shoes')} />
      </Section>

      <Section title={t('home.clothing')} to="/katalog">
        <ProductRail items={clothing.slice(0, 10)} />
      </Section>

      <Section title={t('home.style')} sub={t('home.styleSub')}>
        <div className="rail">
          {outfits.map((o) => (
            <OutfitCard key={o.id} outfit={o} />
          ))}
        </div>
      </Section>

      {recentProducts.length > 0 && (
        <Section title={t('home.recent')}>
          <ProductRail items={recentProducts} />
        </Section>
      )}

      <NotificationsSheet open={sheet} onClose={() => setSheet(false)} />
    </div>
  )
}
