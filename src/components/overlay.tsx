import { Dialog as RDialog, DropdownMenu } from 'radix-ui'
import type { ReactNode } from 'react'
import { cn } from './cn'

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  wide = false,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: string
  children?: ReactNode
  footer?: ReactNode
  wide?: boolean
}) {
  return (
    <RDialog.Root open={open} onOpenChange={onOpenChange}>
      <RDialog.Portal>
        <RDialog.Overlay className="fixed inset-0 z-40 bg-[oklch(0.1_0.008_115/0.62)] data-[state=open]:animate-fade-in" />
        <RDialog.Content
          className={cn(
            'fixed top-1/2 left-1/2 z-50 max-h-[88dvh] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-card border border-hairline bg-surface p-6 shadow-[var(--shadow)] data-[state=open]:animate-pop-in',
            wide ? 'w-[min(94vw,640px)]' : 'w-[min(92vw,440px)]',
          )}
        >
          <RDialog.Title className="display text-xl">{title}</RDialog.Title>
          {description && <RDialog.Description className="mt-2 text-sm text-soft">{description}</RDialog.Description>}
          {children && <div className="mt-5">{children}</div>}
          {footer && <div className="mt-6 flex flex-wrap justify-end gap-2">{footer}</div>}
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  )
}

export function Menu({ trigger, children, align = 'end' }: { trigger: ReactNode; children: ReactNode; align?: 'start' | 'end' }) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>{trigger}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align={align}
          sideOffset={8}
          className="z-50 min-w-52 rounded-card border border-hairline bg-surface p-1.5 shadow-[var(--shadow)] data-[state=open]:animate-pop-in"
        >
          {children}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

export function MenuItem({
  icon,
  children,
  onSelect,
  danger = false,
  disabled,
}: {
  icon?: ReactNode
  children: ReactNode
  onSelect: () => void
  danger?: boolean
  disabled?: boolean
}) {
  return (
    <DropdownMenu.Item
      onSelect={onSelect}
      disabled={disabled}
      className={cn(
        'flex h-10 cursor-pointer items-center gap-2.5 rounded-full px-3.5 text-sm font-medium outline-none select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-40 data-[highlighted]:bg-ink/8',
        danger ? 'text-danger' : 'text-ink',
      )}
    >
      {icon}
      {children}
    </DropdownMenu.Item>
  )
}
