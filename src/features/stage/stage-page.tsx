import { ArrowLeftIcon } from '@phosphor-icons/react'
import { AnimatePresence, motion, useMotionValueEvent, useSpring } from 'motion/react'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { Button, IconButton } from '@/components/button'
import { cn } from '@/components/cn'
import { useCoverUrl } from '@/components/cover'
import { MicInput } from '@/lib/audio/mic'
import { formatPoints } from '@/lib/format'
import { isTyping, reserveSpaceKey } from '@/lib/keys'
import { RATING_LABEL } from '@/lib/scoring/engine'
import type { LineResult } from '@/lib/scoring/engine'
import { buildReference } from '@/lib/scoring/reference'
import { addScore, getLyrics, getMelody } from '@/lib/storage/db'
import { readFile } from '@/lib/storage/files'
import type { LyricsDoc, MelodyDoc } from '@/lib/types'
import { useLibrary, useSong } from '@/state/library'
import { useParty } from '@/state/party'
import { useQueue } from '@/state/queue'
import { useSettings } from '@/state/settings'
import { toast } from '@/state/toasts'
import { Board } from './board'
import { LyricsView, PlainLyrics } from './lyrics-view'
import { PitchLane } from './pitch-lane'
import { PreStage } from './pre-stage'
import { StageSession } from './session'
import { OFFSET_STEP, Transport } from './transport'

interface StageData {
  lyrics: LyricsDoc | null
  melody: MelodyDoc | null
  url: string
  /** Endereços das faixas separadas, quando a música tem. */
  stems: { instrumental: string; vocals: string } | null
}

/** Segundos sem mexer o mouse até os controles sumirem. */
const IDLE_AFTER = 2800
/** Encerrar antes disso (s) não vira nota no histórico. */
const MIN_SCORED_SECONDS = 20
/** De quanto em quanto tempo (ms) os celulares da sala recebem a posição da música. */
const TICK_MS = 250

function Points({ value }: { value: number }) {
  const ref = useRef<HTMLSpanElement>(null)
  const spring = useSpring(value, { stiffness: 140, damping: 26 })

  useEffect(() => spring.set(value), [spring, value])
  useMotionValueEvent(spring, 'change', (latest) => {
    if (ref.current) ref.current.textContent = formatPoints(latest)
  })

  return (
    <span ref={ref} className="text-4xl leading-none font-bold tracking-[-0.03em] tabular-nums [font-stretch:108%] md:text-5xl">
      {formatPoints(value)}
    </span>
  )
}

/** Pontos, sequência e o veredito da última linha. */
function Hud({ session }: { session: StageSession }) {
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot)
  const [flash, setFlash] = useState<LineResult | null>(null)

  useEffect(() => {
    if (!snapshot.lastLine) return setFlash(null)
    setFlash(snapshot.lastLine)
    const timer = setTimeout(() => setFlash(null), 1700)
    return () => clearTimeout(timer)
  }, [snapshot.lastLine])

  return (
    <div className="ml-auto flex flex-col items-end" aria-live="off">
      <Points value={snapshot.points} />
      <div className="mt-1.5 flex h-6 items-center gap-2 text-sm font-semibold">
        <AnimatePresence mode="popLayout">
          {flash && (
            <motion.span
              key={flash.line}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ type: 'spring', stiffness: 460, damping: 30 }}
              className={flash.rating === 'quase' || flash.rating === 'errou' ? 'text-soft' : 'text-accent'}
            >
              {RATING_LABEL[flash.rating]}
            </motion.span>
          )}
        </AnimatePresence>
        {snapshot.streak >= 2 && <span className="numeric text-soft">{snapshot.streak} seguidas</span>}
      </div>
    </div>
  )
}

