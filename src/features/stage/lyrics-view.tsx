import { MusicNotesIcon } from '@phosphor-icons/react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { cn } from '@/components/cn'
import { lineIndexAt } from '@/lib/lyrics-timing'
import type { LyricLine } from '@/lib/types'
import type { StageSession } from './session'

/** Pausas instrumentais a partir deste tamanho ganham contagem regressiva. */
const INTERLUDE_SECONDS = 7
/** A linha continua em destaque por este tempo depois de acabar. */
const LINGER = 0.5
/** Onde a linha em foco fica na altura da área de letra (0 = topo, 1 = base). */
const ANCHOR = 0.36

/**
 * Letra do palco. O React só re-renderiza quando a linha em foco muda; o
 * preenchimento das palavras é feito a cada quadro mudando a variável CSS --p.
 */
export function LyricsView({ session, lines, className }: { session: StageSession | null; lines: LyricLine[]; className?: string }) {
  const viewport = useRef<HTMLDivElement>(null)
  const column = useRef<HTMLDivElement>(null)
  const lineEls = useRef<Array<HTMLParagraphElement | null>>([])
  const wordEls = useRef<Array<Array<HTMLSpanElement | null>>>([])
  const interludeEls = useRef<Array<HTMLDivElement | null>>([])
  const lastFill = useRef<number[]>([])

  // `focus` é a linha centralizada; `singing` diz se ela está sendo cantada agora.
  const [focus, setFocus] = useState(lines.length > 0 ? 0 : -1)
  const [singing, setSinging] = useState(false)
  const focusRef = useRef(focus)
  const singingRef = useRef(singing)

  const interludes = useMemo(
    () => lines.map((line, i) => line.start - (i > 0 ? lines[i - 1].end : 0) >= INTERLUDE_SECONDS),
    [lines],
  )

  useEffect(() => {
    if (!session) return
    return session.onFrame(({ lyricTime }) => {
      const started = lineIndexAt(lines, lyricTime)
      const isSinging = started >= 0 && lyricTime <= lines[started].end + LINGER
      const nextFocus = isSinging ? started : Math.min(lines.length - 1, started + 1)

      if (nextFocus !== focusRef.current) {
        focusRef.current = nextFocus
        lastFill.current = []
        setFocus(nextFocus)
      }
      if (isSinging !== singingRef.current) {
        singingRef.current = isSinging
        setSinging(isSinging)
      }

      if (isSinging) {
        const words = lines[started].words
        const els = wordEls.current[started]
        if (els) {
          for (let w = 0; w < words.length; w++) {
            const word = words[w]
            const p = lyricTime <= word.start ? 0 : lyricTime >= word.end ? 1 : (lyricTime - word.start) / (word.end - word.start)
            // Só toca no DOM quando o valor muda de verdade.
            if (Math.abs(p - (lastFill.current[w] ?? -1)) > 0.004) {
              lastFill.current[w] = p
              els[w]?.style.setProperty('--p', p.toFixed(3))
            }
          }
        }
      }

      const interlude = interludeEls.current[nextFocus]
      if (interlude && !isSinging) {
        const remaining = lines[nextFocus].start - lyricTime
        const label = interlude.querySelector<HTMLElement>('[data-count]')
        const bar = interlude.querySelector<HTMLElement>('[data-bar]')
        if (label) label.textContent = remaining > 0 ? `${Math.ceil(remaining)} s` : ''
        // A barra esvazia nos últimos 4 segundos: é a deixa para respirar e entrar.
        if (bar) bar.style.transform = `scaleX(${Math.min(1, Math.max(0, remaining / 4)).toFixed(3)})`
      }
    })
  }, [session, lines])

  // Rola a coluna até a linha em foco. Lê o layout só quando o foco muda.
  useLayoutEffect(() => {
    const place = () => {
      const el = lineEls.current[focus]
      if (!el || !viewport.current || !column.current) return
      const y = viewport.current.clientHeight * ANCHOR - (el.offsetTop + el.offsetHeight / 2)
      column.current.style.transform = `translate3d(0, ${Math.round(y)}px, 0)`
    }
    place()
    if (!viewport.current) return
    const observer = new ResizeObserver(place)
    observer.observe(viewport.current)
    return () => observer.disconnect()
  }, [focus, lines])

  return (
    <div
      ref={viewport}
      className={cn('relative overflow-hidden [mask-image:linear-gradient(to_bottom,transparent,black_14%,black_70%,transparent)]', className)}
    >
      <div ref={column} className="transition-transform duration-700 ease-expo">
        {lines.map((line, i) => {
          const state = i === focus ? (singing ? 'active' : 'next') : i < focus ? 'past' : i === focus + 1 && singing ? 'next' : 'future'
          return (
            <div key={i}>
              {interludes[i] && (
                <div
                  ref={(el) => {
                    interludeEls.current[i] = el
                  }}
                  aria-hidden
                  className={cn(
                    'flex h-10 items-center gap-3 text-soft transition-opacity duration-500',
                    i === focus && !singing ? 'opacity-100' : 'opacity-0',
                  )}
                >
                  <MusicNotesIcon size={22} weight="fill" />
                  <span data-bar className="block h-1 w-24 origin-left rounded-full bg-accent" />
                  <span data-count className="numeric text-base" />
                </div>
              )}
              <p
                ref={(el) => {
                  lineEls.current[i] = el
                }}
                data-state={state}
                className="lyric-line pb-[0.5em] text-[clamp(1.7rem,4.3vw,4.2rem)] leading-[1.1] font-[780] tracking-[-0.02em] [font-stretch:88%]"
              >
                {line.words.map((word, w) => (
                  <span key={w}>
                    {w > 0 && !word.glue && ' '}
                    <span
                      ref={(el) => {
                        ;(wordEls.current[i] ??= [])[w] = el
                      }}
                      className="lyric-word"
                    >
                      {word.text}
                    </span>
                  </span>
                ))}
              </p>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** Letra sem tempos: fica parada na tela, para acompanhar rolando. */
export function PlainLyrics({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cn('overflow-y-auto pr-4 [mask-image:linear-gradient(to_bottom,transparent,black_8%,black_86%,transparent)]', className)}>
      <div className="py-10 text-[clamp(1.25rem,2.4vw,2rem)] leading-snug font-semibold text-ink/85 [font-stretch:92%]">
        {text.split(/\r?\n/).map((line, i) => (
          <p key={i} className={line.trim() ? '' : 'h-[0.8em]'}>
            {line}
          </p>
        ))}
      </div>
    </div>
  )
}
