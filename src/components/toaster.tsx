import { CheckCircleIcon, WarningCircleIcon } from '@phosphor-icons/react'
import { AnimatePresence, motion } from 'motion/react'
import { useToasts } from '@/state/toasts'

export function Toaster() {
  const toasts = useToasts((state) => state.toasts)
  const dismiss = useToasts((state) => state.dismiss)

  return (
    <div aria-live="polite" className="pointer-events-none fixed inset-x-0 top-4 z-60 flex flex-col items-center gap-2 px-4">
      <AnimatePresence>
        {toasts.map((toast) => (
          <motion.button
            key={toast.id}
            layout
            type="button"
            onClick={() => dismiss(toast.id)}
            initial={{ opacity: 0, y: -12, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, scale: 0.97 }}
            transition={{ type: 'spring', stiffness: 420, damping: 34 }}
            className="pointer-events-auto flex max-w-[min(92vw,520px)] items-center gap-2.5 rounded-full border border-hairline bg-ink py-2.5 pr-5 pl-3.5 text-left text-sm font-medium text-canvas shadow-[var(--shadow)]"
          >
            {toast.tone === 'erro' ? <WarningCircleIcon size={20} weight="fill" className="shrink-0" /> : <CheckCircleIcon size={20} weight="fill" className="shrink-0" />}
            <span>{toast.text}</span>
          </motion.button>
        ))}
      </AnimatePresence>
    </div>
  )
}
