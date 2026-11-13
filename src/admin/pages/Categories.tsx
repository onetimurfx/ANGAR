import { useEffect, useState } from 'react'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { BottomSheet } from '../../components/BottomSheet'
import { aGet, aPost } from '../api'
import { useMe } from '../AdminApp'
import { useAction, useRes } from '../hooks'
import { A } from '../text'
import type { Brand, Category } from '../types'
import { Badge, Btn, ErrorBox, Field, Input, Loading, Notice, Select, card } from '../ui'
import { PageTitle } from './common'

type Editing = { kind: 'category'; item: Category | null } | { kind: 'brand'; item: Brand | null } | null

export function Categories() {
  const me = useMe()
  const cats = useRes(() => aGet<{ categories: Category[] }>('categories'), [])
  const brands = useRes(() => aGet<{ brands: Brand[] }>('brands'), [])
  const [edit, setEdit] = useState<Editing>(null)
  const done = () => { setEdit(null); cats.reload(); brands.reload() }

  if ((cats.loading && !cats.data) || (brands.loading && !brands.data)) return <Loading />
  if (cats.error || brands.error || !cats.data || !brands.data) return <ErrorBox message={(cats.error ?? brands.error)!} onRetry={() => { cats.reload(); brands.reload() }} />

  return (
    <div data-testid="admin-categories" className="space-y-6">
      <section>
        <PageTitle title={A.nav.categories} right={<Btn onClick={() => setEdit({ kind: 'category', item: null })} data-testid="cat-new"><Plus className="size-4" />Yangi</Btn>} />
        <div className="space-y-2">
          {cats.data.categories.map((c) => (
            <button key={c.id} type="button" data-testid="cat-row" onClick={() => setEdit({ kind: 'category', item: c })} className={`${card} flex w-full items-center gap-3 !p-3.5 text-left`}>
              <div className="min-w-0 flex-1"><p className="truncate text-[14px] font-bold">{c.name}</p><p className="text-[12px] text-stone">{c.activeProductCount} faol / {c.productCount} mahsulot · tartib {c.sortOrder}</p></div>
              <Badge tone={c.active ? 'on' : 'off'}>{c.active ? 'Faol' : 'Yashirin'}</Badge><Pencil className="size-4 text-stone" />
            </button>
          ))}
        </div>
      </section>
      <section>
        <PageTitle title="Brendlar" right={<Btn onClick={() => setEdit({ kind: 'brand', item: null })} data-testid="brand-new"><Plus className="size-4" />Yangi</Btn>} />
        <div className="space-y-2">
          {brands.data.brands.map((b) => (
            <button key={b.id} type="button" data-testid="brand-row" onClick={() => setEdit({ kind: 'brand', item: b })} className={`${card} flex w-full items-center gap-3 !p-3.5 text-left`}>
              <div className="min-w-0 flex-1"><p className="truncate text-[14px] font-bold">{b.name}</p><p className="text-[12px] text-stone">{b.type === 'original' ? 'Original (ANGAR)' : 'Boshqa brend'} · {b.activeProductCount}/{b.productCount} mahsulot</p></div>
              <Badge tone={b.active ? 'on' : 'off'}>{b.active ? 'Faol' : 'Yashirin'}</Badge><Pencil className="size-4 text-stone" />
            </button>
          ))}
        </div>
      </section>
      <EditSheet edit={edit} owner={me.role === 'owner'} onClose={() => setEdit(null)} onDone={done} />
    </div>
  )
}

function EditSheet({ edit, owner, onClose, onDone }: { edit: Editing; owner: boolean; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState('')
  const [sort, setSort] = useState('0')
  const [type, setType] = useState<'original' | 'other'>('other')
  const [active, setActive] = useState(true)
  const [confirmDel, setConfirmDel] = useState(false)
  const act = useAction()
  useEffect(() => {
    setConfirmDel(false); act.setError(null)
    if (!edit) return
    setName(edit.item?.name ?? ''); setActive(edit.item?.active ?? true)
    setSort(edit.kind === 'category' ? String(edit.item?.sortOrder ?? 0) : '0')
    setType(edit.kind === 'brand' ? (edit.item?.type ?? 'other') : 'other')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edit])
  if (!edit) return <BottomSheet open={false} onClose={onClose} title="" children={null} />

  const isCat = edit.kind === 'category'
  const save = () => act.run(async () => {
    if (isCat) await aPost('category', { action: 'save', id: edit.item?.id ?? null, name: name.trim(), sortOrder: Number(sort) || 0, active })
    else await aPost('brand', { action: 'save', id: edit.item?.id ?? null, name: name.trim(), type, active })
    onDone()
  })
  const del = () => act.run(async () => { await aPost('category', { action: 'delete', id: edit.item!.id }); onDone() })
  return (
    <BottomSheet open onClose={onClose} title={`${isCat ? 'Kategoriya' : 'Brend'}${edit.item ? '' : ' (yangi)'}`}
      footer={<div className="flex gap-2">
        {isCat && edit.item && owner && !confirmDel && <Btn kind="danger" onClick={() => setConfirmDel(true)} aria-label="O'chirish" data-testid="cat-delete"><Trash2 className="size-4" /></Btn>}
        {confirmDel ? <><Btn kind="ghost" onClick={() => setConfirmDel(false)} className="flex-1">{A.cancel}</Btn><Btn busy={act.busy} onClick={() => void del()} className="flex-1" data-testid="cat-delete-confirm">O'chirishni tasdiqlash</Btn></>
          : <Btn busy={act.busy} disabled={name.trim().length === 0} onClick={() => void save()} className="flex-1" data-testid="cat-save">{A.save}</Btn>}
      </div>}>
      <div className="space-y-3 pb-2">
        {act.error && <Notice>{act.error}</Notice>}
        <Field label="Nomi"><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} data-testid="cat-name" /></Field>
        {isCat ? (
          <Field label="Tartib raqami" hint="Kichigi tepada ko'rinadi"><Input inputMode="numeric" value={sort} onChange={(e) => setSort(e.target.value.replace(/\D/g, ''))} maxLength={4} /></Field>
        ) : (
          <Field label="Turi" hint="Mahsulot turi (Original / Boshqa) brendga qarab belgilanadi"><Select value={type} onChange={(e) => setType(e.target.value as 'original' | 'other')}><option value="original">Original (ANGAR)</option><option value="other">Boshqa brend</option></Select></Field>
        )}
        <label className="flex min-h-11 items-center gap-3 text-[14px]"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} className="size-5 accent-[#d94b59]" />Faol (do'konda ko'rinadi)</label>
        {confirmDel && <Notice>Kategoriya butunlay o'chiriladi. Faqat bo'sh kategoriyani o'chirish mumkin.</Notice>}
      </div>
    </BottomSheet>
  )
}
