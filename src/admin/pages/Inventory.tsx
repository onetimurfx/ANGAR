import { useCallback, useEffect, useState } from 'react'
import { Search } from 'lucide-react'
import { BottomSheet } from '../../components/BottomSheet'
import { aGet, aPost } from '../api'
import { useAction, useDebounced } from '../hooks'
import { A, adminError } from '../text'
import type { InventoryRow } from '../types'
import { Badge, Btn, Chips, Empty, ErrorBox, Field, Input, Loading, Notice, Pager, Row } from '../ui'
import { PageTitle } from './common'

interface ListAnswer { items: InventoryRow[]; total: number; threshold: number }
const PAGE = 50

export function Inventory() {
  const [q, setQ] = useState('')
  const dq = useDebounced(q)
  const [filter, setFilter] = useState<'all' | 'low' | 'out'>('all')
  const [rows, setRows] = useState<InventoryRow[]>([])
  const [total, setTotal] = useState(0)
  const [th, setTh] = useState(3)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [sel, setSel] = useState<InventoryRow | null>(null)
  const [tick, setTick] = useState(0)

  const load = useCallback(async (offset: number) => {
    setLoading(true)
    try {
      const r = await aGet<ListAnswer>('inventory', { q: dq, filter, limit: PAGE, offset })
      setRows((p) => (offset === 0 ? r.items : [...p, ...r.items])); setTotal(r.total); setTh(r.threshold); setError(null)
    } catch (e) { setError(adminError(e)) } finally { setLoading(false) }
  }, [dq, filter])
  useEffect(() => { void load(0) }, [load, tick])

  return (
    <div data-testid="admin-inventory">
      <PageTitle title={A.nav.inventory} />
      <p className="-mt-2 mb-3 text-[13px] text-stone">«Mavjud» = omborda − pickup uchun band qilingan. Mijozlar faqat mavjud miqdorni ko'radi.</p>
      <div className="relative mb-3">
        <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-stone" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Mahsulot, rang yoki SKU" aria-label={A.search} className="pl-10" maxLength={100} />
      </div>
      <Chips label="Filtr" value={filter} onChange={setFilter} options={[{ id: 'all', label: A.all }, { id: 'low', label: `Kam (≤ ${th})` }, { id: 'out', label: 'Tugagan' }]} />
      <div className="mt-3 space-y-2">
        {error && <ErrorBox message={error} onRetry={() => setTick((x) => x + 1)} />}
        {!error && loading && rows.length === 0 && <Loading />}
        {!error && !loading && rows.length === 0 && <Empty />}
        {rows.map((r) => (
          <button key={r.variantId} type="button" data-testid="inv-row" onClick={() => setSel(r)} className="glass flex w-full items-center gap-3 rounded-2xl px-4 py-3 text-left active:scale-[0.99]">
            <span className="size-4 shrink-0 rounded-full ring-1 ring-navy/15" style={{ background: r.colorHex }} />
            <div className="min-w-0 flex-1"><p className="truncate text-[14px] font-bold">{r.productName}</p><p className="text-[12px] text-stone">{r.colorName}, {r.size}{r.sku ? ` · ${r.sku}` : ''}{r.active ? '' : ' · yashirin'}</p></div>
            <div className="shrink-0 text-right">
              <Badge tone={r.available === 0 ? 'out' : r.available <= th ? 'low' : 'on'}>{r.available} mavjud</Badge>
              <p className="mt-0.5 text-[11px] text-stone">omborda {r.quantity}{r.reserved ? ` · band ${r.reserved}` : ''}</p>
            </div>
          </button>
        ))}
        {!error && rows.length > 0 && <Pager shown={rows.length} total={total} loading={loading} onMore={() => void load(rows.length)} />}
      </div>
      <AdjustSheet row={sel} onClose={() => setSel(null)} onDone={() => { setSel(null); setTick((x) => x + 1) }} />
    </div>
  )
}

function AdjustSheet({ row, onClose, onDone }: { row: InventoryRow | null; onClose: () => void; onDone: () => void }) {
  const [mode, setMode] = useState<'set' | 'add'>('set')
  const [val, setVal] = useState('')
  const [reason, setReason] = useState('')
  const act = useAction()
  useEffect(() => { setMode('set'); setVal(''); setReason(''); act.setError(null) /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [row?.variantId])
  const n = /^-?\d{1,6}$/.test(val) ? Number(val) : null
  const target = row && n !== null ? (mode === 'set' ? n : row.quantity + n) : null
  const bad = n === null || target === null || target < 0 || (mode === 'set' && n < 0) || (row !== null && target < row.reserved)
  const save = () => act.run(async () => { await aPost('inventory', { action: 'adjust', variantId: row!.variantId, mode, value: n, reason: reason.trim() || null }); onDone() })
  return (
    <BottomSheet open={!!row} onClose={onClose} title={row ? `${row.productName}` : ''}
      footer={<Btn busy={act.busy} disabled={bad} onClick={() => void save()} className="w-full" data-testid="inv-save">{A.save}{target !== null && !bad ? ` → ${target} dona` : ''}</Btn>}>
      {row && (
        <div className="space-y-3 pb-2">
          {act.error && <Notice>{act.error}</Notice>}
          <div className="rounded-2xl bg-white p-3.5"><Row k="Variant">{row.colorName}, {row.size}</Row><Row k="Omborda">{row.quantity}</Row><Row k="Band (pickup)">{row.reserved}</Row><Row k="Mavjud">{row.available}</Row></div>
          <Chips label="Rejim" value={mode} onChange={(m) => { setMode(m); setVal('') }} options={[{ id: 'set', label: 'Sanoq (aniq son)' }, { id: 'add', label: "Qo'shish / ayirish" }]} />
          <Field label={mode === 'set' ? "Omborda aniq nechta?" : "O'zgarish (masalan 5 yoki -2)"} hint={row.reserved > 0 ? `Band qilingan ${row.reserved} dan kam bo'lmasin.` : undefined}>
            <Input inputMode={mode === 'add' ? 'text' : 'numeric'} value={val} onChange={(e) => setVal(e.target.value.replace(mode === 'add' ? /[^\d-]/g : /\D/g, ''))} maxLength={7} data-testid="inv-value" />
          </Field>
          <Field label="Sabab (ixtiyoriy)"><Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} placeholder="Sanoq, yangi partiya, brak…" /></Field>
        </div>
      )}
    </BottomSheet>
  )
}
