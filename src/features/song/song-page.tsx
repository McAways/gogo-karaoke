import {
  ArrowLeftIcon,
  ArrowsClockwiseIcon,
  CheckIcon,
  FileTextIcon,
  MagnifyingGlassIcon,
  MicrophoneStageIcon,
  PencilSimpleIcon,
  QueueIcon,
  TimerIcon,
  TrashIcon,
  UserSoundIcon,
  WaveformIcon,
} from '@phosphor-icons/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { Button } from '@/components/button'
import { cn } from '@/components/cn'
import { Cover } from '@/components/cover'
import { Field, TextInput } from '@/components/form'
import { Dialog } from '@/components/overlay'
import { formatBytes, formatDate, formatDuration, formatPercent, formatPoints } from '@/lib/format'
import { forgetHelperStatus, helperStatusCached, installSeparator } from '@/lib/helper'
import type { HelperStatus } from '@/lib/helper'
import { applyLrclibRecord, applyLyrics, applyUltraStar, canAlign, enqueueAnalysis, fitLyrics, revertAudioSync, separateAndRefit, syncLyricsToAudio } from '@/lib/importer'
import { lrcToLines, looksLikeLrc } from '@/lib/lrc'
import { distinctMatches, searchLyrics } from '@/lib/lrclib'
import type { LyricsMatch } from '@/lib/lrclib'
import { getLyrics, getMelody, listScores } from '@/lib/storage/db'
import type { Difficulty, LyricsDoc, MelodyDoc, ScoreRecord, Song } from '@/lib/types'
import { looksLikeUltraStar, parseUltraStar } from '@/lib/ultrastar'
import { enqueue } from '@/features/library/library-page'
import { useLibrary, useSong } from '@/state/library'
import { useSettings } from '@/state/settings'
import { toast } from '@/state/toasts'

export const DIFFICULTY_LABEL: Record<Difficulty, string> = { facil: 'Fácil', normal: 'Normal', dificil: 'Difícil' }

const LYRICS_SOURCE: Record<LyricsDoc['source'], string> = {
  lrclib: 'LRCLIB',
  arquivo: 'arquivo importado',
  ultrastar: 'UltraStar',
  manual: 'sincronizada por você',
}

function lyricsSummary(song: Song, doc: LyricsDoc | null): { title: string; detail: string } {
  if (!doc || song.lyrics === 'none') return { title: 'Sem letra', detail: 'Busque no banco de letras, importe um arquivo ou cole o texto e sincronize.' }
  const from = `Fonte: ${LYRICS_SOURCE[doc.source]}.`
  if (doc.timing === 'audio') {
    const tied = doc.alignment?.tied ?? 0
    return {
      title: 'Sincronizada pelo áudio',
      detail: `${doc.lines.length} linhas, com o tempo de cada palavra medido na voz desta gravação. Texto: ${LYRICS_SOURCE[doc.source]}.${tied > 0 ? ` Em ${tied} ${tied === 1 ? 'linha' : 'linhas'} a voz é difícil de ouvir e vale a sincronia original.` : ''}`,
    }
  }
  if (doc.level === 'plain') return { title: 'Letra sem sincronia', detail: `${from} Abra o editor para marcar o tempo de cada linha.` }
  if (doc.level === 'word') return { title: 'Sincronizada palavra por palavra', detail: `${doc.lines.length} linhas. ${from}` }
  return {
    title: 'Sincronizada por linha',
    detail: `${doc.lines.length} linhas. ${from}${doc.source === 'lrclib' ? ' Se estiver fora de tempo, “Buscar letra” mostra as outras sincronias.' : ''}`,
  }
}

