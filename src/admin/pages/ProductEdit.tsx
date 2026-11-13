import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, ImagePlus, Plus, Star, Trash2 } from 'lucide-react'
import { imageUrl } from '../../lib/backend'
import { aGet, aPost, uploadPhoto } from '../api'
import { useMe } from '../AdminApp'
import { useAction } from '../hooks'
import { A, adminError, uzs } from '../text'
import type { Brand, Category, ProductFull } from '../types'
import { Badge, Btn, ErrorBox, Field, Input, Loading, Notice, Select, Textarea, card } from '../ui'

interface VariantForm { id?: string; size: string; colorName: string; colorHex: string; sku: string; active: boolean; quantity: string; reserved?: number; current?: number }
interface Form { name: string; brandId: string; categoryId: string; description: string; price: string; oldPrice: string; isNew: boolean; active: boolean; isSample: boolean; variants: VariantForm[] }

const EMPTY: Form = { name: '', brandId: '', categoryId: '', description: '', price: '', oldPrice: '', isNew: true, active: true, isSample: false, variants: [] }
const MAX_BYTES = 5 * 1024 * 1024
const TYPES = ['image/jpeg', 'image/png', 'image/webp']

const toForm = (p: ProductFull): Form => ({
  name: p.name, brandId: p.brandId, categoryId: p.categoryId, description: p.description, price: String(p.price), oldPrice: p.oldPrice === null ? '' : String(p.oldPrice),
  isNew: p.isNew, active: p.active, isSample: p.isSample,
  variants: p.variants.map((v) => ({ id: v.id, size: v.size, colorName: v.colorName, colorHex: v.colorHex, sku: v.sku ?? '', active: v.active, quantity: '', reserved: v.reserved, current: v.quantity })),
})

