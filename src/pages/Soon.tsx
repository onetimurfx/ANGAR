import { Link } from 'react-router-dom'
import { ShoppingBag, Zap } from 'lucide-react'
import { PageHeader, EmptyState, primaryBtn } from '../components/ui'
import { t } from '../i18n'

export function QuickOrder() {
  return (
    <div className="pb-36">
      <PageHeader title={t('quick.title')} />
      <EmptyState
        icon={<Zap className="size-7" fill="currentColor" />}
        title={t('quick.title')}
        hint={t('quick.soon')}
        action={
          <Link to="/katalog" className={primaryBtn}>
            {t('quick.toCatalog')}
          </Link>
        }
      />
    </div>
  )
}

export function Cart() {
  return (
    <div className="pb-36">
      <PageHeader title={t('cart.title')} />
      <EmptyState
        icon={<ShoppingBag className="size-7" />}
        title={t('cart.empty')}
        hint={t('cart.emptyHint')}
        action={
          <Link to="/katalog" className={primaryBtn}>
            {t('cart.toCatalog')}
          </Link>
        }
      />
    </div>
  )
}