function melodySummary(song: Song, doc: MelodyDoc | null): { title: string; detail: string } {
  if (song.melody === 'pending') return { title: 'Analisando o áudio', detail: 'O guia de melodia fica pronto em alguns segundos.' }
  if (song.melody === 'failed' || !doc) return { title: 'Sem guia de melodia', detail: 'O áudio não pôde ser lido. A pontuação conta só o ritmo.' }
  if (doc.source === 'ultrastar') return { title: 'Notas do UltraStar', detail: `${doc.notes.length} notas anotadas à mão. É a pontuação mais precisa.` }
  if (doc.notes.length === 0) return { title: 'Nenhuma melodia encontrada', detail: 'O áudio parece não ter voz. A pontuação conta só o ritmo.' }
  if (doc.fromVocals) {
    return { title: 'Guia tirado da voz separada', detail: `${doc.notes.length} notas, só do que é cantado. A nota máxima vem com 90% de acerto, porque o guia ainda erra algumas.` }
  }
  return { title: 'Guia extraído do áudio', detail: `${doc.notes.length} notas. Acerta cerca de nove em cada dez, então a nota máxima já vem com 90% de acerto.` }
}

/**
 * Escolha manual da letra. O banco devolve muitas cópias da mesma sincronia, então a
 * lista mostra uma linha por sincronia distinta. O que diferencia uma da outra é a
 * hora em que a voz entra, e isso dá para conferir de ouvido.
 */
/** O que está acontecendo durante a separação, em palavras. */
const SEPARATION_STEP: Record<string, string> = {
  instalando: 'Baixando e instalando o separador (cerca de 60 MB).',
  convertendo: 'Preparando o áudio.',
  separando: 'Separando a voz do instrumental.',
  codificando: 'Gerando as duas faixas.',
  analisando: 'Lendo a melodia da voz.',
  conferindo: 'Conferindo a letra pelo áudio.',
  ouvindo: 'Ouvindo a voz para achar o instante de cada palavra. Leva perto de um minuto.',
  encaixando: 'Encaixando a letra na voz.',
}

