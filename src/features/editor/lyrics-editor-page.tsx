import { ArrowLeftIcon, ClockCounterClockwiseIcon, MinusIcon, PauseIcon, PlayIcon, PlusIcon, XIcon } from '@phosphor-icons/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { Button, IconButton } from '@/components/button'
import { cn } from '@/components/cn'
import { Field, Segmented, Slider, TextArea } from '@/components/form'
import { formatDuration, formatPreciseTime } from '@/lib/format'
import { applyLyrics } from '@/lib/importer'
import { isTyping, reserveSpaceKey } from '@/lib/keys'
import { buildLines } from '@/lib/lyrics-timing'
import { getLyrics } from '@/lib/storage/db'
import { readFile } from '@/lib/storage/files'
import { useLibrary, useSong } from '@/state/library'
import { toast } from '@/state/toasts'

interface Row {
  text: string
  time: number | null
}

/** Quem marca no ritmo aperta a tecla um pouco depois de ouvir: desconta o reflexo. */
const REACTION = 0.12
const NUDGE = 0.1

function toRows(text: string, previous: Row[] = []): Row[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, i) => ({ text: line, time: previous[i]?.text === line ? previous[i].time : null }))
}

/**
 * Editor de sincronia: cole a letra, dê play e aperte espaço no começo de cada linha.
 * É a saída para músicas que o banco de letras não tem.
 */