export function ProductEdit() {
  const { id = 'new' } = useParams()
  const isNew = id === 'new'
  const nav = useNavigate()
  const me = useMe()
  const [product, setProduct] = useState<ProductFull | null>(null)
  const [form, setForm] = useState<Form>(EMPTY)
  const [brands, setBrands] = useState<Brand[]>([])
  const [cats, setCats] = useState<Category[]>([])
  const [loading, setLoading] = useState(true)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [ok, setOk] = useState(false)
  const act = useAction()
  const img = useAction()
  const file = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let live = true
    setLoading(true); setLoadErr(null); setOk(false)
    Promise.all([
      aGet<{ brands: Brand[] }>('brands'), aGet<{ categories: Category[] }>('categories'),
      isNew ? Promise.resolve(null) : aGet<{ product: ProductFull }>('product', { id }),
    ]).then(([b, c, p]) => {
      if (!live) return
      setBrands(b.brands); setCats(c.categories)
      if (p) { setProduct(p.product); setForm(toForm(p.product)) } else { setProduct(null); setForm(EMPTY) }
    }, (e) => { if (live) setLoadErr(adminError(e)) }).finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [id, isNew])

  const set = <K extends keyof Form>(k: K, v: Form[K]) => { setForm((f) => ({ ...f, [k]: v })); setOk(false) }
  const setVar = (i: number, patch: Partial<VariantForm>) => { setForm((f) => ({ ...f, variants: f.variants.map((v, n) => (n === i ? { ...v, ...patch } : v)) })); setOk(false) }

  // client checks only help the user: the server validates everything again
  const priceOk = /^\d{1,9}$/.test(form.price) && Number(form.price) > 0
  const oldOk = form.oldPrice === '' || (/^\d{1,9}$/.test(form.oldPrice) && Number(form.oldPrice) > Number(form.price))
  const varsOk = form.variants.every((v) => v.size.trim() && v.colorName.trim() && /^#[0-9a-fA-F]{6}$/.test(v.colorHex) && (v.id !== undefined || v.quantity === '' || /^\d{1,6}$/.test(v.quantity)))
  const valid = form.name.trim().length > 0 && form.brandId && form.categoryId && priceOk && oldOk && varsOk && (!isNew || form.variants.length > 0)

  const save = () => act.run(async () => {
    const body = {
      name: form.name.trim(), brandId: form.brandId, categoryId: form.categoryId, description: form.description.trim(), price: Number(form.price),
      oldPrice: form.oldPrice === '' ? null : Number(form.oldPrice), isNew: form.isNew, active: form.active,
      ...(me.role === 'owner' ? { isSample: form.isSample } : {}),
      ...(isNew ? {} : { id }),
      variants: form.variants.map((v) => ({
        ...(v.id ? { id: v.id } : { quantity: v.quantity === '' ? 0 : Number(v.quantity) }),
        size: v.size.trim(), colorName: v.colorName.trim(), colorHex: v.colorHex, sku: v.sku.trim() || null, active: v.active,
      })),
    }
    const r = await aPost<{ product: ProductFull }>('product', { action: 'save', product: body })
    setOk(true)
    if (isNew) nav(`/admin/products/${r.product.id}`, { replace: true })
    else { setProduct(r.product); setForm(toForm(r.product)) }
  })

  const upload = (f: File) => img.run(async () => {
    if (!TYPES.includes(f.type)) throw new Error('type')
    if (f.size > MAX_BYTES) throw new Error('size')
    const u = await aPost<{ path: string; uploadUrl: string }>('product', { action: 'image_upload_url', id, contentType: f.type })
    await uploadPhoto(u.uploadUrl, f)
    const r = await aPost<{ product: ProductFull }>('product', { action: 'image_add', id, path: u.path })
    setProduct(r.product)
  })
  const imgAct = (action: 'image_cover' | 'image_delete', imageId: string) => img.run(async () => {
    const r = await aPost<{ product: ProductFull }>('product', { action, id: imageId })
    setProduct(r.product)
  })

  if (loading) return <Loading />
  if (loadErr) return <ErrorBox message={loadErr} onRetry={() => nav(0)} />

  return (
    <div data-testid="admin-product-edit">
      <div className="mb-3 flex items-center gap-3">
        <Link to="/admin/products" aria-label={A.back} className="glass grid size-10 place-items-center rounded-full"><ArrowLeft className="size-5" /></Link>
        <h1 className="min-w-0 flex-1 truncate text-2xl">{isNew ? 'Yangi mahsulot' : product?.name}</h1>
        {product && <Badge tone={product.active ? 'on' : 'off'}>{product.active ? 'Faol' : 'Yashirin'}</Badge>}
      </div>

      <div className="space-y-4 lg:grid lg:grid-cols-2 lg:gap-4 lg:space-y-0">
        <section className={`${card} space-y-3`}>
          <Field label="Nomi"><Input value={form.name} onChange={(e) => set('name', e.target.value)} maxLength={200} data-testid="p-name" /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Brend"><Select value={form.brandId} onChange={(e) => set('brandId', e.target.value)} data-testid="p-brand"><option value="">Tanlang</option>{brands.filter((b) => b.active || b.id === form.brandId).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select></Field>
            <Field label="Kategoriya"><Select value={form.categoryId} onChange={(e) => set('categoryId', e.target.value)} data-testid="p-category"><option value="">Tanlang</option>{cats.filter((c) => c.active || c.id === form.categoryId).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Narx (so'm)"><Input inputMode="numeric" value={form.price} onChange={(e) => set('price', e.target.value.replace(/\D/g, ''))} data-testid="p-price" /></Field>
            <Field label="Eski narx" hint={form.oldPrice !== '' && !oldOk ? "Narxdan katta bo'lishi kerak" : 'Chegirma uchun'}><Input inputMode="numeric" value={form.oldPrice} onChange={(e) => set('oldPrice', e.target.value.replace(/\D/g, ''))} /></Field>
          </div>
          <Field label="Tavsif"><Textarea value={form.description} onChange={(e) => set('description', e.target.value)} maxLength={4000} /></Field>
          <label className="flex min-h-11 items-center gap-3 text-[14px]"><input type="checkbox" checked={form.active} onChange={(e) => set('active', e.target.checked)} className="size-5 accent-[#d94b59]" data-testid="p-active" />Do'konda ko'rinadi (faol)</label>
          <label className="flex min-h-11 items-center gap-3 text-[14px]"><input type="checkbox" checked={form.isNew} onChange={(e) => set('isNew', e.target.checked)} className="size-5 accent-[#d94b59]" />«Yangi» belgisi</label>
          {me.role === 'owner' && !isNew && <label className="flex min-h-11 items-center gap-3 text-[14px]"><input type="checkbox" checked={form.isSample} onChange={(e) => set('isSample', e.target.checked)} className="size-5 accent-[#d94b59]" />Namuna (sample): sotib bo'lmaydi</label>}
        </section>

        <section className={`${card} space-y-3`}>
          <h2 className="text-[17px]">O'lcham va ranglar</h2>
          {form.variants.length === 0 && <p className="text-[13px] text-stone">Kamida bitta variant qo'shing.</p>}
          {form.variants.map((v, i) => (
            <div key={v.id ?? `n${i}`} className="space-y-2 rounded-2xl bg-white p-3" data-testid="variant-row">
              <div className="grid grid-cols-2 gap-2">
                <Input placeholder="O'lcham (M)" value={v.size} maxLength={20} onChange={(e) => setVar(i, { size: e.target.value })} aria-label="O'lcham" />
                <Input placeholder="Rang (Qora)" value={v.colorName} maxLength={40} onChange={(e) => setVar(i, { colorName: e.target.value })} aria-label="Rang nomi" />
              </div>
              <div className="grid grid-cols-[auto_1fr_1fr] items-center gap-2">
                <input type="color" value={/^#[0-9a-fA-F]{6}$/.test(v.colorHex) ? v.colorHex : '#000000'} onChange={(e) => setVar(i, { colorHex: e.target.value.toUpperCase() })} className="size-11 rounded-xl border border-navy/10 bg-white p-1" aria-label="Rang" />
                <Input placeholder="#RRGGBB" value={v.colorHex} maxLength={7} onChange={(e) => setVar(i, { colorHex: e.target.value })} aria-label="Rang kodi" />
                <Input placeholder="SKU" value={v.sku} maxLength={60} onChange={(e) => setVar(i, { sku: e.target.value })} aria-label="SKU" />
              </div>
              <div className="flex items-center justify-between gap-3">
                {v.id ? (
                  <span className="text-[12px] text-navy-soft">Omborda: <b>{v.current}</b>{v.reserved ? ` (band: ${v.reserved})` : ''} · <Link to="/admin/inventory" className="text-coral">o'zgartirish</Link></span>
                ) : (
                  <Input placeholder="Boshlang'ich soni" inputMode="numeric" value={v.quantity} maxLength={6} onChange={(e) => setVar(i, { quantity: e.target.value.replace(/\D/g, '') })} aria-label="Boshlang'ich miqdor" className="max-w-40" />
                )}
                {v.id ? (
                  <label className="flex min-h-11 items-center gap-2 text-[13px]"><input type="checkbox" checked={v.active} onChange={(e) => setVar(i, { active: e.target.checked })} className="size-5 accent-[#d94b59]" />Sotuvda</label>
                ) : (
                  <button type="button" aria-label="Olib tashlash" onClick={() => set('variants', form.variants.filter((_, n) => n !== i))} className="grid size-11 place-items-center rounded-full text-coral"><Trash2 className="size-5" /></button>
                )}
              </div>
            </div>
          ))}
          <Btn kind="ghost" data-testid="variant-add" onClick={() => set('variants', [...form.variants, { size: '', colorName: '', colorHex: '#000000', sku: '', active: true, quantity: '' }])}><Plus className="size-4" />Variant qo'shish</Btn>
          {!isNew && <p className="text-[12px] text-stone">Mavjud variantni o'chirib bo'lmaydi (buyurtmalar unga bog'liq): «Sotuvda» belgisini olib tashlang.</p>}
        </section>

        {!isNew && product && (
          <section className={`${card} space-y-3 lg:col-span-2`}>
            <div className="flex items-center justify-between"><h2 className="text-[17px]">Rasmlar ({product.images.length}/12)</h2>
              <Btn kind="ghost" busy={img.busy} onClick={() => file.current?.click()} data-testid="image-add"><ImagePlus className="size-4" />Rasm qo'shish</Btn></div>
            <input ref={file} type="file" accept="image/jpeg,image/png,image/webp" className="hidden" data-testid="image-input"
              onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void upload(f) }} />
            {img.error && <Notice>{img.error}</Notice>}
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-6">
              {product.images.map((im, n) => (
                <div key={im.id} className="relative aspect-[3/4] overflow-hidden rounded-2xl bg-mist" data-testid="image-tile">
                  {imageUrl(im.path) && <img src={imageUrl(im.path)!} alt="" className="size-full object-cover" loading="lazy" />}
                  {n === 0 && <span className="absolute left-1.5 top-1.5 rounded-full bg-navy/80 px-2 py-0.5 text-[10px] font-bold text-white">asosiy</span>}
                  <div className="absolute inset-x-1.5 bottom-1.5 flex justify-between">
                    {n !== 0 ? <button type="button" aria-label="Asosiy qilish" onClick={() => void imgAct('image_cover', im.id)} className="grid size-9 place-items-center rounded-full bg-white/90"><Star className="size-4" /></button> : <span />}
                    <button type="button" aria-label="O'chirish" onClick={() => void imgAct('image_delete', im.id)} className="grid size-9 place-items-center rounded-full bg-white/90 text-coral"><Trash2 className="size-4" /></button>
                  </div>
                </div>
              ))}
            </div>
            <p className="text-[12px] text-stone">JPG, PNG yoki WebP, 5 MB gacha. Birinchi rasm — mahsulot kartasidagi asosiy rasm.</p>
          </section>
        )}
      </div>

      <div className="sticky bottom-0 mt-4 space-y-2 bg-gradient-to-t from-ivory via-ivory/95 to-transparent pb-3 pt-4" style={{ paddingBottom: 'calc(var(--safe-bottom) + 12px)' }}>
        {act.error && <Notice>{act.error}</Notice>}
        {ok && <Notice kind="ok">{A.saved}{product ? ` · ${uzs(product.price)}` : ''}</Notice>}
        <Btn busy={act.busy} disabled={!valid} onClick={() => void save()} className="w-full" data-testid="p-save">{act.busy ? A.saving : isNew ? "Mahsulotni yaratish" : A.save}</Btn>
      </div>
    </div>
  )
}
