import { motion } from 'motion/react'
import { Slider as RSlider, Switch as RSwitch, ToggleGroup } from 'radix-ui'
import { useId } from 'react'
import type { ComponentProps, ReactNode } from 'react'
import { cn } from './cn'

const INPUT =
  'w-full rounded-field border border-hairline bg-surface px-3.5 text-[15px] text-ink placeholder:text-faint ' +
  'transition-colors duration-200 hover:border-faint focus-visible:border-accent-ink focus-visible:outline-none ' +
  'focus-visible:ring-2 focus-visible:ring-accent-ink/30 disabled:opacity-50'

export function TextInput({ className, ...props }: ComponentProps<'input'>) {
  return <input className={cn(INPUT, 'h-11', className)} {...props} />
}

export function TextArea({ className, ...props }: ComponentProps<'textarea'>) {
  return <textarea className={cn(INPUT, 'py-3 leading-relaxed', className)} {...props} />
}

/** Rótulo acima, ajuda ou erro abaixo. O campo recebe o `id` pelo render prop. */
export function Field({
  label,
  hint,
  error,
  children,
  className,
}: {
  label: string
  hint?: string
  error?: string | null
  children: (props: { id: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean }) => ReactNode
  className?: string
}) {
  const id = useId()
  const noteId = `${id}-note`
  const note = error || hint
  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <label htmlFor={id} className="text-[13px] font-semibold text-soft">
        {label}
      </label>
      {children({ id, 'aria-describedby': note ? noteId : undefined, 'aria-invalid': error ? true : undefined })}
      {note && (
        <p id={noteId} className={cn('text-[13px]', error ? 'text-danger' : 'text-faint')}>
          {note}
        </p>
      )}
    </div>
  )
}

export interface SegmentedOption<T extends string> {
  value: T
  label: string
  icon?: ReactNode
}

/** Escolha única entre poucas opções. A pílula ativa desliza até a opção escolhida. */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
  className,
}: {
  value: T
  onChange: (value: T) => void
  options: Array<SegmentedOption<T>>
  label: string
  className?: string
}) {
  const layoutId = useId()
  return (
    <ToggleGroup.Root
      type="single"
      value={value}
      onValueChange={(next) => next && onChange(next as T)}
      aria-label={label}
      className={cn('inline-flex rounded-full border border-hairline bg-raised p-1', className)}
    >
      {options.map((option) => (
        <ToggleGroup.Item
          key={option.value}
          value={option.value}
          className="relative h-9 flex-1 rounded-full px-4 text-[13px] font-semibold whitespace-nowrap text-soft transition-colors duration-200 hover:text-ink data-[state=on]:text-canvas"
        >
          {value === option.value && (
            <motion.span layoutId={layoutId} className="absolute inset-0 rounded-full bg-ink" transition={{ type: 'spring', stiffness: 520, damping: 42 }} />
          )}
          <span className="relative inline-flex items-center justify-center gap-1.5">
            {option.icon}
            {option.label}
          </span>
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  )
}

export function Slider({
  value,
  onChange,
  onCommit,
  min = 0,
  max = 1,
  step = 0.01,
  label,
  className,
  disabled,
}: {
  value: number
  onChange: (value: number) => void
  onCommit?: (value: number) => void
  min?: number
  max?: number
  step?: number
  label: string
  className?: string
  disabled?: boolean
}) {
  return (
    <RSlider.Root
      value={[value]}
      onValueChange={([next]) => onChange(next)}
      onValueCommit={onCommit ? ([next]) => onCommit(next) : undefined}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      className={cn('relative flex h-6 w-full touch-none items-center select-none data-[disabled]:opacity-40', className)}
    >
      <RSlider.Track className="relative h-1 grow rounded-full bg-ink/20">
        <RSlider.Range className="absolute h-full rounded-full bg-ink" />
      </RSlider.Track>
      <RSlider.Thumb
        aria-label={label}
        className="block size-4 rounded-full bg-ink transition-transform duration-200 ease-expo hover:scale-125 focus-visible:scale-125 focus-visible:outline-offset-4"
      />
    </RSlider.Root>
  )
}

export function Switch({ checked, onChange, label, id }: { checked: boolean; onChange: (checked: boolean) => void; label: string; id?: string }) {
  return (
    <RSwitch.Root
      id={id}
      checked={checked}
      onCheckedChange={onChange}
      aria-label={label}
      className="relative h-7 w-12 shrink-0 rounded-full bg-ink/20 transition-colors duration-200 data-[state=checked]:bg-accent"
    >
      <RSwitch.Thumb className="block size-5 translate-x-1 rounded-full bg-ink transition-transform duration-200 ease-expo data-[state=checked]:translate-x-6 data-[state=checked]:bg-on-accent" />
    </RSwitch.Root>
  )
}
