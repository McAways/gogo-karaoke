import { Slot, Tooltip as RTooltip } from 'radix-ui'
import type { ComponentProps, ReactNode } from 'react'
import { cn } from './cn'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'
type Size = 'sm' | 'md' | 'lg'

const BASE =
  'inline-flex shrink-0 items-center justify-center gap-2 rounded-full font-semibold whitespace-nowrap select-none ' +
  'transition-[transform,background-color,border-color,color,opacity,filter] duration-200 ease-expo ' +
  'active:scale-[0.97] disabled:pointer-events-none disabled:opacity-45'

const VARIANT: Record<Variant, string> = {
  primary: 'bg-accent text-on-accent border border-on-accent/20 hover:brightness-[1.06]',
  secondary: 'bg-raised text-ink border border-hairline hover:border-faint',
  ghost: 'text-soft hover:text-ink hover:bg-ink/8',
  danger: 'bg-danger/10 text-danger border border-danger/35 hover:bg-danger/18',
}

const SIZE: Record<Size, string> = {
  sm: 'h-9 px-3.5 text-[13px]',
  md: 'h-11 px-5 text-sm',
  lg: 'h-14 px-7 text-base',
}

type ButtonProps = ComponentProps<'button'> & {
  variant?: Variant
  size?: Size
  /** Renderiza o filho (um Link, por exemplo) com a aparência do botão. */
  asChild?: boolean
}

export function Button({ variant = 'secondary', size = 'md', asChild = false, className, type, ...props }: ButtonProps) {
  const classes = cn(BASE, VARIANT[variant], SIZE[size], className)
  if (asChild) return <Slot.Root className={classes} {...props} />
  return <button type={type ?? 'button'} className={classes} {...props} />
}

export function Tooltip({ label, children, side = 'top' }: { label: string; children: ReactNode; side?: 'top' | 'bottom' | 'left' | 'right' }) {
  return (
    <RTooltip.Root>
      <RTooltip.Trigger asChild>{children}</RTooltip.Trigger>
      <RTooltip.Portal>
        <RTooltip.Content
          side={side}
          sideOffset={8}
          className="z-70 rounded-full border border-hairline bg-ink px-3 py-1.5 text-xs font-medium text-canvas data-[state=delayed-open]:animate-fade-in"
        >
          {label}
        </RTooltip.Content>
      </RTooltip.Portal>
    </RTooltip.Root>
  )
}

type IconButtonProps = Omit<ComponentProps<'button'>, 'aria-label'> & {
  /** Vira o nome acessível e a dica ao passar o mouse. */
  label: string
  variant?: Variant
  size?: 'sm' | 'md' | 'lg'
  tooltipSide?: 'top' | 'bottom' | 'left' | 'right'
}

const ICON_SIZE = { sm: 'size-9', md: 'size-11', lg: 'size-14' }

export function IconButton({ label, variant = 'ghost', size = 'md', tooltipSide, className, type, ...props }: IconButtonProps) {
  return (
    <Tooltip label={label} side={tooltipSide}>
      <button type={type ?? 'button'} aria-label={label} className={cn(BASE, VARIANT[variant], ICON_SIZE[size], 'px-0', className)} {...props} />
    </Tooltip>
  )
}

export const TooltipProvider = RTooltip.Provider
