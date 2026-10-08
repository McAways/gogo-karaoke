import { CheckIcon, DownloadSimpleIcon, FileArrowUpIcon, FilmStripIcon, MagnifyingGlassIcon, MusicNotesIcon } from '@phosphor-icons/react'
import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Link, useNavigate } from 'react-router'
import { Button } from '@/components/button'
import { DropZone } from '@/components/drop-zone'
import { Field, Segmented, Switch, TextInput } from '@/components/form'
import { HelperMissing, useHelperPresence } from '@/components/helper-guide'
import { formatDuration } from '@/lib/format'
import { helperStatus, isYoutubeUrl, searchVideos, spotifyLink, updateDownloader, videoInfo } from '@/lib/helper'
import type { HelperStatus, VideoSummary } from '@/lib/helper'
import { lyricsAvailability } from '@/lib/lrclib'
import type { LyricsAvailability } from '@/lib/lrclib'
import { isPackage } from '@/lib/package'
import { parseExport, searchQueryFor, spotifyLinkKind, tidyTrackTitle } from '@/lib/transfer'
import { useBatch } from '@/state/batch'
import { importFiles, openPackage, useJobs } from '@/state/jobs'
import { useSettings } from '@/state/settings'
import { toast } from '@/state/toasts'

type SearchState = { phase: 'idle' } | { phase: 'loading' } | { phase: 'done'; results: VideoSummary[] } | { phase: 'error'; message: string }

/** O que o banco de letras diz de cada vídeo. null = ainda conferindo; 'falhou' = o banco não respondeu. */
type LyricsCheck = Map<string, LyricsAvailability> | null | 'falhou'

function ResultRow({
  video,
  lyrics,
  audioSync,
  queued,
  onAdd,
}: {
  video: VideoSummary
  /** undefined = ainda não conferido. null = conferido e sem letra conhecida. */
  lyrics: LyricsAvailability | null | undefined
  audioSync: boolean
  queued: boolean
  onAdd: () => void
}) {
  return (
    <li className="flex items-center gap-4 rounded-card py-2.5 pr-3 pl-2.5 transition-colors duration-200 hover:bg-ink/5">
      <img src={video.thumbnail} alt="" loading="lazy" className="aspect-video w-28 shrink-0 rounded-field bg-raised object-cover sm:w-40" />
      <div className="min-w-0 flex-1">
        <p className="line-clamp-2 font-semibold">{video.title}</p>
        <p className="mt-0.5 truncate text-sm text-soft">{video.channel}</p>
        <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-faint">
          <span className="numeric">{formatDuration(video.duration)}</span>
          {lyrics === 'exata' && (
            <span className="inline-flex items-center gap-1 font-semibold text-accent-ink">
              <CheckIcon size={14} weight="bold" />
              letra com esta duração
            </span>
          )}
          {lyrics === 'texto' && <span className="font-semibold text-soft">{audioSync ? 'só o texto da letra: a sincronia sai do áudio' : 'só o texto da letra, sem sincronia'}</span>}
          {lyrics === 'outra' && <span>letra de outra versão: pode sair do tempo</span>}
          {lyrics === null && <span>sem letra conhecida</span>}
        </p>
      </div>
      <Button size="sm" variant={queued ? 'ghost' : 'secondary'} disabled={queued} onClick={onAdd}>
        {queued ? (
          'Na fila'
        ) : (
          <>
            <DownloadSimpleIcon size={16} weight="bold" />
            Baixar
          </>
        )}
      </Button>
    </li>
  )
}

function ResultSkeleton() {
  return (
    <ul aria-busy="true" aria-label="Buscando" className="mt-6 space-y-1">
      {Array.from({ length: 5 }, (_, i) => (
        <li key={i} className="flex items-center gap-4 py-2.5 pl-2.5">
          <div className="skeleton aspect-video w-28 shrink-0 rounded-field sm:w-40" />
          <div className="flex-1 space-y-2.5">
            <div className="skeleton h-4 w-4/5 rounded-full" />
            <div className="skeleton h-3.5 w-2/5 rounded-full" />
          </div>
        </li>
      ))}
    </ul>
  )
}