export function StagePage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const song = useSong(id)
  const libraryStatus = useLibrary((state) => state.status)
  const patch = useLibrary((state) => state.patch)
  const difficulty = useSettings((state) => state.difficulty)
  const latencyMs = useSettings((state) => state.latencyMs)
  const showLane = useSettings((state) => state.showLane)
  const hostName = useSettings((state) => state.hostName)
  const guests = useParty((state) => state.guests)
  const roomOnline = useParty((state) => state.online)

  const [data, setData] = useState<StageData | 'missing' | null>(null)
  const [session, setSession] = useState<StageSession | null>(null)
  const [idle, setIdle] = useState(false)
  const mediaRef = useRef<HTMLVideoElement>(null)
  const instrumentalRef = useRef<HTMLAudioElement>(null)
  const vocalsRef = useRef<HTMLAudioElement>(null)
  const rig = useRef<{ context: AudioContext; mic: MicInput } | null>(null)
  const finishing = useRef(false)
  /** Sessão já anunciada aos convidados, e se o resultado dela já foi mandado. */
  const announced = useRef<StageSession | null>(null)
  const resultSent = useRef(false)
  const coverUrl = useCoverUrl(song?.coverFile)

  const songId = song?.id
  const mediaFile = song?.mediaFile
  const instrumentalFile = song?.stems?.instrumental
  const vocalsFile = song?.stems?.vocals

  useEffect(() => {
    if (!songId || !mediaFile) return
    let alive = true
    const urls: string[] = []
    const open = async (name: string) => {
      const url = URL.createObjectURL(await readFile('media', name))
      urls.push(url)
      return url
    }
    const load = async () => {
      const [lyrics, melody, url] = await Promise.all([getLyrics(songId), getMelody(songId), open(mediaFile)])
      // Faixa separada que sumiu do disco não impede de cantar: toca o arquivo original.
      const stems = instrumentalFile && vocalsFile ? await Promise.all([open(instrumentalFile), open(vocalsFile)]).catch(() => null) : null
      if (alive) setData({ lyrics: lyrics ?? null, melody: melody ?? null, url, stems: stems && { instrumental: stems[0], vocals: stems[1] } })
    }
    load().catch(() => alive && setData('missing'))
    return () => {
      alive = false
      for (const url of urls) URL.revokeObjectURL(url)
    }
  }, [songId, mediaFile, instrumentalFile, vocalsFile])

  // A análise pode terminar (ou a letra ser trocada) com o palco já aberto: relê só os
  // documentos, sem mexer no arquivo de mídia que talvez já esteja tocando.
  const melodyStatus = song?.melody
  const lyricsLevel = song?.lyrics
  useEffect(() => {
    if (!songId) return
    let alive = true
    void Promise.all([getLyrics(songId), getMelody(songId)]).then(([lyrics, melody]) => {
      if (!alive) return
      setData((current) => (current && current !== 'missing' ? { ...current, lyrics: lyrics ?? null, melody: melody ?? null } : current))
    })
    return () => {
      alive = false
    }
  }, [songId, melodyStatus, lyricsLevel])

  // O contexto de áudio só pode nascer depois de um gesto do usuário.
  const getRig = useCallback(() => {
    if (!rig.current) {
      const context = new AudioContext({ latencyHint: 'interactive' })
      rig.current = { context, mic: new MicInput(context) }
    }
    return rig.current
  }, [])
  const getMic = useCallback(() => getRig().mic, [getRig])

  useEffect(() => {
    return () => {
      rig.current?.mic.stop()
      void rig.current?.context.close().catch(() => {})
      rig.current = null
    }
  }, [])

  useEffect(() => {
    if (!session) return
    return () => session.dispose()
  }, [session])

  const lines = useMemo(() => (data && data !== 'missing' ? data.lyrics?.lines ?? [] : []), [data])
  const notes = useMemo(() => (data && data !== 'missing' ? data.melody?.notes ?? [] : []), [data])
  const mode = useMemo(() => buildReference(lines, notes).mode, [lines, notes])

  const begin = async (withMic: boolean) => {
    const media = mediaRef.current
    if (!media || !song || !data || data === 'missing') return
    const { context, mic } = getRig()
    await context.resume()
    if (!withMic) mic.stop()

    const exact = data.melody?.source === 'ultrastar'
    const stems = data.stems && instrumentalRef.current && vocalsRef.current ? { instrumental: instrumentalRef.current, vocals: vocalsRef.current } : null
    const next = new StageSession({
      context,
      media,
      stems,
      hasPicture: song.mediaKind === 'video',
      mic: withMic && mic.active ? mic : null,
      lines,
      notes,
      notesFollowLyrics: exact,
      exactGuide: exact,
      difficulty,
      latency: latencyMs / 1000,
      offset: song.lyricOffset,
      hostName,
    })
    next.setRoster(useParty.getState().guests)
    setSession(next)
    useQueue.getState().started(song.id)
    next.play()
  }

  const finish = useCallback(async () => {
    if (!session || !song || finishing.current) return
    finishing.current = true
    session.pause()

    const now = Date.now()
    const results = session.finish()
    const sangEnough = session.media.currentTime >= Math.min(MIN_SCORED_SECONDS, session.duration * 0.5)

    if (results.length > 0 && sangEnough) {
      // Com convidados, cada nota leva o nome de quem cantou e todas ficam ligadas pela mesma rodada.
      const shared = results.some((result) => result.name !== null)
      const round = shared ? crypto.randomUUID() : undefined
      const saved: Array<{ id: number; name: string; points: number }> = []
      for (const { name, summary } of results) {
        const singer = name ?? hostName
        const id = await addScore({
          songId: song.id,
          date: now,
          points: summary.points,
          accuracy: summary.accuracy,
          bestStreak: summary.bestStreak,
          difficulty,
          mode: summary.mode,
          lines: summary.lines,
          ...(shared ? { singer, round } : {}),
        })
        saved.push({ id, name: singer, points: summary.points })
      }
      const winner = saved.reduce((best, entry) => (entry.points > best.points ? entry : best))
      await patch(song.id, { plays: song.plays + 1, lastSungAt: now, bestScore: Math.max(song.bestScore ?? 0, winner.points) })
      if (shared) {
        resultSent.current = true
        useParty.getState().broadcast({
          t: 'state',
          phase: 'resultado',
          song: { title: song.title, artist: song.artist },
          results: saved.map(({ name, points }) => ({ name, points })),
        })
      }
      void navigate(`/resultado/${winner.id}`, { replace: true })
    } else {
      if (results.length > 0) toast('Pouco tempo de música para dar uma nota.')
      await patch(song.id, { lastSungAt: now })
      // Sem nota para mostrar: com fila, volta para ela; sem fila, para a página da música.
      void navigate(useQueue.getState().items.length > 0 ? '/fila' : `/musica/${song.id}`, { replace: true })
    }
  }, [session, song, difficulty, hostName, patch, navigate])

  // Sala: quem entra ganha um lugar no placar, e o tom de cada convidado vai para a pontuação.
  useEffect(() => {
    if (session) session.setRoster(guests)
  }, [session, guests])

  useEffect(() => {
    if (!session) return
    const party = useParty.getState()
    party.listen((name, samples) => session.pushRemote(name, samples))
    return () => party.listen(null)
  }, [session])

  // Sala: conta aos celulares o que está tocando, em que ponto e como está o placar.
  const songTitle = song?.title
  const songArtist = song?.artist
  useEffect(() => {
    if (!session || !roomOnline || songTitle === undefined) return
    const { broadcast } = useParty.getState()

    const sendState = (resume: boolean) =>
      broadcast({ t: 'state', phase: 'cantando', resume, song: { title: songTitle, artist: songArtist ?? '' }, ...session.guestView })
    const sendTick = () => broadcast({ t: 'tick', time: session.time, at: Date.now(), playing: !session.media.paused && !session.media.ended })
    const sendScores = () => {
      const { board } = session.getSnapshot()
      if (board.length > 0) broadcast({ t: 'scores', list: board.map(({ name, points }) => ({ name, points })) })
    }

    // A conexão pode cair e voltar no meio da música: aí a nota dos convidados não volta a zero.
    sendState(announced.current === session)
    announced.current = session
    sendTick()
    sendScores()

    let last = session.getSnapshot()
    const unsubscribe = session.subscribe(() => {
      const next = session.getSnapshot()
      if (next.offset !== last.offset) sendState(true)
      if (next.offset !== last.offset || next.playing !== last.playing) sendTick()
      last = next
    })
    let ticks = 0
    const timer = window.setInterval(() => {
      sendTick()
      if (++ticks % 2 === 0) sendScores()
    }, TICK_MS)

    return () => {
      window.clearInterval(timer)
      unsubscribe()
      // Saiu do palco sem resultado para mostrar: os celulares voltam a esperar a próxima música.
      if (!resultSent.current) broadcast({ t: 'state', phase: 'aguardando' })
    }
  }, [session, roomOnline, songTitle, songArtist])

  const snapshotEnded = useSyncExternalStore(
    session ? session.subscribe : subscribeNothing,
    session ? () => session.getSnapshot().ended : () => false,
  )
  useEffect(() => {
    if (snapshotEnded) void finish()
  }, [snapshotEnded, finish])

  const setOffset = useCallback(
    (offset: number) => {
      if (!session || !song) return
      const rounded = Math.round(offset * 10) / 10
      session.setOffset(rounded)
      void patch(song.id, { lyricOffset: rounded })
    },
    [session, song, patch],
  )

  // Controles somem quando o mouse fica parado durante a música.
  const idleTimer = useRef(0)
  const wake = useCallback(() => {
    setIdle(false)
    window.clearTimeout(idleTimer.current)
    idleTimer.current = window.setTimeout(() => setIdle(true), IDLE_AFTER)
  }, [])
  useEffect(() => {
    if (!session) return
    wake()
    return () => window.clearTimeout(idleTimer.current)
  }, [session, wake])

  // Atalhos de teclado do palco.
  useEffect(() => {
    if (!session) return
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (isTyping(event) || event.ctrlKey || event.metaKey || event.altKey) return
      wake()

      switch (event.key) {
        case ' ':
        case 'k':
          event.preventDefault()
          session.toggle()
          break
        case 'ArrowLeft':
          if (target?.closest('[role="slider"]')) return
          session.seek(session.media.currentTime - 5)
          break
        case 'ArrowRight':
          if (target?.closest('[role="slider"]')) return
          session.seek(session.media.currentTime + 5)
          break
        case '[':
        case ',':
          setOffset(session.currentOffset - OFFSET_STEP)
          break
        case ']':
        case '.':
          setOffset(session.currentOffset + OFFSET_STEP)
          break
        case 'r':
          session.restart()
          break
        case 'f':
          if (document.fullscreenElement) void document.exitFullscreen()
          else void document.documentElement.requestFullscreen().catch(() => {})
          break
        default:
          return
      }
    }
    window.addEventListener('keydown', onKey)
    const releaseSpace = reserveSpaceKey()
    return () => {
      window.removeEventListener('keydown', onKey)
      releaseSpace()
    }
  }, [session, setOffset, wake])

  const playing = useSyncExternalStore(session ? session.subscribe : subscribeNothing, session ? () => session.getSnapshot().playing : () => false)
  const shared = useSyncExternalStore(session ? session.subscribe : subscribeNothing, session ? () => session.getSnapshot().board.length > 0 : () => false)
  const hideChrome = idle && playing

  if (libraryStatus === 'loading' || (song && data === null)) {
    return (
      <div data-theme="dark" aria-busy="true" className="fixed inset-0 flex flex-col justify-center bg-canvas px-5 text-ink md:px-[7vw]">
        <div className="skeleton h-16 w-3/5 max-w-2xl rounded-field" />
        <div className="skeleton mt-5 h-6 w-1/4 rounded-full" />
      </div>
    )
  }

  if (!song || data === 'missing' || data === null) {
    return (
      <div data-theme="dark" className="fixed inset-0 flex flex-col items-start justify-center bg-canvas px-5 text-ink md:px-[7vw]">
        <h1 className="display text-4xl md:text-6xl">{song ? 'O arquivo desta música sumiu.' : 'Música não encontrada.'}</h1>
        <p className="mt-4 max-w-[52ch] text-lg text-soft">
          {song
            ? 'O navegador não tem mais o áudio guardado, o que acontece quando os dados do site são limpos. Exclua a música e adicione de novo.'
            : 'Ela pode ter sido excluída desta biblioteca.'}
        </p>
        <Button asChild variant="primary" className="mt-7">
          <Link to={song ? `/musica/${song.id}` : '/'}>{song ? 'Abrir a página da música' : 'Ir para a biblioteca'}</Link>
        </Button>
      </div>
    )
  }

  const isVideo = song.mediaKind === 'video'
  // Com convidados cantando, a pista aparece mesmo sem microfone no computador: é para ela que eles olham.
  const hasLane = showLane && session !== null && (session.scoring || shared) && session.reference.laneNotes.length > 0
  // Sem faixas separadas resta o truque de cancelar o centro do estéreo, que não existe em gravação mono.
  const vocalControl = data.stems ? 'exato' : data.melody?.stereoWidth === undefined || data.melody.stereoWidth > 0.004 ? 'aproximado' : 'nenhum'

  return (
    <div data-theme="dark" onPointerMove={session ? wake : undefined} className={cn('fixed inset-0 overflow-hidden bg-canvas text-ink', hideChrome && 'cursor-none')}>
      <video
        ref={mediaRef}
        src={data.url}
        playsInline
        preload="auto"
        className={cn('absolute inset-0 size-full object-cover transition-opacity duration-700', isVideo ? (session ? 'opacity-75' : 'opacity-40') : 'opacity-0')}
      />
      {data.stems && (
        <>
          <audio ref={instrumentalRef} src={data.stems.instrumental} preload="auto" />
          <audio ref={vocalsRef} src={data.stems.vocals} preload="auto" />
        </>
      )}
      {!isVideo && coverUrl && <img src={coverUrl} alt="" className="absolute inset-0 size-full scale-125 object-cover opacity-45 blur-3xl saturate-150" />}
      {!isVideo && !coverUrl && (
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_78%_12%,color-mix(in_oklab,var(--accent)_14%,transparent),transparent_62%)]" />
      )}
      {/* Véu escuro do lado da letra: mantém o texto legível sobre qualquer imagem. */}
      <div className="absolute inset-0 bg-[linear-gradient(100deg,oklch(0.13_0.008_115/0.95),oklch(0.13_0.008_115/0.74)_48%,oklch(0.13_0.008_115/0.42))]" />
      <div className="absolute inset-x-0 bottom-0 h-56 bg-[linear-gradient(to_top,oklch(0.11_0.008_115/0.92),transparent)]" />

      {!session ? (
        <PreStage song={song} mode={mode} analyzing={song.melody === 'pending'} guests={guests} getMic={getMic} onBegin={(withMic) => void begin(withMic)} />
      ) : (
        <div className="relative flex h-full flex-col">
          <header className="flex items-start gap-3 px-5 pt-4 md:px-10 md:pt-6">
            <IconButton
              label="Sair sem salvar a nota"
              tooltipSide="bottom"
              className={cn('bg-canvas/40 transition-opacity duration-500', hideChrome && 'pointer-events-none opacity-0')}
              onClick={() => void navigate(`/musica/${song.id}`)}
            >
              <ArrowLeftIcon size={20} />
            </IconButton>
            <div className="min-w-0 pt-1">
              <p className="truncate font-semibold">{song.title}</p>
              {song.artist && <p className="truncate text-sm text-soft">{song.artist}</p>}
            </div>
            {session.scoring && session.reference.mode !== 'nenhum' && <Hud session={session} />}
          </header>
          <Board session={session} layout="faixa" className="mt-3 px-5 md:px-10 lg:hidden" />

          {hasLane && (
            <div className="mt-3 h-[21dvh] min-h-24 shrink-0">
              <PitchLane session={session} />
            </div>
          )}

          <main className="flex min-h-0 flex-1 gap-10 px-5 md:px-[7vw]">
            <div className="min-w-0 flex-1">
              {lines.length > 0 ? (
                <LyricsView session={session} lines={lines} className="h-full" />
              ) : data.lyrics?.plain ? (
                <PlainLyrics text={data.lyrics.plain} className="h-full" />
              ) : (
                <div className="flex h-full flex-col items-start justify-center">
                  <p className="display text-3xl md:text-5xl">Esta música está sem letra.</p>
                  <p className="mt-3 max-w-[48ch] text-lg text-soft">Busque ou cole a letra na página da música para ela aparecer aqui.</p>
                </div>
              )}
            </div>
            <Board session={session} layout="coluna" className="hidden pt-[5dvh] lg:block" />
          </main>

          <Transport
            session={session}
            vocalControl={vocalControl}
            onOffset={setOffset}
            onFinish={() => void finish()}
            className={hideChrome ? 'pointer-events-none opacity-0' : ''}
          />
        </div>
      )}
    </div>
  )
}

function subscribeNothing(): () => void {
  return () => {}
}
