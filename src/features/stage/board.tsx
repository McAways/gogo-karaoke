import { motion } from 'motion/react'
import { useSyncExternalStore } from 'react'
import { cn } from '@/components/cn'
import { formatPoints } from '@/lib/format'
import type { StageSession } from './session'

/**
 * Placar da sala durante a música. `coluna` fica ao lado da letra, em telas largas;
 * `faixa` é uma linha só, para telas estreitas.
 */
export function Board({ session, layout, className }: { session: StageSession; layout: 'coluna' | 'faixa'; className?: string }) {
  const board = useSyncExternalStore(session.subscribe, () => session.getSnapshot().board)
  if (board.length === 0) return null

  const shown = board.slice(0, layout === 'coluna' ? 6 : 4)
  const hidden = board.length - shown.length
  const leading = board[0].points > 0 ? board[0].name : null

  if (layout === 'faixa') {
    return (
      <ol aria-label="Placar da sala" className={cn('flex gap-x-5 overflow-hidden text-sm whitespace-nowrap', className)}>
        {shown.map((entry, index) => (
          <li key={entry.name} className="flex items-baseline gap-1.5">
            <span className="numeric text-faint">{index + 1}</span>
            <span className="max-w-[10ch] truncate font-semibold">{entry.name}</span>
            <span className={cn('numeric', entry.name === leading ? 'text-accent' : 'text-soft')}>{formatPoints(entry.points)}</span>
          </li>
        ))}
        {hidden > 0 && <li className="text-faint">e mais {hidden}</li>}
      </ol>
    )
  }

  return (
    <aside aria-label="Placar da sala" className={cn('w-60 shrink-0', className)}>
      <p className="text-[13px] font-semibold text-soft">Placar</p>
      <ol className="mt-3 space-y-2">
        {shown.map((entry, index) => (
          // Quando alguém passa outro, a linha desliza até o novo lugar em vez de pular.
          <motion.li key={entry.name} layout="position" transition={{ type: 'spring', stiffness: 420, damping: 38 }} className="flex items-baseline gap-3">
            <span className="numeric w-4 shrink-0 text-sm text-faint">{index + 1}</span>
            <span className="min-w-0 flex-1 truncate text-lg font-semibold">{entry.name}</span>
            <span className={cn('numeric text-lg', entry.name === leading ? 'text-accent' : 'text-soft')}>{formatPoints(entry.points)}</span>
          </motion.li>
        ))}
      </ol>
      {hidden > 0 && <p className="mt-2 text-sm text-faint">e mais {hidden}</p>}
    </aside>
  )
}