/** Explica por que a busca não está disponível e, quando dá, oferece o conserto. */
function HelperNotice({ status, onFixed, onRetry }: { status: HelperStatus | null; onFixed: (status: HelperStatus) => void; onRetry: () => void }) {
  const [installing, setInstalling] = useState(false)
  const { presence, retry } = useHelperPresence()

  if (!status) {
    if (presence === 'verificando' || presence === 'ok') return <p className="mt-8 text-faint">Verificando o ajudante.</p>
    return (
      <HelperMissing
        what="A busca no YouTube"
        presence={presence}
        className="mt-6"
        onRetry={() => {
          retry()
          onRetry()
        }}
      />
    )
  }

  const install = async () => {
    setInstalling(true)
    try {
      onFixed(await updateDownloader())
      toast('Downloader instalado.')
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Não foi possível instalar o downloader.', 'erro')
    } finally {
      setInstalling(false)
    }
  }

  return (
    <div className="mt-6 rounded-card border border-hairline bg-surface p-6">
      <p className="font-semibold">Falta instalar o downloader (yt-dlp).</p>
      <p className="mt-2 text-sm text-soft">É um download único de cerca de 18 MB, guardado dentro da pasta do projeto.</p>
      <Button variant="primary" className="mt-4" disabled={installing} onClick={() => void install()}>
        {installing ? 'Instalando' : 'Instalar agora'}
      </Button>
    </div>
  )
}

