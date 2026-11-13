import type { ReactNode } from 'react'

export const PageTitle = ({ title, right }: { title: string; right?: ReactNode }) => (
  <div className="mb-3 flex items-center justify-between gap-3">
    <h1 className="text-2xl">{title}</h1>
    {right}
  </div>
)
