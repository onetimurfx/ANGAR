import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ImageOff, Plus, Search } from 'lucide-react'
import { imageUrl } from '../../lib/backend'
import { aGet } from '../api'
import { useDebounced } from '../hooks'
import { A, adminError, uzs } from '../text'
import type { Category, ProductRow } from '../types'
import { Badge, Chips, Empty, ErrorBox, Input, Loading, Pager, Select, btnPrimary } from '../ui'
import { PageTitle } from './common'

interface ListAnswer { products: ProductRow[]; total: number }
const PAGE = 30

export function Products() {
  const [q, setQ] = useState('')
  const dq = useDebounced(q)
  const [status, setStatus] = useState<'' | 'active' | 'inactive'>('')
  const [cat, setCat] = useState('')
  const [cats, setCats] = useState<Category[]>([])
  const [rows, setRows] = useState<ProductRow[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => { aGet<{ categories: Category[] }>('categories').then((r) => setCats(r.categories), () => undefined) }, [])
  const load = useCallback(async (offset: number) => {
    setLoading(true)
    try {
      const r = await aGet<ListAnswer>('products', { q: dq, status, category: cat, limit: PAGE, offset })
      setRows((p) => (offset === 0 ? r.products : [...p, ...r.products])); setTotal(r.total); setError(null)
    } catch (e) { setError(adminError(e)) } finally { setLoading(false) }
  }, [dq, status, cat])
  useEffect(() => { void load(0) }, [load, tick])

  return (
    <div data-testid="admin-products">
      <PageTitle title={A.nav.products} right={<Link to="/admin/products/new" className={btnPrimary} data-testid="product-new"><Plus className="size-4" />Yangi</Link>} />
      <div className="relative mb-3">
        <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-stone" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Nomi yoki SKU" aria-label={A.search} className="pl-10" maxLength={100} />
      </div>
      <div className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Select value={cat} onChange={(e) => setCat(e.target.value)} aria-label="Kategoriya"><option value="">Barcha kategoriyalar</option>{cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>
      </div>
      <Chips label="Holat" value={status} onChange={setStatus} options={[{ id: '', label: A.all }, { id: 'active', label: 'Faol' }, { id: 'inactive', label: 'Yashirin' }]} />
      <div className="mt-3 space-y-2">
        {error && <ErrorBox message={error} onRetry={() => setTick((x) => x + 1)} />}
        {!error && loading && rows.length === 0 && <Loading />}
        {!error && !loading && rows.length === 0 && <Empty />}
        {rows.map((p) => {
          const img = p.image ? imageUrl(p.image) : null
          return (
            <Link key={p.id} to={`/admin/products/${p.id}`} data-testid="product-row" className="glass flex items-center gap-3 rounded-2xl p-3 active:scale-[0.99]">
              <div className="grid size-16 shrink-0 place-items-center overflow-hidden rounded-xl bg-mist">
                {img ? <img src={img} alt="" className="size-full object-cover" loading="lazy" /> : <ImageOff className="size-5 text-stone" />}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[14px] font-bold">{p.name}</p>
                <p className="truncate text-[12px] text-stone">{p.brandName} · {p.categoryName}</p>
                <p className="text-[13px] font-semibold">{uzs(p.price)}{p.oldPrice ? <span className="ml-1.5 text-[12px] font-normal text-stone line-through">{uzs(p.oldPrice)}</span> : null}</p>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1">
                <Badge tone={p.active ? 'on' : 'off'}>{p.active ? 'Faol' : 'Yashirin'}</Badge>
                {p.isSample && <Badge tone="low">sample</Badge>}
                <span className={`text-[12px] font-semibold ${p.stock === 0 ? 'text-coral' : 'text-navy-soft'}`}>{p.stock === 0 ? 'Tugagan' : `${p.stock} dona`}</span>
              </div>
            </Link>
          )
        })}
        {!error && rows.length > 0 && <Pager shown={rows.length} total={total} loading={loading} onMore={() => void load(rows.length)} />}
      </div>
    </div>
  )
}