export function AddPage() {
  const kind = useSettings((state) => state.downloadKind)
  const update = useSettings((state) => state.update)
  const addYoutube = useJobs((state) => state.addYoutube)
  const onlyWithLyrics = useSettings((state) => state.onlyWithLyrics)
  const separateOnImport = useSettings((state) => state.separateOnImport)
  const alignWhenUnsynced = useSettings((state) => state.alignWhenUnsynced)
  const batch = useBatch((state) => state.batch)
  const navigate = useNavigate()
  const listInput = useRef<HTMLInputElement>(null)

  const [status, setStatus] = useState<HelperStatus | null | 'checking'>('checking')
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState<SearchState>({ phase: 'idle' })
  const [lyricsOf, setLyricsOf] = useState<LyricsCheck>(null)
  const [showAll, setShowAll] = useState(false)
  /** true quando o resultado veio de um link colado, não de uma busca por nome. */
  const [direct, setDirect] = useState(false)
  const [queued, setQueued] = useState<Set<string>>(new Set())
  const pending = useRef<AbortController | null>(null)

  useEffect(() => {
    void helperStatus().then(setStatus)
    void useBatch.getState().load()
    return () => pending.current?.abort()
  }, [])

  const ready = status !== 'checking' && status !== null && status.ytDlp !== null
  // Com a voz separada e a sincronia pelo áudio, letra só em texto também serve: os tempos saem da gravação.
  const audioSync = status !== 'checking' && !!status?.separator?.installed && !!status.aligner?.installed && separateOnImport && alignWhenUnsynced

  /** O arquivo exportado em outro aparelho: a lista (abre a tela de baixar) ou o pacote (as músicas entram prontas). */
  const openExported = async (file: File) => {
    try {
      if (await isPackage(file)) return void (await openPackage(file))
      // A lista é pequena. Arquivo grande que não é pacote não é nada do app: melhor não ler inteiro.
      if (file.size > 64 * 1024 * 1024) throw new Error('Esse arquivo não é uma lista nem um pacote exportado pelo Gogó.')
      useBatch.getState().fromExport(parseExport(await file.text()))
      void navigate('/adicionar/lista')
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Não deu para abrir esse arquivo.', 'erro')
    }
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    let text = query.trim()
    if (!text || !ready) return

    pending.current?.abort()
    const controller = new AbortController()
    pending.current = controller
    setSearch({ phase: 'loading' })
    setLyricsOf(null)
    setShowAll(false)
    setDirect(isYoutubeUrl(text))

    try {
      // Link do Spotify. Playlist e álbum abrem a lista das faixas; uma música só vira busca pelo nome dela.
      if (spotifyLinkKind(text)) {
        const found = await spotifyLink(text, controller.signal)
        if (controller.signal.aborted) return
        if (found.kind !== 'track') {
          useBatch.getState().fromSpotify(found)
          setSearch({ phase: 'idle' })
          return void navigate('/adicionar/lista')
        }
        const [track] = found.tracks
        text = searchQueryFor({ title: tidyTrackTitle(track.title), artist: track.artist, duration: track.duration })
        setQuery(text)
      }

      const results = isYoutubeUrl(text) ? [await videoInfo(text, controller.signal)] : await searchVideos(text, controller.signal)
      if (controller.signal.aborted) return
      setSearch({ phase: 'done', results })

      // A letra é conferida à parte: se o banco de letras falhar, a busca continua valendo e mostra tudo.
      const hintQuery = isYoutubeUrl(text) ? results[0]?.title ?? '' : text
      if (!hintQuery) return setLyricsOf('falhou')
      lyricsAvailability(hintQuery, results, controller.signal).then(
        (found) => !controller.signal.aborted && setLyricsOf(found),
        () => !controller.signal.aborted && setLyricsOf('falhou'),
      )
    } catch (err) {
      if (controller.signal.aborted) return
      setSearch({ phase: 'error', message: err instanceof Error ? err.message : 'A busca falhou.' })
    }
  }

  const add = (video: VideoSummary) => {
    addYoutube(video, kind)
    setQueued((current) => new Set(current).add(video.id))
  }

  // Com o filtro ligado, só aparecem os vídeos que têm letra que vai funcionar: a de mesma duração
  // ou, com a sincronia pelo áudio disponível, qualquer letra da música.
  const results = search.phase === 'done' ? search.results : []
  const checked = lyricsOf instanceof Map ? lyricsOf : null
  const usable = (video: VideoSummary) => {
    const kind = checked?.get(video.id)
    return kind === 'exata' || (kind === 'texto' && audioSync)
  }
  const filtering = onlyWithLyrics && !showAll && !direct && checked !== null
  const shown = filtering ? results.filter(usable) : results
  const hidden = results.length - shown.length
  const batchLeft = batch ? batch.items.filter((item) => item.status === 'pendente').length : 0

  return (
    <>
      <h1 className="display text-4xl md:text-5xl">Adicionar música</h1>

      {batch && (
        <Link to="/adicionar/lista" className="mt-6 flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-card border border-hairline bg-surface px-5 py-4 transition-colors hover:border-faint">
          <span className="font-semibold">Lista em andamento: {batch.name}</span>
          <span className="text-sm text-soft">
            {batchLeft > 0 ? `${batchLeft} de ${batch.items.length} para baixar` : `${batch.items.length} ${batch.items.length === 1 ? 'música' : 'músicas'}`}
          </span>
          <span className="ml-auto text-sm font-semibold text-accent-ink">Abrir a lista</span>
        </Link>
      )}

      <div className="mt-10 grid gap-x-14 gap-y-14 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <section aria-labelledby="youtube-heading">
          <h2 id="youtube-heading" className="text-xl font-semibold">
            Do YouTube
          </h2>

          <form onSubmit={(event) => void submit(event)} className="mt-5 flex flex-col gap-4">
            <Field label="Nome da música ou link do vídeo" hint="Também aceita link do Spotify. De playlist pública ou de álbum, as faixas viram uma lista para baixar; de uma música só, o app busca pelo nome dela.">
              {(field) => (
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <MagnifyingGlassIcon size={18} className="pointer-events-none absolute top-1/2 left-4 -translate-y-1/2 text-faint" />
                    <TextInput
                      {...field}
                      type="search"
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      placeholder="Evidências, Chitãozinho e Xororó"
                      autoComplete="off"
                      disabled={!ready}
                      className="pl-11"
                    />
                  </div>
                  <Button type="submit" variant="primary" disabled={!ready || !query.trim() || search.phase === 'loading'}>
                    Buscar
                  </Button>
                </div>
              )}
            </Field>

            <div className="flex flex-wrap items-center gap-3">
              <span className="text-[13px] font-semibold text-soft">Baixar como</span>
              <Segmented
                label="Formato do download"
                value={kind}
                onChange={(value) => update({ downloadKind: value })}
                options={[
                  { value: 'audio', label: 'Áudio', icon: <MusicNotesIcon size={15} weight="fill" /> },
                  { value: 'video', label: 'Vídeo', icon: <FilmStripIcon size={15} weight="fill" /> },
                ]}
              />
              <span className="text-[13px] text-faint">{kind === 'audio' ? 'Mais leve e mais rápido.' : 'Clipe em 720p atrás da letra.'}</span>
            </div>

            <div className="flex items-center gap-3">
              <Switch id="only-with-lyrics" label="Mostrar só vídeos com letra" checked={onlyWithLyrics} onChange={(value) => update({ onlyWithLyrics: value })} />
              <label htmlFor="only-with-lyrics" className="text-sm">
                <span className="font-semibold">Só vídeos com letra</span>
                <span className="ml-2 text-faint">
                  {audioSync ? 'Vale a letra sincronizada com a mesma duração do vídeo, ou só o texto: aí a sincronia é medida no áudio.' : 'Vale a letra sincronizada com a mesma duração do vídeo.'}
                </span>
              </label>
            </div>
          </form>

          {status === 'checking' && <p className="mt-8 text-faint">Verificando o ajudante.</p>}
          {status !== 'checking' && !ready && (
            <HelperNotice
              status={status}
              onFixed={setStatus}
              onRetry={() => {
                setStatus('checking')
                void helperStatus().then(setStatus)
              }}
            />
          )}

          {search.phase === 'loading' && <ResultSkeleton />}

          {search.phase === 'error' && (
            <div className="mt-6 rounded-card border border-danger/35 bg-danger/8 p-5">
              <p className="font-semibold text-danger">A busca não funcionou.</p>
              <p className="mt-1 text-sm text-soft">{search.message}</p>
            </div>
          )}

          {search.phase === 'done' && search.results.length === 0 && (
            <p className="mt-8 text-soft">Nenhum vídeo encontrado. Tente o nome do artista junto com o da música.</p>
          )}

          {search.phase === 'done' && results.length > 0 && (
            <>
              {onlyWithLyrics && lyricsOf === null && <p className="mt-6 text-sm text-faint">Conferindo quais destes vídeos têm letra.</p>}
              {onlyWithLyrics && lyricsOf === 'falhou' && (
                <p className="mt-6 text-sm text-soft">O banco de letras não respondeu agora, então não deu para conferir quais têm letra. Estão todos na lista.</p>
              )}
              {filtering && shown.length === 0 && (
                <p className="mt-6 max-w-[58ch] text-soft">
                  Nenhum destes vídeos tem letra que encaixe sem ajuste. Tente escrever o artista junto com o nome da música.
                </p>
              )}
              {shown.length > 0 && (
                <ul className="mt-6 space-y-1">
                  {shown.map((video) => (
                    <ResultRow key={video.id} video={video} lyrics={checked ? (checked.get(video.id) ?? null) : undefined} audioSync={audioSync} queued={queued.has(video.id)} onAdd={() => add(video)} />
                  ))}
                </ul>
              )}
              {filtering && hidden > 0 && (
                <p className="mt-5 text-sm text-soft">
                  {hidden === 1 ? '1 vídeo sem letra ficou de fora.' : `${hidden} vídeos sem letra ficaram de fora.`}{' '}
                  <button type="button" onClick={() => setShowAll(true)} className="font-semibold text-accent-ink underline underline-offset-4">
                    Mostrar todos
                  </button>
                </p>
              )}
            </>
          )}

          {search.phase === 'idle' && ready && (
            <p className="mt-8 max-w-[58ch] text-soft">
              O download roda na sua máquina e o arquivo fica guardado neste navegador. Depois disso, o app busca a letra e analisa a melodia por conta própria.
            </p>
          )}
        </section>

        <section aria-labelledby="files-heading">
          <h2 id="files-heading" className="text-xl font-semibold">
            Do computador
          </h2>
          <DropZone onFiles={importFiles} compact className="mt-5" />
          <p className="mt-4 text-sm text-soft">
            Nomeie o arquivo como <span className="font-semibold text-ink">Artista - Música</span> para a letra ser encontrada de primeira.
          </p>

          <h2 id="list-heading" className="mt-12 text-xl font-semibold">
            De outro aparelho
          </h2>
          <p className="mt-3 text-sm text-soft">
            Abra o arquivo exportado no outro aparelho (“Exportar”, no menu de cima). Se for a lista, o app baixa as mesmas músicas de novo, com a letra e as playlists. Se for o pacote com as músicas
            completas, elas entram prontas para cantar, sem baixar nada.
          </p>
          <Button className="mt-4" onClick={() => listInput.current?.click()}>
            <FileArrowUpIcon size={18} />
            Abrir arquivo exportado
          </Button>
          <input
            ref={listInput}
            type="file"
            accept=".json,.gogo,application/json"
            aria-label="Arquivo exportado em outro aparelho"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (file) void openExported(file)
            }}
          />
        </section>
      </div>
    </>
  )
}
