import { motion } from 'motion/react'
import { useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { Button } from '@/components/button'
import { cn } from '@/components/cn'
import { formatPercent } from '@/lib/format'
import { RATING_LABEL, ratingFor } from '@/lib/scoring/engine'

/** A partir daqui a linha conta para a sequência ("Bom" ou melhor). */
const GOOD = 0.4

/**
 * Acerto de cada linha da música, na ordem em que foi cantada.
 *
 * Forma: colunas de uma série só, com ênfase (um acento + cinza). A altura já diz o
 * acerto; a cor só separa as linhas que contaram das que não contaram, e por isso
 * vem com legenda. Todo valor também está na versão em lista, sem depender de hover.
 */
export function LineChart({ lines, texts }: { lines: number[]; texts: string[] }) {
  const [selected, setSelected] = useState<number | null>(null)
  const [asList, setAsList] = useState(false)

  const current = selected !== null ? lines[selected] : null
  const bars = useRef<Array<HTMLButtonElement | null>>([])

  // As colunas são uma parada só no Tab; as setas andam entre elas.
  const onKeyDown = (event: KeyboardEvent) => {
    const from = selected ?? 0
    const to =
      event.key === 'ArrowRight' ? from + 1 : event.key === 'ArrowLeft' ? from - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? lines.length - 1 : null
    if (to === null) return
    event.preventDefault()
    bars.current[Math.min(lines.length - 1, Math.max(0, to))]?.focus()
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3 text-sm text-soft">
        <span className="inline-flex items-center gap-2">
          <span className="size-2.5 rounded-[3px] bg-accent-ink" />
          Bom ou melhor
        </span>
        <span className="inline-flex items-center gap-2">
          <span className="size-2.5 rounded-[3px] bg-chart-muted" />
          Abaixo de bom
        </span>
        <Button variant="ghost" size="sm" className="ml-auto" aria-pressed={asList} onClick={() => setAsList(!asList)}>
          {asList ? 'Ver gráfico' : 'Ver em lista'}
        </Button>
      </div>

      {asList ? (
        <div className="mt-5 max-h-[26rem] overflow-y-auto rounded-card bg-surface px-5 py-2">
          <table className="w-full text-left">
            <caption className="sr-only">Acerto de cada linha da música</caption>
            <thead className="text-[13px] text-faint">
              <tr>
                <th scope="col" className="w-10 py-2.5 font-semibold">
                  Nº
                </th>
                <th scope="col" className="py-2.5 font-semibold">
                  Verso
                </th>
                <th scope="col" className="w-24 py-2.5 font-semibold">
                  Avaliação
                </th>
                <th scope="col" className="w-16 py-2.5 text-right font-semibold">
                  Acerto
                </th>
              </tr>
            </thead>
            <tbody>
              {lines.map((ratio, index) => (
                <tr key={index} className="align-baseline">
                  <td className="numeric py-1.5 text-sm text-faint">{index + 1}</td>
                  <td className="py-1.5 pr-4">{texts[index] ?? 'Trecho sem letra'}</td>
                  <td className="py-1.5 text-sm text-soft">{RATING_LABEL[ratingFor(ratio)]}</td>
                  <td className="numeric py-1.5 text-right text-sm">{formatPercent(ratio)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <>
          <div className="mt-5 grid grid-cols-[2.75rem_minmax(0,1fr)] gap-x-2" style={{ maxWidth: `calc(3.25rem + ${lines.length} * 26px)` }}>
            {/* Eixo: três referências bastam para ler a altura. */}
            <div className="numeric flex h-40 flex-col justify-between text-right text-xs text-faint" aria-hidden>
              <span className="-translate-y-1/2">100%</span>
              <span>50%</span>
              <span className="translate-y-1/2">0%</span>
            </div>
            <div className="relative h-40">
              <div className="absolute inset-x-0 top-0 border-t border-hairline/70" aria-hidden />
              <div className="absolute inset-x-0 top-1/2 border-t border-hairline/70" aria-hidden />
              <div className="absolute inset-x-0 bottom-0 border-t border-hairline" aria-hidden />

              <div className="absolute inset-0 flex items-end gap-0.5" onMouseLeave={() => setSelected(null)} onKeyDown={onKeyDown}>
                {lines.map((ratio, index) => (
                  <button
                    key={index}
                    ref={(el) => {
                      bars.current[index] = el
                    }}
                    type="button"
                    tabIndex={index === (selected ?? 0) ? 0 : -1}
                    aria-label={`Linha ${index + 1}: ${RATING_LABEL[ratingFor(ratio)]}, ${formatPercent(ratio)} de acerto`}
                    onMouseEnter={() => setSelected(index)}
                    onFocus={() => setSelected(index)}
                    onBlur={() => setSelected(null)}
                    className="flex h-full max-w-6 min-w-0 flex-1 items-end focus-visible:outline-offset-2"
                  >
                    <motion.span
                      initial={{ scaleY: 0 }}
                      animate={{ scaleY: 1 }}
                      transition={{ duration: 0.6, delay: 0.25 + Math.min(index, 60) * 0.012, ease: [0.16, 1, 0.3, 1] }}
                      // Linha zerada ainda ganha 2px: mostra que existe, sem fingir acerto.
                      style={{ height: `max(2px, ${ratio * 100}%)` }}
                      className={cn(
                        'block w-full origin-bottom rounded-t-[4px] transition-opacity duration-200',
                        ratio >= GOOD ? 'bg-accent-ink' : 'bg-chart-muted',
                        selected !== null && selected !== index && 'opacity-45',
                      )}
                    />
                  </button>
                ))}
              </div>
            </div>
          </div>

          <p className="mt-4 min-h-12 pl-[3.25rem] text-soft" aria-live="polite">
            {selected !== null && current !== null ? (
              <>
                <span className="font-semibold text-ink">
                  Linha {selected + 1}: {RATING_LABEL[ratingFor(current)]}
                </span>
                <span className="numeric ml-2 text-faint">{formatPercent(current)}</span>
                {texts[selected] && <span className="mt-0.5 block truncate">{texts[selected]}</span>}
              </>
            ) : (
              'Passe o mouse pelas colunas, ou use Tab e as setas, para ver cada verso.'
            )}
          </p>
        </>
      )}
    </div>
  )
}