function LyricsSearchDialog({
  song,
  currentId,
  open,
  onClose,
  onApplied,
}: {
  song: Song
  /** Registro da LRCLIB em uso nesta música, se a letra veio de lá. */
  currentId: number | undefined
  open: boolean
  onClose: () => void
  onApplied: () => void
}) {
  const [state, setState] = useState<{ phase: 'loading' } | { phase: 'done'; matches: LyricsMatch[] } | { phase: 'error'; message: string }>({ phase: 'loading' })
  const [applying, setApplying] = useState<number | null>(null)

  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    setState({ phase: 'loading' })
    searchLyrics({ title: song.title, artist: song.artist, duration: song.duration }, controller.signal)
      .then((matches) => setState({ phase: 'done', matches: distinctMatches(matches) }))
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setState({ phase: 'error', message: err instanceof Error ? err.message : 'A busca falhou.' })
      })
    return () => controller.abort()
  }, [open, song.title, song.artist, song.duration])

  const use = async (match: LyricsMatch) => {
    setApplying(match.record.id)
    try {
      const doc = await applyLrclibRecord(song.id, match.record, song.duration)
      if (!doc) return toast('Esse registro veio sem letra.', 'erro')
      toast(doc.level === 'plain' ? 'Letra aplicada. Falta sincronizar.' : 'Letra sincronizada aplicada.')
      onApplied()
      onClose()
    } finally {
      setApplying(null)
    }
  }

  const synced = state.phase === 'done' ? state.matches.filter((m) => m.synced) : []
  const plain = state.phase === 'done' ? state.matches.filter((m) => !m.synced).slice(0, 3) : []

  const useButton = (match: LyricsMatch) => {
    const inUse = currentId !== undefined && match.sameTiming.includes(currentId)
    return (
      <Button size="sm" variant={inUse ? 'ghost' : 'secondary'} disabled={inUse || applying !== null} onClick={() => void use(match)}>
        {inUse ? (
          <>
            <CheckIcon size={14} weight="bold" />
            Em uso
          </>
        ) : applying === match.record.id ? (
          'Aplicando'
        ) : (
          'Usar'
        )}
      </Button>
    )
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !next && onClose()}
      title="Escolher a letra"
      description={`Busca por “${song.title}”${song.artist ? ` de ${song.artist}` : ''}. Cada opção é uma sincronia diferente: escolha a que tem a voz entrando na mesma hora da sua gravação.`}
      wide
    >
      {state.phase === 'loading' && (
        <ul aria-busy="true" className="space-y-3">
          {Array.from({ length: 3 }, (_, i) => (
            <li key={i} className="skeleton h-16 rounded-field" />
          ))}
        </ul>
      )}
      {state.phase === 'error' && <p className="text-danger">{state.message}</p>}
      {state.phase === 'done' && state.matches.length === 0 && (
        <p className="text-soft">Nada encontrado. Confira o nome da música e do artista em “Editar dados”, ou cole a letra no editor.</p>
      )}

      {synced.length > 0 && (
        <ul className="-mx-2 space-y-1">
          {synced.map((match) => {
            const copies = match.sameTiming.length
            // O último verso começa depois (ou quase no fim) do áudio: a letra é de uma versão mais longa.
            const overflows = match.tail !== null && match.tail < 3
            return (
              <li key={match.record.id} className="flex items-center gap-4 rounded-field px-2 py-3 hover:bg-ink/5">
                <span className="numeric w-14 shrink-0 text-2xl">{formatDuration(match.firstVerse ?? 0)}</span>
                <div className="min-w-0 flex-1">
                  <p className="font-semibold">
                    A voz entra aos {formatDuration(match.firstVerse ?? 0)}
                    {match.record.hasWordSync && <span className="ml-2 text-[13px] font-semibold text-accent-ink">palavra por palavra</span>}
                  </p>
                  <p className="truncate text-sm text-soft">{match.record.albumName || match.record.artistName}</p>
                  <p className={cn('mt-0.5 text-[13px]', overflows ? 'text-danger' : 'text-faint')}>
                    {overflows ? 'A letra continua depois do fim da sua gravação.' : copies === 1 ? 'Um registro no banco.' : `${copies} registros iguais no banco.`}
                  </p>
                </div>
                {useButton(match)}
              </li>
            )
          })}
        </ul>
      )}

      {state.phase === 'done' && synced.length === 0 && plain.length > 0 && (
        <p className="text-soft">Não há letra sincronizada para esta música no banco. As opções abaixo têm só o texto.</p>
      )}

      {plain.length > 0 && (
        <div className={synced.length > 0 ? 'mt-6 border-t border-hairline pt-5' : 'mt-4'}>
          <h3 className="font-semibold">Sem sincronia</h3>
          <p className="mt-1 text-sm text-soft">O texto fica parado na tela. Dá para marcar o tempo de cada linha no editor.</p>
          <ul className="-mx-2 mt-2 space-y-1">
            {plain.map((match) => (
              <li key={match.record.id} className="flex items-center gap-4 rounded-field px-2 py-2.5 hover:bg-ink/5">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold">{match.record.trackName}</p>
                  <p className="truncate text-sm text-soft">
                    {match.record.artistName}
                    {match.record.albumName ? `, ${match.record.albumName}` : ''}
                  </p>
                </div>
                {useButton(match)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Dialog>
  )
}

function EditDialog({ song, open, onClose }: { song: Song; open: boolean; onClose: () => void }) {
  const patch = useLibrary((state) => state.patch)
  const [title, setTitle] = useState(song.title)
  const [artist, setArtist] = useState(song.artist)

  useEffect(() => {
    if (open) {
      setTitle(song.title)
      setArtist(song.artist)
    }
  }, [open, song.title, song.artist])

  const empty = !title.trim()
  const save = async () => {
    if (empty) return
    await patch(song.id, { title: title.trim(), artist: artist.trim() })
    toast('Dados atualizados.')
    onClose()
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !next && onClose()}
      title="Editar dados"
      description="O nome e o artista são usados para encontrar a letra."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button variant="primary" disabled={empty} onClick={() => void save()}>
            Salvar
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault()
          void save()
        }}
      >
        <Field label="Música" error={empty ? 'A música precisa de um nome.' : null}>
          {(field) => <TextInput {...field} value={title} onChange={(event) => setTitle(event.target.value)} autoFocus />}
        </Field>
        <Field label="Artista">{(field) => <TextInput {...field} value={artist} onChange={(event) => setArtist(event.target.value)} />}</Field>
        <button type="submit" hidden />
      </form>
    </Dialog>
  )
}

function Block({ title, detail, children }: { title: string; detail: string; children?: ReactNode }) {
  return (
    <div>
      <p className="text-lg font-semibold">{title}</p>
      <p className="mt-1 max-w-[62ch] text-soft">{detail}</p>
      {children && <div className="mt-4 flex flex-wrap gap-2">{children}</div>}
    </div>
  )
}

export function SongPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const song = useSong(id)
  const status = useLibrary((state) => state.status)
  const patch = useLibrary((state) => state.patch)
  const remove = useLibrary((state) => state.remove)

  const [lyrics, setLyrics] = useState<LyricsDoc | null>(null)
  const [melody, setMelody] = useState<MelodyDoc | null>(null)
  const [scores, setScores] = useState<ScoreRecord[]>([])
  const [searching, setSearching] = useState(false)
  const [editing, setEditing] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [helper, setHelper] = useState<HelperStatus | null | 'checking'>('checking')
  /** Etapa em andamento da separação (chave de SEPARATION_STEP), ou null quando parado. */
  const [working, setWorking] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    void helperStatusCached().then(setHelper)
  }, [])

  const reload = useCallback(async () => {
    if (!id) return
    const [lyricsDoc, melodyDoc, scoreList] = await Promise.all([getLyrics(id), getMelody(id), listScores(id)])
    setLyrics(lyricsDoc ?? null)
    setMelody(melodyDoc ?? null)
    setScores(scoreList)
  }, [id])

  // Recarrega quando a análise termina ou a letra muda por outro caminho.
  useEffect(() => {
    void reload()
  }, [reload, song?.lyrics, song?.melody])

  if (status === 'loading') {
    return (
      <div aria-busy="true" className="grid gap-10 lg:grid-cols-[minmax(0,400px)_minmax(0,1fr)]">
        <div className="skeleton aspect-square rounded-card" />
        <div className="space-y-4">
          <div className="skeleton h-12 w-3/4 rounded-field" />
          <div className="skeleton h-5 w-1/3 rounded-full" />
        </div>
      </div>
    )
  }

  if (!song) {
    return (
      <section className="flex min-h-[60dvh] flex-col items-start justify-center">
        <h1 className="display text-4xl md:text-5xl">Música não encontrada.</h1>
        <p className="mt-4 text-lg text-soft">Ela pode ter sido excluída desta biblioteca.</p>
        <Button asChild variant="primary" className="mt-7">
          <Link to="/">Ir para a biblioteca</Link>
        </Button>
      </section>
    )
  }

  const importLyricsFile = async (file: File) => {
    const text = await file.text()
    if (looksLikeUltraStar(text)) {
      const parsed = parseUltraStar(text)
      if (parsed.lines.length === 0) return toast('Esse arquivo UltraStar não tem notas.', 'erro')
      await applyUltraStar(song.id, parsed)
      toast(`UltraStar importado: ${parsed.lines.length} linhas e ${parsed.notes.length} notas.`)
    } else if (looksLikeLrc(text)) {
      const { lines, hasWordTimes } = lrcToLines(text, song.duration)
      if (lines.length === 0) return toast('Esse LRC não tem linhas com tempo.', 'erro')
      await applyLyrics({ songId: song.id, lines, level: hasWordTimes ? 'word' : 'line', source: 'arquivo', updatedAt: Date.now() })
      toast(`Letra importada: ${lines.length} linhas sincronizadas.`)
    } else if (text.trim()) {
      await applyLyrics({ songId: song.id, lines: [], plain: text.trim(), level: 'plain', source: 'arquivo', updatedAt: Date.now() })
      toast('Texto importado.')
    } else {
      return toast('O arquivo está vazio.', 'erro')
    }
    await afterLyricsChange()
  }

  const fail = (err: unknown, fallback: string) => toast(err instanceof Error ? err.message : fallback, 'erro')

  const installAndSeparate = async () => {
    setWorking('instalando')
    try {
      const next = await installSeparator()
      forgetHelperStatus()
      setHelper(next)
      await separate()
    } catch (err) {
      fail(err, 'Não foi possível instalar o separador.')
      setWorking(null)
    }
  }

  const separate = async () => {
    setWorking('convertendo')
    try {
      const note = await separateAndRefit(song.id, setWorking)
      toast(note ? `Voz separada. ${note}` : 'Voz separada do instrumental.')
    } catch (err) {
      fail(err, 'A separação falhou.')
    } finally {
      setWorking(null)
      await reload()
    }
  }

  const refit = async () => {
    setWorking('conferindo')
    try {
      const fit = await fitLyrics(song.id)
      toast(fit ? fit.note : 'Não há sincronia para conferir nesta música.', fit && !fit.fitted ? 'erro' : 'ok')
    } catch (err) {
      fail(err, 'Não foi possível conferir a letra.')
    } finally {
      setWorking(null)
      await reload()
    }
  }

  const syncToAudio = async () => {
    setWorking('convertendo')
    try {
      const sync = await syncLyricsToAudio(song.id, setWorking)
      toast(sync ? sync.note : 'Não há letra para sincronizar nesta música.', sync && !sync.applied ? 'erro' : 'ok')
    } catch (err) {
      fail(err, 'A sincronia pelo áudio falhou.')
    } finally {
      setWorking(null)
      await reload()
    }
  }

  const undoAudioSync = async () => {
    if (await revertAudioSync(song.id)) toast('A letra voltou para a sincronia anterior.')
    await reload()
  }

  // Letra trocada à mão. Se a nova veio só em texto e a música tem a voz separada, os tempos saem
  // do áudio. Letra que veio sincronizada fica como veio: medir, só pelo botão.
  const afterLyricsChange = async () => {
    await reload()
    const current = useLibrary.getState().songs.find((s) => s.id === song.id)
    const doc = await getLyrics(song.id)
    if (doc?.level === 'plain' && current?.stems && useSettings.getState().alignWhenUnsynced && (await canAlign())) await syncToAudio()
  }

  const reanalyze = async () => {
    await patch(song.id, { melody: 'pending' })
    void enqueueAnalysis(song.id)
  }

  const lyricsInfo = lyricsSummary(song, lyrics)
  const melodyInfo = melodySummary(song, melody)
  const preview = lyrics ? (lyrics.lines.length > 0 ? lyrics.lines.map((l) => l.text) : (lyrics.plain ?? '').split(/\r?\n/)).filter(Boolean).slice(0, 7) : []

  return (
    <>
      <Link to="/" className="inline-flex items-center gap-2 text-sm font-semibold text-soft transition-colors hover:text-ink">
        <ArrowLeftIcon size={16} weight="bold" />
        Biblioteca
      </Link>

      <div className="mt-6 grid gap-x-14 gap-y-10 lg:grid-cols-[minmax(0,400px)_minmax(0,1fr)]">
        <div className="lg:sticky lg:top-24 lg:self-start">
          <Cover song={song} className="aspect-square w-full rounded-card" />
          <Button asChild variant="primary" size="lg" className="mt-5 w-full">
            <Link to={`/cantar/${song.id}`}>
              <MicrophoneStageIcon size={20} weight="fill" />
              Cantar
            </Link>
          </Button>
          <dl className="mt-6 grid grid-cols-2 gap-x-6 gap-y-4 text-sm">
            <div>
              <dt className="text-faint">Duração</dt>
              <dd className="numeric mt-0.5">{formatDuration(song.duration)}</dd>
            </div>
            <div>
              <dt className="text-faint">Tamanho</dt>
              <dd className="numeric mt-0.5">{formatBytes(song.size)}</dd>
            </div>
            <div>
              <dt className="text-faint">Formato</dt>
              <dd className="mt-0.5">{song.mediaKind === 'video' ? 'Vídeo' : 'Áudio'}</dd>
            </div>
            <div>
              <dt className="text-faint">Origem</dt>
              <dd className="mt-0.5 truncate">{song.source.type === 'youtube' ? 'YouTube' : 'Arquivo'}</dd>
            </div>
          </dl>
        </div>

        <div className="min-w-0">
          <h1 className="display text-4xl text-balance md:text-5xl xl:text-6xl">{song.title}</h1>
          <p className="mt-3 text-xl text-soft">{song.artist || 'Artista desconhecido'}</p>
          <div className="mt-5 flex flex-wrap gap-2">
            <Button size="sm" onClick={() => enqueue(song)}>
              <QueueIcon size={16} />
              Pôr na fila
            </Button>
            <Button size="sm" onClick={() => setEditing(true)}>
              <PencilSimpleIcon size={16} />
              Editar dados
            </Button>
            <Button size="sm" variant="danger" onClick={() => setConfirmingDelete(true)}>
              <TrashIcon size={16} />
              Excluir
            </Button>
          </div>

          <section aria-labelledby="lyrics-heading" className="mt-12">
            <h2 id="lyrics-heading" className="display text-2xl">
              Letra
            </h2>
            <div className="mt-5">
              <Block title={lyricsInfo.title} detail={lyricsInfo.detail}>
                <Button size="sm" onClick={() => setSearching(true)}>
                  <MagnifyingGlassIcon size={16} />
                  Buscar letra
                </Button>
                <Button asChild size="sm">
                  <Link to={`/musica/${song.id}/letra`}>
                    <TimerIcon size={16} />
                    Abrir editor
                  </Link>
                </Button>
                <Button size="sm" onClick={() => fileInput.current?.click()}>
                  <FileTextIcon size={16} />
                  Importar arquivo
                </Button>
                {lyrics && lyrics.source !== 'ultrastar' && song.stems && helper !== 'checking' && helper?.aligner?.installed && !working && (
                  <Button size="sm" onClick={() => void syncToAudio()}>
                    <WaveformIcon size={16} />
                    {lyrics.timing === 'audio' ? 'Sincronizar de novo' : 'Sincronizar pelo áudio'}
                  </Button>
                )}
                {lyrics?.timing === 'audio' && lyrics.previous && !working && (
                  <Button size="sm" variant="ghost" onClick={() => void undoAudioSync()}>
                    Voltar à sincronia anterior
                  </Button>
                )}
                <input
                  ref={fileInput}
                  type="file"
                  accept=".lrc,.txt,text/plain"
                  hidden
                  onChange={(event) => {
                    const file = event.target.files?.[0]
                    event.target.value = ''
                    if (file) void importLyricsFile(file)
                  }}
                />
              </Block>
              {preview.length > 0 && (
                <div className="mt-6 max-w-[62ch] rounded-card bg-surface p-6 [mask-image:linear-gradient(to_bottom,black_55%,transparent)]">
                  {preview.map((line, i) => (
                    <p key={i} className="text-lg leading-relaxed text-soft">
                      {line}
                    </p>
                  ))}
                </div>
              )}
            </div>
          </section>

          <section aria-labelledby="stems-heading" className="mt-12">
            <h2 id="stems-heading" className="display text-2xl">
              Voz e instrumental
            </h2>
            <div className="mt-5">
              {working || song.separation === 'pending' ? (
                <Block title="Trabalhando nesta música" detail={SEPARATION_STEP[working ?? 'separando'] ?? 'Separando a voz do instrumental.'} />
              ) : song.stems ? (
                <Block
                  title="Voz separada do instrumental"
                  detail="No palco, o controle de voz original abaixa ou tira o cantor da gravação. O guia de notas e a conferência da letra usam só a voz."
                >
                  {(song.lyrics === 'line' || song.lyrics === 'word') && (
                    <Button size="sm" onClick={() => void refit()}>
                      <WaveformIcon size={16} />
                      Conferir a letra pelo áudio
                    </Button>
                  )}
                  {helper !== 'checking' && helper?.separator?.installed && (
                    <Button size="sm" onClick={() => void separate()}>
                      <ArrowsClockwiseIcon size={16} />
                      Separar de novo
                    </Button>
                  )}
                </Block>
              ) : (
                <Block
                  title={song.separation === 'failed' ? 'A separação não deu certo' : 'Música inteira, sem separação'}
                  detail={
                    helper === 'checking'
                      ? 'Verificando o ajudante.'
                      : helper === null
                        ? 'Separar a voz precisa do ajudante deste computador. Ajustes, “Ajudante”, diz como.'
                        : !helper.ffmpeg
                          ? 'Separar a voz precisa do ffmpeg instalado e no PATH.'
                          : 'Separar permite tirar a voz original no palco, deixa o guia de notas mais fiel e confere a letra pelo áudio. Leva menos de meio minuto.'
                  }
                >
                  {helper !== 'checking' && helper?.ffmpeg && (
                    <Button size="sm" onClick={() => void (helper.separator?.installed ? separate() : installAndSeparate())}>
                      <UserSoundIcon size={16} />
                      {helper.separator?.installed ? 'Separar a voz' : 'Instalar o separador e separar'}
                    </Button>
                  )}
                </Block>
              )}
            </div>
          </section>

          <section aria-labelledby="melody-heading" className="mt-12">
            <h2 id="melody-heading" className="display text-2xl">
              Pontuação
            </h2>
            <div className="mt-5">
              <Block title={melodyInfo.title} detail={melodyInfo.detail}>
                {song.melody !== 'pending' && (
                  <Button size="sm" onClick={() => void reanalyze()}>
                    <ArrowsClockwiseIcon size={16} />
                    Analisar de novo
                  </Button>
                )}
              </Block>
            </div>
          </section>

          <section aria-labelledby="history-heading" className="mt-12">
            <h2 id="history-heading" className="display text-2xl">
              Histórico
            </h2>
            {scores.length === 0 ? (
              <p className="mt-5 text-soft">Você ainda não cantou esta música.</p>
            ) : (
              <ul className="mt-5 max-w-[62ch] space-y-1">
                {scores.slice(0, 6).map((score) => (
                  <li key={score.id}>
                    <Link to={`/resultado/${score.id}`} className="-mx-3 flex items-baseline gap-4 rounded-field px-3 py-2.5 transition-colors hover:bg-ink/5">
                      <span className="numeric w-20 text-xl">{formatPoints(score.points)}</span>
                      <span className="min-w-0 truncate text-sm text-soft">
                        {score.singer && <span className="font-semibold text-ink">{score.singer}, </span>}
                        {formatPercent(score.accuracy)} de acerto, {DIFFICULTY_LABEL[score.difficulty].toLowerCase()}
                      </span>
                      <span className="ml-auto shrink-0 text-sm text-faint">{formatDate(score.date)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>

      <LyricsSearchDialog
        song={song}
        currentId={lyrics?.source === 'lrclib' ? lyrics.lrclibId : undefined}
        open={searching}
        onClose={() => setSearching(false)}
        onApplied={() => void afterLyricsChange()}
      />
      <EditDialog song={song} open={editing} onClose={() => setEditing(false)} />
      <Dialog
        open={confirmingDelete}
        onOpenChange={setConfirmingDelete}
        title="Excluir esta música?"
        description={`“${song.title}” sai da biblioteca junto com a letra e o histórico de notas. O arquivo é apagado deste navegador.`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmingDelete(false)}>
              Cancelar
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                void remove(song.id).then(() => {
                  toast('Música excluída.')
                  void navigate('/')
                })
              }}
            >
              Excluir música
            </Button>
          </>
        }
      />
    </>
  )
}
