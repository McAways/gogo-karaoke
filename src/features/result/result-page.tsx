import { ArrowCounterClockwiseIcon, MicrophoneStageIcon } from '@phosphor-icons/react'
import { animate, useMotionValue, useMotionValueEvent } from 'motion/react'
import { useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router'
import { Button } from '@/components/button'
import { Cover } from '@/components/cover'
import { formatPercent, formatPoints } from '@/lib/format'
import { gradeFor } from '@/lib/scoring/engine'
import { getLyrics, getScore, listScores } from '@/lib/storage/db'
import type { ScoreRecord } from '@/lib/types'
import { DIFFICULTY_LABEL } from '@/features/song/song-page'
import { useQueuedSongs } from '@/features/queue/queue-page'
import { useLibrary, useSong } from '@/state/library'
import { LineChart } from './line-chart'

/** A nota sobe de zero até o valor final: dá peso ao momento do resultado. */
function CountUp({ value }: { value: number }) {
  const ref = useRef<HTMLSpanElement>(null)
  const count = useMotionValue(0)

  useEffect(() => {
    const controls = animate(count, value, { duration: 1.4, ease: [0.16, 1, 0.3, 1] })
    return () => controls.stop()
  }, [count, value])
  useMotionValueEvent(count, 'change', (latest) => {
    if (ref.current) ref.current.textContent = formatPoints(latest)
  })

  return (
    <span ref={ref} aria-label={`${formatPoints(value)} pontos`} className="display block text-[clamp(4.5rem,15vw,12rem)] leading-[0.9]">
      0
    </span>
  )
}

export function ResultPage() {
  const { scoreId } = useParams()
  const [score, setScore] = useState<ScoreRecord | null | 'missing'>(null)
  const [texts, setTexts] = useState<string[]>([])
  /** As notas da mesma apresentação, da maior para a menor. Só existe quando a música foi cantada com a sala. */
  const [round, setRound] = useState<ScoreRecord[]>([])
  const libraryStatus = useLibrary((state) => state.status)
  const song = useSong(score && score !== 'missing' ? score.songId : undefined)
  const nextInQueue = useQueuedSongs()[0]?.song

  useEffect(() => {
    let alive = true
    const id = Number(scoreId)
    if (!Number.isInteger(id)) return setScore('missing')
    void getScore(id).then(async (record) => {
      if (!alive) return
      if (!record) return setScore('missing')
      setScore(record)
      const [lyrics, others] = await Promise.all([getLyrics(record.songId), record.round ? listScores(record.songId) : []])
      if (!alive) return
      setTexts(lyrics?.lines.map((line) => line.text) ?? [])
      setRound(others.filter((other) => other.round === record.round).sort((a, b) => b.points - a.points))
    })
    return () => {
      alive = false
    }
  }, [scoreId])

  if (score === null || libraryStatus === 'loading') {
    return (
      <div aria-busy="true">
        <div className="skeleton h-5 w-32 rounded-full" />
        <div className="skeleton mt-6 h-40 w-full max-w-xl rounded-card" />
      </div>
    )
  }

  if (score === 'missing') {
    return (
      <section className="flex min-h-[60dvh] flex-col items-start justify-center">
        <h1 className="display text-4xl md:text-5xl">Resultado não encontrado.</h1>
        <p className="mt-4 text-lg text-soft">Essa nota não está mais no histórico.</p>
        <Button asChild variant="primary" className="mt-7">
          <Link to="/">Ir para a biblioteca</Link>
        </Button>
      </section>
    )
  }

  const grade = gradeFor(score.points)
  const isRecord = song?.bestScore !== undefined && score.points >= song.bestScore && score.points > 0
  const goodLines = score.lines.filter((ratio) => ratio >= 0.4).length
  const place = round.length > 1 ? round.findIndex((entry) => entry.id === score.id) + 1 : 0

  return (
    <>
      <div className="grid items-end gap-x-14 gap-y-10 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <section>
          {score.singer && <p className="display mb-4 text-3xl md:text-4xl">{score.singer}</p>}
          <p className="text-lg font-semibold text-accent-ink">
            {grade.label}
            {place > 0 && (
              <span className="ml-3 text-soft">
                {place}º lugar de {round.length}
              </span>
            )}
            {isRecord && <span className="ml-3 text-soft">{score.singer ? 'Recorde nesta música' : 'Seu recorde nesta música'}</span>}
          </p>
          <h1 className="mt-2">
            <CountUp value={score.points} />
          </h1>
          <p className="mt-4 max-w-[44ch] text-xl text-soft">{grade.detail}</p>
          {nextInQueue && (
            <p className="mt-3 text-soft">
              A seguir na fila: <span className="font-semibold text-ink">{nextInQueue.title}</span>
              {nextInQueue.artist ? `, de ${nextInQueue.artist}` : ''}.
            </p>
          )}

          <div className="mt-8 flex flex-wrap gap-2">
            {nextInQueue && (
              <Button asChild variant="primary" size="lg">
                <Link to={`/cantar/${nextInQueue.id}`}>
                  <MicrophoneStageIcon size={20} weight="fill" />
                  Próxima da fila
                </Link>
              </Button>
            )}
            <Button asChild variant={nextInQueue ? 'secondary' : 'primary'} size="lg">
              <Link to={`/cantar/${score.songId}`}>
                <ArrowCounterClockwiseIcon size={20} weight="bold" />
                Cantar de novo
              </Link>
            </Button>
            <Button asChild variant="ghost" size="lg">
              <Link to="/">Biblioteca</Link>
            </Button>
          </div>
        </section>

        <section className="lg:pb-2">
          {song && (
            <Link to={`/musica/${song.id}`} className="group flex items-center gap-4">
              <Cover song={song} className="size-20 shrink-0 rounded-card" />
              <div className="min-w-0">
                <p className="truncate text-lg font-semibold group-hover:underline">{song.title}</p>
                <p className="truncate text-soft">{song.artist || 'Artista desconhecido'}</p>
              </div>
            </Link>
          )}
          {round.length > 1 && (
            <section aria-labelledby="round-heading" className="mt-8">
              <h2 id="round-heading" className="text-sm text-faint">
                Placar da rodada
              </h2>
              <ol className="mt-2 space-y-1">
                {round.map((entry, index) => {
                  const row = (
                    <>
                      <span className="numeric w-5 shrink-0 text-sm text-faint">{index + 1}</span>
                      <span className="min-w-0 flex-1 truncate font-semibold">{entry.singer}</span>
                      <span className="numeric text-lg">{formatPoints(entry.points)}</span>
                    </>
                  )
                  return (
                    <li key={entry.id}>
                      {entry.id === score.id ? (
                        <div aria-current="true" className="-mx-3 flex items-baseline gap-3 rounded-field bg-ink/8 px-3 py-2.5">
                          {row}
                        </div>
                      ) : (
                        <Link to={`/resultado/${entry.id}`} className="-mx-3 flex items-baseline gap-3 rounded-field px-3 py-2.5 transition-colors hover:bg-ink/5">
                          {row}
                        </Link>
                      )}
                    </li>
                  )
                })}
              </ol>
            </section>
          )}
          <dl className="mt-8 grid grid-cols-2 gap-x-8 gap-y-6">
            <div>
              <dt className="text-sm text-faint">Acerto</dt>
              <dd className="mt-1 text-3xl font-semibold">{formatPercent(score.accuracy)}</dd>
            </div>
            <div>
              <dt className="text-sm text-faint">Melhor sequência</dt>
              <dd className="mt-1 text-3xl font-semibold">
                {score.bestStreak}
                <span className="ml-1.5 text-base font-normal text-soft">{score.bestStreak === 1 ? 'linha' : 'linhas'}</span>
              </dd>
            </div>
            <div>
              <dt className="text-sm text-faint">Dificuldade</dt>
              <dd className="mt-1 text-lg font-semibold">{DIFFICULTY_LABEL[score.difficulty]}</dd>
            </div>
            <div>
              <dt className="text-sm text-faint">Avaliado por</dt>
              <dd className="mt-1 text-lg font-semibold">{score.mode === 'melodia' ? 'Afinação' : 'Ritmo'}</dd>
            </div>
          </dl>
        </section>
      </div>

      {score.lines.length > 1 && (
        <section aria-labelledby="lines-heading" className="mt-16">
          <h2 id="lines-heading" className="display text-2xl">
            Linha a linha
          </h2>
          <p className="mt-2 text-soft">
            Acerto de cada verso, na ordem da música. {goodLines} de {score.lines.length} {goodLines === 1 ? 'saiu boa' : 'saíram boas'}.
          </p>
          <div className="mt-8">
            <LineChart lines={score.lines} texts={texts} />
          </div>
        </section>
      )}
    </>
  )
}