export function LyricsEditorPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const song = useSong(id)
  const libraryStatus = useLibrary((state) => state.status)

  const [mode, setMode] = useState<'texto' | 'sincronia'>('texto')
  const [text, setText] = useState('')
  const [rows, setRows] = useState<Row[]>([])
  const [cursor, setCursor] = useState(0)
  const [url, setUrl] = useState<string | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [slow, setSlow] = useState(false)
  const [ready, setReady] = useState(false)

  const media = useRef<HTMLAudioElement>(null)
  const rowEls = useRef<Array<HTMLLIElement | null>>([])
  const songId = song?.id
  const mediaFile = song?.mediaFile

  useEffect(() => {
    if (!songId || !mediaFile) return
    let alive = true
    let objectUrl: string | null = null

    void getLyrics(songId).then((doc) => {
      if (!alive) return
      if (doc && doc.lines.length > 0) {
        const loaded = doc.lines.map((line) => ({ text: line.text, time: line.start }))
        setRows(loaded)
        setText(loaded.map((r) => r.text).join('\n'))
        setMode('sincronia')
      } else if (doc?.plain) {
        setText(doc.plain)
      }
      setReady(true)
    })
    readFile('media', mediaFile)
      .then((file) => {
        if (!alive) return
        objectUrl = URL.createObjectURL(file)
        setUrl(objectUrl)
      })
      .catch(() => alive && setLoadError(true))

    return () => {
      alive = false
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [songId, mediaFile])

  // Posição da música: alguns quadros por segundo bastam para o editor.
  useEffect(() => {
    if (!playing) return
    let raf = 0
    let last = 0
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick)
      if (now - last < 80) return
      last = now
      if (media.current) setTime(media.current.currentTime)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing])

  useEffect(() => {
    if (media.current) media.current.playbackRate = slow ? 0.75 : 1
  }, [slow, url])

  const toggle = useCallback(() => {
    const element = media.current
    if (!element) return
    if (element.paused) void element.play().catch(() => {})
    else element.pause()
  }, [])

  const seek = useCallback((value: number) => {
    if (!media.current) return
    media.current.currentTime = Math.max(0, value)
    setTime(media.current.currentTime)
  }, [])

  const stamp = useCallback(() => {
    const element = media.current
    if (!element || cursor >= rows.length) return
    const at = Math.max(0, element.currentTime - REACTION * element.playbackRate)
    setRows((current) => current.map((row, i) => (i === cursor ? { ...row, time: Math.round(at * 100) / 100 } : row)))
    setCursor((c) => Math.min(rows.length, c + 1))
  }, [cursor, rows.length])

  const undo = useCallback(() => {
    const target = Math.max(0, cursor - 1)
    const previous = rows[target - 1]?.time
    setRows((current) => current.map((row, i) => (i === target ? { ...row, time: null } : row)))
    setCursor(target)
    // Volta um pouco antes da linha anterior, para dar tempo de marcar de novo.
    seek(previous !== null && previous !== undefined ? previous - 1 : 0)
  }, [cursor, rows, seek])

  const nudge = useCallback((index: number, delta: number) => {
    setRows((current) => current.map((row, i) => (i === index && row.time !== null ? { ...row, time: Math.max(0, Math.round((row.time + delta) * 100) / 100) } : row)))
  }, [])

  useEffect(() => {
    if (mode !== 'sincronia') return
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (isTyping(event) || event.ctrlKey || event.metaKey || event.altKey) return

      if (event.key === ' ') {
        event.preventDefault()
        if (media.current?.paused) toggle()
        else stamp()
      } else if (event.key === 'Enter') {
        if (target?.closest('button')) return
        event.preventDefault()
        toggle()
      } else if (event.key === 'Backspace') {
        event.preventDefault()
        undo()
      } else if (event.key === 'ArrowDown') {
        event.preventDefault()
        setCursor((c) => Math.min(rows.length - 1, c + 1))
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        setCursor((c) => Math.max(0, c - 1))
      } else if (event.key === 'ArrowLeft' && !target?.closest('[role="slider"]')) {
        nudge(Math.min(cursor, rows.length - 1), -NUDGE)
      } else if (event.key === 'ArrowRight' && !target?.closest('[role="slider"]')) {
        nudge(Math.min(cursor, rows.length - 1), NUDGE)
      }
    }
    window.addEventListener('keydown', onKey)
    const releaseSpace = reserveSpaceKey()
    return () => {
      window.removeEventListener('keydown', onKey)
      releaseSpace()
    }
  }, [mode, toggle, stamp, undo, nudge, cursor, rows.length])

  // Mantém a linha da vez visível.
  useEffect(() => {
    rowEls.current[Math.min(cursor, rows.length - 1)]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [cursor, rows.length])

  const timedCount = rows.filter((row) => row.time !== null).length
  const sounding = useMemo(() => {
    let found = -1
    rows.forEach((row, i) => {
      if (row.time !== null && row.time <= time) found = i
    })
    return found
  }, [rows, time])

  const outOfOrder = useMemo(() => {
    let last = -Infinity
    for (const row of rows) {
      if (row.time === null) continue
      if (row.time < last) return true
      last = row.time
    }
    return false
  }, [rows])

  const save = async () => {
    if (!song) return
    const cleaned = toRows(text, rows)
    if (cleaned.length === 0) return toast('Cole a letra antes de salvar.', 'erro')

    const source = mode === 'sincronia' ? rows : cleaned
    const timed = source.filter((row): row is { text: string; time: number } => row.time !== null)
    if (timed.length === 0) {
      await applyLyrics({ songId: song.id, lines: [], plain: source.map((r) => r.text).join('\n'), level: 'plain', source: 'manual', updatedAt: Date.now() })
      toast('Letra salva sem sincronia.')
    } else {
      const lines = buildLines(
        timed.map((row) => ({ time: row.time, text: row.text })),
        song.duration,
      )
      await applyLyrics({ songId: song.id, lines, level: 'line', source: 'manual', updatedAt: Date.now() })
      const skipped = source.length - timed.length
      toast(skipped > 0 ? `Letra salva. ${skipped} ${skipped === 1 ? 'linha ficou' : 'linhas ficaram'} de fora por não ter tempo.` : 'Letra sincronizada salva.')
    }
    void navigate(`/musica/${song.id}`)
  }

  if (libraryStatus === 'loading' || (song && !ready)) {
    return (
      <div aria-busy="true" className="space-y-4">
        <div className="skeleton h-10 w-72 rounded-field" />
        <div className="skeleton h-64 w-full max-w-3xl rounded-card" />
      </div>
    )
  }

  if (!song) {
    return (
      <section className="flex min-h-[60dvh] flex-col items-start justify-center">
        <h1 className="display text-4xl md:text-5xl">Música não encontrada.</h1>
        <Button asChild variant="primary" className="mt-7">
          <Link to="/">Ir para a biblioteca</Link>
        </Button>
      </section>
    )
  }

  const goToSync = () => {
    const next = toRows(text, rows)
    if (next.length === 0) return toast('Cole a letra antes de sincronizar.', 'erro')
    setRows(next)
    const firstUntimed = next.findIndex((row) => row.time === null)
    setCursor(firstUntimed === -1 ? 0 : firstUntimed)
    setMode('sincronia')
  }

  return (
    <>
      <Link to={`/musica/${song.id}`} className="inline-flex items-center gap-2 text-sm font-semibold text-soft transition-colors hover:text-ink">
        <ArrowLeftIcon size={16} weight="bold" />
        {song.title}
      </Link>

      <div className="mt-5 flex flex-wrap items-end gap-x-6 gap-y-4">
        <h1 className="display text-4xl md:text-5xl">Sincronizar letra</h1>
        <Segmented
          label="Etapa"
          value={mode}
          onChange={(value) => (value === 'sincronia' ? goToSync() : setMode('texto'))}
          options={[
            { value: 'texto', label: 'Texto' },
            { value: 'sincronia', label: 'Sincronia' },
          ]}
        />
        <Button variant="primary" className="ml-auto" onClick={() => void save()}>
          Salvar letra
        </Button>
      </div>

      {/* Só o áudio interessa aqui, mesmo quando a música é um vídeo. */}
      {url && (
        <audio
          ref={media}
          src={url}
          preload="auto"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
          onError={() => setLoadError(true)}
        />
      )}

      {mode === 'texto' ? (
        <div className="mt-8 max-w-3xl">
          <Field label="Letra da música" hint="Uma linha por verso, do jeito que deve aparecer na tela. Linhas em branco são ignoradas.">
            {(field) => (
              <TextArea {...field} value={text} onChange={(event) => setText(event.target.value)} rows={18} spellCheck={false} placeholder={'Quando a noite cai na cidade\nEu procuro a tua voz'} />
            )}
          </Field>
          <Button className="mt-5" onClick={goToSync}>
            Continuar para a sincronia
          </Button>
        </div>
      ) : (
        <div className="mt-8 grid gap-x-12 gap-y-8 lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)]">
          <aside className="lg:sticky lg:top-24 lg:self-start">
            <div className="rounded-card border border-hairline bg-surface p-5">
              {loadError ? (
                <p className="text-sm text-danger">O áudio desta música não abriu. Sem ele não dá para marcar os tempos.</p>
              ) : (
                <>
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      aria-label={playing ? 'Pausar' : 'Tocar'}
                      onClick={toggle}
                      disabled={!url}
                      className="flex size-14 shrink-0 items-center justify-center rounded-full bg-ink text-canvas transition-transform duration-200 ease-expo hover:scale-105 active:scale-95 disabled:opacity-40"
                    >
                      {playing ? <PauseIcon size={24} weight="fill" /> : <PlayIcon size={24} weight="fill" />}
                    </button>
                    <IconButton label="Voltar 5 segundos" variant="secondary" onClick={() => seek(time - 5)}>
                      <ClockCounterClockwiseIcon size={20} />
                    </IconButton>
                    <p className="numeric ml-auto text-right text-lg">
                      {formatPreciseTime(time)}
                      <span className="block text-sm text-faint">{formatDuration(song.duration)}</span>
                    </p>
                  </div>
                  <Slider label="Posição na música" className="mt-4" value={Math.min(time, song.duration || time)} max={Math.max(1, song.duration)} step={0.1} onChange={seek} />
                  <div className="mt-4 flex items-center justify-between gap-3">
                    <span className="text-[13px] font-semibold text-soft">Velocidade</span>
                    <Segmented
                      label="Velocidade"
                      value={slow ? 'lenta' : 'normal'}
                      onChange={(value) => setSlow(value === 'lenta')}
                      options={[
                        { value: 'normal', label: 'Normal' },
                        { value: 'lenta', label: '75%' },
                      ]}
                    />
                  </div>
                </>
              )}
            </div>

            <Button variant="primary" size="lg" className="mt-4 w-full" disabled={!playing || cursor >= rows.length} onClick={stamp}>
              Marcar linha
            </Button>

            <dl className="mt-6 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
              <dt className="numeric text-ink">Espaço</dt>
              <dd className="text-soft">toca; durante a música, marca a linha da vez</dd>
              <dt className="numeric text-ink">Backspace</dt>
              <dd className="text-soft">desfaz a última marcação e volta um pouco</dd>
              <dt className="numeric text-ink">Setas</dt>
              <dd className="text-soft">para cima e para baixo escolhem a linha; para os lados ajustam o tempo</dd>
            </dl>
          </aside>

          <section aria-label="Linhas da letra">
            <p className="text-soft">
              <span className="numeric text-ink">{timedCount}</span> de <span className="numeric text-ink">{rows.length}</span> linhas com tempo.
              {outOfOrder && <span className="ml-2 text-danger">Há tempos fora de ordem: confira as linhas em vermelho.</span>}
            </p>
            <ol className="mt-4 space-y-1">
              {rows.map((row, i) => {
                const isCursor = i === cursor
                const previousTime = rows.slice(0, i).reduce<number | null>((last, r) => r.time ?? last, null)
                const wrong = row.time !== null && previousTime !== null && row.time < previousTime
                return (
                  <li
                    key={i}
                    ref={(el) => {
                      rowEls.current[i] = el
                    }}
                    className={cn(
                      'flex items-center gap-2 rounded-field border py-1.5 pr-1.5 pl-3 transition-colors duration-200',
                      isCursor ? 'border-accent-ink bg-accent/12' : 'border-transparent hover:bg-ink/5',
                    )}
                  >
                    <button type="button" onClick={() => setCursor(i)} className="flex min-w-0 flex-1 items-baseline gap-4 py-1.5 text-left">
                      <span className={cn('numeric w-[4.5rem] shrink-0 text-sm', wrong ? 'text-danger' : row.time === null ? 'text-faint' : 'text-soft')}>
                        {row.time === null ? 'sem tempo' : formatPreciseTime(row.time)}
                      </span>
                      <span className={cn('min-w-0 truncate text-[17px]', i === sounding ? 'font-semibold text-accent-ink' : isCursor ? 'font-semibold' : '')}>{row.text}</span>
                    </button>
                    {row.time !== null && isCursor && (
                      <div className="flex shrink-0 items-center">
                        <IconButton label="Um décimo mais cedo" size="sm" onClick={() => nudge(i, -NUDGE)}>
                          <MinusIcon size={14} weight="bold" />
                        </IconButton>
                        <IconButton label="Um décimo mais tarde" size="sm" onClick={() => nudge(i, NUDGE)}>
                          <PlusIcon size={14} weight="bold" />
                        </IconButton>
                        <IconButton
                          label="Tirar o tempo"
                          size="sm"
                          onClick={() => setRows((current) => current.map((r, k) => (k === i ? { ...r, time: null } : r)))}
                        >
                          <XIcon size={14} weight="bold" />
                        </IconButton>
                        <IconButton label="Ouvir a partir daqui" size="sm" onClick={() => seek((row.time ?? 0) - 0.5)}>
                          <PlayIcon size={14} weight="fill" />
                        </IconButton>
                      </div>
                    )}
                  </li>
                )
              })}
            </ol>
          </section>
        </div>
      )}
    </>
  )
}
