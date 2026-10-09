import { useLibrary } from '@/state/library'
import { useQueue } from '@/state/queue'
import { useSettings } from '@/state/settings'
import { alignLyrics } from './alignment'
import type { Alignment } from './alignment'
import { analyzeMedia, captureVideoFrame, probeDuration } from './audio/analyze'
import { formatOffset } from './format'
import { alignToAudio, downloadVideo, fetchDownloaded, fetchImage, helperStatusCached, separateMedia } from './helper'
import type { AlignStage, SeparationStage, VideoSummary } from './helper'
import { lrcToLines } from './lrc'
import { distinctMatches, isPlausiblePlain, pickAutomatic, rankRecords, recordToDoc, resemblesSong, searchLyrics, songQuery } from './lrclib'
import type { LrclibRecord, LyricsMatch } from './lrclib'
import { distributeWords, estimateLineDuration } from './lyrics-timing'
import { packedBytes, unpackMelody } from './package'
import type { OpenPackage, PackedFile } from './package'
import { deleteSongData, getLyrics, getMelody, putLyrics, putMelody } from './storage/db'
import { readFile, removeFile, saveBlob, saveStream } from './storage/files'
import type { Folder } from './storage/files'
import { parseFileName, parseVideoTitle } from './titles'
import { findInLibrary } from './transfer'
import type { ExportedLyrics } from './transfer'
import type { LyricLine, LyricsDoc, MediaKind, RefNote, Song } from './types'
import type { UltraStarSong } from './ultrastar'

export type ImportStage = 'baixando' | 'salvando' | 'letra' | 'separando' | 'analisando' | 'conferindo' | 'sincronizando' | 'pronta'

export interface ImportUpdate {
  stage: ImportStage
  /** 0..1, ou null quando a etapa não tem como medir. */
  progress: number | null
  songId?: string
  note?: string
  /** Só na etapa de download: 2 ou 3 quando a tentativa anterior falhou. */
  attempt?: number
}

type Report = (update: ImportUpdate) => void

/** O que já se sabe da música antes de baixar: vem de uma lista exportada ou de uma playlist. */
export interface ImportPreset {
  /** Nome e artista já conferidos: valem no lugar do que o título do vídeo sugere. */
  title?: string
  artist?: string
  album?: string
  /** Letra que veio na lista: aplicada no lugar da busca. */
  lyrics?: ExportedLyrics
  lyricOffset?: number
  /** Letras que a tela de busca já achou para este vídeo, da melhor para a pior: são as que a música recebe. */
  records?: LrclibRecord[]
  /** O que a pessoa digitou para chegar ao vídeo: ajuda a reconhecer a letra. */
  typed?: string
  /** Notas anotadas à mão (UltraStar). */
  notes?: RefNote[]
}

const MELODY_VERSION = 1
const AUDIO_EXTENSIONS = new Set(['mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wav', 'flac', 'weba'])
const VIDEO_EXTENSIONS = new Set(['mp4', 'm4v', 'webm', 'mov', 'mkv'])

function extensionOf(name: string): string {
  return /\.([a-z0-9]{2,5})$/i.exec(name)?.[1].toLowerCase() ?? ''
}

/** null quando o arquivo não é áudio nem vídeo. */
export function mediaKindOf(file: File): MediaKind | null {
  if (file.type.startsWith('video/')) return 'video'
  if (file.type.startsWith('audio/')) return 'audio'
  const ext = extensionOf(file.name)
  if (VIDEO_EXTENSIONS.has(ext)) return 'video'
  if (AUDIO_EXTENSIONS.has(ext)) return 'audio'
  return null
}

function baseSong(id: string): Pick<Song, 'id' | 'addedAt' | 'lyrics' | 'lyricOffset' | 'melody' | 'plays'> {
  return { id, addedAt: Date.now(), lyrics: 'none', lyricOffset: 0, melody: 'pending', plays: 0 }
}

export async function importYoutube(video: VideoSummary, kind: MediaKind, report: Report, signal?: AbortSignal, preset?: ImportPreset): Promise<Song> {
  report({ stage: 'baixando', progress: 0 })
  const result = await downloadVideo(
    video.url,
    kind,
    (p) => {
      const within = p.total ? p.downloaded / p.total : 0
      // Vídeo chega em dois arquivos (imagem e som); a imagem é quase todo o peso.
      const progress = kind === 'video' ? (p.part <= 1 ? within * 0.85 : 0.85 + within * 0.15) : within
      report({ stage: 'baixando', progress: Math.min(1, progress), attempt: p.attempt })
    },
    signal,
  )

  const id = crypto.randomUUID()
  const mediaFile = `${id}.${result.ext}`
  report({ stage: 'salvando', progress: 0 })
  const stream = await fetchDownloaded(result.fileId, signal)
  await saveStream('media', mediaFile, stream, (bytes) => report({ stage: 'salvando', progress: Math.min(1, bytes / result.size) }))

  const info = result.info
  const parsed = parseVideoTitle(info.title, info.channel)
  const song: Song = {
    ...baseSong(id),
    title: preset?.title?.trim() || info.track?.trim() || parsed.title,
    artist: preset?.title ? (preset.artist ?? '').trim() : info.artist?.trim() || parsed.artist,
    album: preset?.album ?? info.album,
    duration: info.duration,
    mediaKind: result.mime.startsWith('video/') ? 'video' : 'audio',
    mediaFile,
    mime: result.mime,
    size: result.size,
    source: { type: 'youtube', url: info.url, videoId: info.id, channel: info.channel, title: info.title },
  }

  const cover = (await fetchImage(info.thumbnail)) ?? (await fetchImage(`https://i.ytimg.com/vi/${info.id}/mqdefault.jpg`))
  if (cover) {
    song.coverFile = `${id}.jpg`
    await saveBlob('covers', song.coverFile, cover)
  }

  await useLibrary.getState().save(song)
  return finishImport(song, report, signal, preset)
}

export async function importLocalFile(file: File, report: Report, signal?: AbortSignal): Promise<Song> {
  const kind = mediaKindOf(file)
  if (!kind) throw new Error('Esse arquivo não é áudio nem vídeo.')

  const id = crypto.randomUUID()
  const mediaFile = `${id}.${extensionOf(file.name) || (kind === 'video' ? 'mp4' : 'mp3')}`
  report({ stage: 'salvando', progress: null })
  await saveBlob('media', mediaFile, file)

  const parsed = parseFileName(file.name)
  const song: Song = {
    ...baseSong(id),
    title: parsed.title,
    artist: parsed.artist,
    duration: await probeDuration(file, kind),
    mediaKind: kind,
    mediaFile,
    mime: file.type || (kind === 'video' ? 'video/mp4' : 'audio/mpeg'),
    size: file.size,
    source: { type: 'file', name: file.name },
  }

  if (kind === 'video') {
    const frame = await captureVideoFrame(file)
    if (frame) {
      song.coverFile = `${id}.jpg`
      await saveBlob('covers', song.coverFile, frame)
    }
  }

  await useLibrary.getState().save(song)
  return finishImport(song, report, signal)
}

async function finishImport(song: Song, report: Report, signal?: AbortSignal, preset?: ImportPreset): Promise<Song> {
  report({ stage: 'letra', progress: null, songId: song.id })
  let note: string
  let matches: LyricsMatch[] = []
  const settings = useSettings.getState()
  const willSeparate = settings.separateOnImport && (await canSeparate())
  // A sincronia pelo áudio só roda sozinha quando a letra vem sem tempos (aí os tempos saem da
  // própria gravação). Letra que já vem sincronizada fica como veio: medir, só a pedido.
  const mayAlign = willSeparate && settings.alignWhenUnsynced && (await canAlign())
  if (preset?.lyrics) {
    // A letra veio pronta na lista (com a sincronia e os ajustes de quem exportou): não busca outra.
    await putLyrics({ songId: song.id, ...preset.lyrics, updatedAt: Date.now() })
    await useLibrary.getState().patch(song.id, { lyrics: preset.lyrics.level, lyricOffset: preset.lyricOffset ?? 0 })
    note = 'Letra trazida da lista.'
  } else {
    try {
      const found = await autoLyrics(song, signal, mayAlign, preset)
      note = found.note
      matches = found.matches
    } catch (err) {
      if (signal?.aborted) throw err
      // A música já está salva: falha na letra não derruba a importação.
      note = 'Não deu para buscar a letra agora. Tente de novo na página da música.'
    }
  }
  // Notas anotadas à mão valem mais que as tiradas do áudio: a análise só completa o resto.
  if (preset?.notes) await putMelody({ songId: song.id, source: 'ultrastar', notes: preset.notes, version: MELODY_VERSION })

  if (willSeparate) {
    report({ stage: 'separando', progress: null, songId: song.id, note })
    try {
      await separateSong(song.id, undefined, signal)
    } catch (err) {
      if (signal?.aborted) throw err
      note = `${note} A separação de voz falhou, então a música toca só com a voz original.`
    }
  }

  report({ stage: 'analisando', progress: 0, songId: song.id, note })
  await enqueueAnalysis(song.id, (ratio) => report({ stage: 'analisando', progress: ratio, songId: song.id, note }))

  let saved = useLibrary.getState().songs.find((s) => s.id === song.id) ?? song
  if (saved.melody === 'failed') note = `${note} O áudio não pôde ser analisado, então a pontuação vai contar só o ritmo.`

  if (saved.stems && saved.melody === 'ready' && matches.some((m) => m.synced)) {
    report({ stage: 'conferindo', progress: null, songId: song.id, note })
    const fit = await fitLyrics(song.id, matches).catch(() => null)
    if (fit) note = fit.note
    saved = useLibrary.getState().songs.find((s) => s.id === song.id) ?? saved
  }

  if (mayAlign && saved.stems && saved.lyrics === 'plain') {
    report({ stage: 'sincronizando', progress: 0, songId: song.id, note })
    try {
      const sync = await syncLyricsToAudio(song.id, (stage, progress) => report({ stage: 'sincronizando', progress: stage === 'ouvindo' ? (progress ?? 0) : stage === 'encaixando' ? 1 : 0, songId: song.id, note }), signal)
      if (sync) note = sync.note
    } catch (err) {
      if (signal?.aborted) throw err
      note = `${note} A sincronia pelo áudio falhou, então vale a letra como veio.`
    }
    saved = useLibrary.getState().songs.find((s) => s.id === song.id) ?? saved
  }

  report({ stage: 'pronta', progress: 1, songId: song.id, note })
  return saved
}

// ---------- Pacote com as músicas completas ----------

export interface PackageResult {
  added: Song[]
  /** Músicas do pacote que já estavam na biblioteca. */
  skipped: number
}

/**
 * Traz para a biblioteca as músicas de um pacote exportado em outro aparelho. Elas chegam
 * prontas: o arquivo, a capa, a voz separada, a letra e o guia de notas vêm no pacote, então
 * nada é baixado, separado, analisado nem medido aqui. Só copia.
 */
export async function importPackage(pack: OpenPackage, report: Report, signal?: AbortSignal): Promise<PackageResult> {
  const { header, slice } = pack
  // Só conta como repetida a música que já estava aqui antes: duas do mesmo pacote entram as duas.
  const before = [...useLibrary.getState().songs]
  const existing = header.songs.map((song) => findInLibrary({ title: song.title, artist: song.artist, videoId: song.source.type === 'youtube' ? song.source.videoId : undefined }, before))
  const total = packedBytes(header.songs.filter((_, index) => !existing[index])) || 1
  const idOf = new Map<number, string>()
  const added: Song[] = []
  const stamp = Date.now()
  let done = 0

  report({ stage: 'salvando', progress: 0 })
  // Do fim para o começo: a biblioteca mostra primeiro o que chegou por último, e assim a ordem do pacote se mantém.
  for (let index = header.songs.length - 1; index >= 0; index--) {
    const found = existing[index]
    if (found) {
      idOf.set(index, found.id)
      continue
    }
    if (signal?.aborted) throw new DOMException('Importação cancelada.', 'AbortError')

    const packed = header.songs[index]
    const id = crypto.randomUUID()
    const written: Array<[Folder, string]> = []
    const store = async (dir: Folder, name: string, ref: PackedFile) => {
      written.push([dir, name])
      await saveStream(dir, name, slice(ref).stream(), (bytes) => report({ stage: 'salvando', progress: Math.min(1, (done + bytes) / total) }))
      done += ref.size
    }

    try {
      const { files } = packed
      const mediaFile = `${id}.${files.media.ext}`
      await store('media', mediaFile, files.media)
      let stems: Song['stems']
      if (files.instrumental && files.vocals) {
        stems = { instrumental: `${id}.instrumental.m4a`, vocals: `${id}.voz.m4a` }
        await store('media', stems.instrumental, files.instrumental)
        await store('media', stems.vocals, files.vocals)
      }
      let coverFile: string | undefined
      if (files.cover) {
        coverFile = `${id}.jpg`
        await store('covers', coverFile, files.cover)
      }

      if (packed.lyrics) await putLyrics({ songId: id, ...packed.lyrics, updatedAt: Date.now() })
      if (packed.melody) await putMelody(unpackMelody(packed.melody, id))
      // Notas anotadas à mão sem o guia pronto: ficam guardadas e a análise completa o resto.
      else if (packed.notes) await putMelody({ songId: id, source: 'ultrastar', notes: packed.notes, version: MELODY_VERSION })

      const song: Song = {
        id,
        title: packed.title,
        artist: packed.artist,
        ...(packed.album ? { album: packed.album } : {}),
        duration: packed.duration,
        mediaKind: packed.mediaKind,
        mediaFile,
        mime: /^(audio|video)\/[\w.+-]+$/.test(files.media.mime) ? files.media.mime : packed.mediaKind === 'video' ? 'video/mp4' : 'audio/mp4',
        size: files.media.size,
        ...(coverFile ? { coverFile } : {}),
        source: packed.source,
        addedAt: stamp + (header.songs.length - index),
        lyrics: packed.lyrics?.level ?? 'none',
        lyricOffset: packed.lyricOffset,
        melody: packed.melody ? 'ready' : 'pending',
        plays: 0,
        ...(stems ? { stems } : {}),
      }
      await useLibrary.getState().save(song)
      idOf.set(index, id)
      added.push(song)
      if (!packed.melody) void enqueueAnalysis(id)
    } catch (err) {
      // Música pela metade não fica: o que já foi gravado dela sai.
      for (const [dir, name] of written) await removeFile(dir, name)
      await deleteSongData(id).catch(() => {})
      if (err instanceof DOMException && err.name === 'QuotaExceededError') throw new Error('Faltou espaço neste navegador para guardar as músicas do pacote.')
      throw err
    }
  }

  for (const playlist of header.playlists) {
    const songIds = playlist.songs.map((index) => idOf.get(index)).filter((id): id is string => id !== undefined)
    const meta = playlist.kind === 'album' ? { kind: 'album' as const, album: playlist.album, artist: playlist.artist } : undefined
    useQueue.getState().mergePlaylist(playlist.name, songIds, meta)
  }
  return { added, skipped: existing.filter(Boolean).length }
}

/**
 * Procura a letra e aplica a melhor sincronizada. Letra só de texto não é aplicada
 * sozinha: ela aparece parada na tela e passa a impressão de que a sincronia quebrou.
 * A exceção é `plainIsEnough`: quando a letra vai ser sincronizada pelo áudio logo em
 * seguida, o texto basta.
 *
 * `hint` é o que a tela de busca já sabia antes do download. Se ela achou uma letra confiável,
 * é essa que vale, sem perguntar de novo ao banco: o que a tela mostrou é o que a música recebe.
 */
export async function autoLyrics(
  song: Song,
  signal?: AbortSignal,
  plainIsEnough = false,
  hint: Pick<ImportPreset, 'records' | 'typed'> = {},
): Promise<{ applied: boolean; note: string; matches: LyricsMatch[] }> {
  const query = songQuery(song, hint.typed)
  const known = hint.records ?? []
  let matches = rankRecords(known, query)
  if (!pickAutomatic(matches, query)?.confident) {
    try {
      matches = await searchLyrics(query, signal, known)
    } catch (err) {
      // O banco falhou agora, mas a letra achada antes do download continua valendo.
      if (signal?.aborted || known.length === 0) throw err
    }
  }
  const choice = pickAutomatic(matches, query)

  if (!choice) {
    // A busca vai abrindo e traz junto música de nome parecido: só conta o que pode ser esta.
    const related = matches.filter(resemblesSong)
    if (related.length === 0) return { applied: false, matches, note: 'Nenhuma letra encontrada. Dá para buscar com outras palavras em “Buscar letra”, na página da música.' }
    const plain = plainIsEnough ? matches.find(isPlausiblePlain) : undefined
    if (plain) {
      const doc = await applyLrclibRecord(song.id, plain.record, song.duration)
      if (doc) return { applied: true, matches, note: 'Só achei a letra sem sincronia.' }
    }
    return {
      applied: false,
      matches,
      note: related.some((m) => m.synced)
        ? 'Achei letras sincronizadas, mas nenhuma parece ser desta gravação. Veja as opções em “Buscar letra”, na página da música.'
        : 'Só achei letra sem sincronia. Dá para usá-la e marcar os tempos no editor, na página da música.',
    }
  }

  const doc = await applyLrclibRecord(song.id, choice.match.record, song.duration)
  if (!doc) return { applied: false, matches, note: 'A letra encontrada veio vazia. Busque de novo na página da música.' }

  const others = distinctMatches(matches).filter((m) => m.synced).length - 1
  if (!choice.confident) {
    return { applied: true, matches, note: 'Letra sincronizada aplicada, mas pode ser de outra versão da música. Se ficar fora de tempo, troque em “Buscar letra” ou use “Sincronizar pelo áudio”, na página da música.' }
  }
  if (choice.match.durationDelta > 3) {
    return { applied: true, matches, note: `Letra sincronizada aplicada. A gravação difere em ${Math.round(choice.match.durationDelta)} s, então talvez precise ajustar o atraso.` }
  }
  return {
    applied: true,
    matches,
    note: others > 0 ? `Letra sincronizada aplicada. Há mais ${others} ${others === 1 ? 'sincronia diferente' : 'sincronias diferentes'} em “Buscar letra”, se esta não encaixar.` : 'Letra sincronizada aplicada.',
  }
}

export async function applyLrclibRecord(songId: string, record: LrclibRecord, duration: number): Promise<LyricsDoc | null> {
  const doc = await recordToDoc(record, songId, duration)
  if (doc) await applyLyrics(doc)
  return doc
}

export async function applyLyrics(doc: LyricsDoc): Promise<void> {
  await putLyrics(doc)
  await useLibrary.getState().patch(doc.songId, { lyrics: doc.level })
}

/** UltraStar traz letra e notas juntas: as notas substituem o guia extraído do áudio. */
export async function applyUltraStar(songId: string, parsed: UltraStarSong): Promise<void> {
  const existing = await getMelody(songId)
  await putMelody({
    songId,
    source: 'ultrastar',
    notes: parsed.notes,
    peaks: existing?.peaks,
    stereoWidth: existing?.stereoWidth,
    version: MELODY_VERSION,
  })
  await putLyrics({ songId, lines: parsed.lines, level: 'word', source: 'ultrastar', updatedAt: Date.now() })
  await useLibrary.getState().patch(songId, { lyrics: 'word', melody: 'ready' })
}

// ---------- Separação de voz ----------

// Separar a voz e medir a letra usam, cada um, o processador inteiro. Com várias músicas sendo
// importadas ao mesmo tempo, esses dois passos entram numa fila e rodam um por vez; os downloads,
// que só dependem da rede, seguem juntos.
let heavy: Promise<unknown> = Promise.resolve()

function oneAtATime<T>(task: () => Promise<T>): Promise<T> {
  const run = heavy.then(task, task)
  heavy = run.catch(() => {})
  return run
}

/** true quando o ajudante está no ar com o separador e o ffmpeg instalados. */
export async function canSeparate(): Promise<boolean> {
  const status = await helperStatusCached()
  return !!status?.separator?.installed && !!status.ffmpeg
}

/**
 * Manda a música para o ajudante separar e guarda as duas faixas no navegador.
 * Não refaz a análise nem a conferência da letra: quem chama decide (ver `separateAndRefit`).
 */
export async function separateSong(songId: string, onStage?: (stage: SeparationStage) => void, signal?: AbortSignal): Promise<void> {
  const song = useLibrary.getState().songs.find((s) => s.id === songId)
  if (!song) return

  await useLibrary.getState().patch(songId, { separation: 'pending' })
  try {
    const file = await readFile('media', song.mediaFile)
    const result = await oneAtATime(() => separateMedia(file, extensionOf(song.mediaFile) || 'm4a', (stage) => onStage?.(stage), signal))
    const stems = { instrumental: `${songId}.instrumental.m4a`, vocals: `${songId}.voz.m4a` }
    await saveStream('media', stems.instrumental, await fetchDownloaded(result.instrumental.fileId, signal))
    await saveStream('media', stems.vocals, await fetchDownloaded(result.vocals.fileId, signal))
    await useLibrary.getState().patch(songId, { stems, separation: undefined })
  } catch (err) {
    await useLibrary.getState().patch(songId, { separation: 'failed' })
    throw err
  }
}

/**
 * Para músicas que já estavam na biblioteca: separa, refaz o guia pela voz e confere a letra.
 * Se a letra for só texto, mede os tempos no áudio. Devolve o aviso do que foi feito.
 */
export async function separateAndRefit(songId: string, onStage?: (stage: SeparationStage | AlignStage | 'analisando' | 'conferindo') => void): Promise<string | null> {
  await separateSong(songId, onStage)
  onStage?.('analisando')
  await useLibrary.getState().patch(songId, { melody: 'pending' })
  await enqueueAnalysis(songId)
  onStage?.('conferindo')
  const fit = await fitLyrics(songId).catch(() => null)
  // Letra só em texto: agora que há a voz separada, os tempos podem sair do áudio.
  if ((await getLyrics(songId))?.level === 'plain' && useSettings.getState().alignWhenUnsynced && (await canAlign())) {
    const sync = await syncLyricsToAudio(songId, onStage).catch(() => null)
    if (sync) return sync.note
  }
  return fit?.note ?? null
}

// ---------- Sincronia da letra pelo áudio ----------

/** true quando o ajudante está no ar com a sincronia pelo áudio e o ffmpeg instalados. */
export async function canAlign(): Promise<boolean> {
  const status = await helperStatusCached()
  return !!status?.aligner?.installed && !!status.ffmpeg
}

/** Sem sincronia de referência, a letra só é aceita se o modelo ouviu pelo menos esta fração das linhas. */
const MIN_HEARD = 0.5
/** Com referência, bastam estas linhas ouvidas com clareza: elas dizem onde as outras devem estar. */
const MIN_ANCHORS = 3

export interface AudioSync {
  /** false = o modelo não reconheceu a letra no áudio. Nada foi alterado. */
  applied: boolean
  note: string
}

const round = (seconds: number) => Math.round(seconds * 100) / 100

/**
 * Mede, na voz separada, o instante em que cada palavra da letra é cantada, e passa a usar
 * esses tempos. A sincronia que havia antes fica guardada: serve de referência para os trechos
 * que o modelo não ouve bem e é o que volta em `revertAudioSync`.
 *
 * Devolve null quando não há o que fazer (música sem voz separada, sem letra, ou com letra do
 * UltraStar, que já traz o tempo de cada sílaba anotado à mão).
 */
export async function syncLyricsToAudio(songId: string, onStage?: (stage: AlignStage, progress?: number) => void, signal?: AbortSignal): Promise<AudioSync | null> {
  const song = useLibrary.getState().songs.find((s) => s.id === songId)
  const doc = await getLyrics(songId)
  if (!song?.stems || !doc || doc.source === 'ultrastar') return null

  // A referência é sempre a sincronia original, mesmo quando a letra já foi medida antes.
  const base = doc.timing === 'audio' && doc.previous ? doc.previous : { lines: doc.lines, level: doc.level, lyricOffset: song.lyricOffset }
  const synced = base.lines.length > 0
  const texts = doc.lines.length > 0 ? doc.lines.map((line) => line.text) : (doc.plain ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  if (texts.length === 0) return null

  // As palavras são separadas do mesmo jeito que a tela separa, para os tempos voltarem no lugar certo.
  const tokens = texts.map((text) => distributeWords(text, 0, 1))
  const input = tokens.map((words, i) => ({
    words: words.map((word) => word.text),
    reference: synced && base.lines[i] ? base.lines[i].start + base.lyricOffset : null,
  }))

  const voice = await readFile('media', song.stems.vocals)
  const result = await oneAtATime(() => alignToAudio(voice, 'm4a', input, (stage, progress) => onStage?.(stage, progress), signal))
  if (synced ? result.anchors < MIN_ANCHORS : result.heard < MIN_HEARD) {
    return {
      applied: false,
      note: synced
        ? 'Não reconheci esta letra na voz da gravação, então ela ficou como estava. Pode ser a letra de outra versão: veja em “Buscar letra”.'
        : 'Não reconheci esta letra na voz da gravação. Ela ficou sem sincronia: veja outras em “Buscar letra” ou marque os tempos no editor.',
    }
  }

  const lines: LyricLine[] = result.lines.map((aligned, i) => {
    const text = texts[i]
    const nextStart = result.lines[i + 1]?.start ?? (song.duration > 0 ? song.duration : aligned.end + 10)
    if (aligned.words && aligned.words.length === tokens[i].length && tokens[i].length > 0) {
      const words = tokens[i].map((token, k) => ({
        text: token.text,
        start: round(aligned.words![k].start),
        end: round(Math.max(aligned.words![k].end, aligned.words![k].start + 0.05)),
        ...(token.glue ? { glue: true } : {}),
      }))
      return { start: words[0].start, end: Math.max(words[words.length - 1].end, words[0].start + 0.3), text, words }
    }
    // Linha que o modelo não ouviu: o início vale, e as palavras são espalhadas por sílaba.
    const start = round(aligned.start)
    const span = Math.max(estimateLineDuration(text), aligned.end - aligned.start)
    const end = round(Math.max(start + 0.3, Math.min(nextStart - 0.05, start + span)))
    return { start, end, text, words: distributeWords(text, start, end) }
  })

  await putLyrics({
    ...doc,
    lines,
    level: 'word',
    timing: 'audio',
    alignment: { at: Date.now(), score: result.score, heard: result.heard, tied: result.tied },
    previous: { lines: base.lines, level: base.level, lyricOffset: base.lyricOffset },
    updatedAt: Date.now(),
  })
  await useLibrary.getState().patch(songId, { lyrics: 'word', lyricOffset: 0 })

  const weak = result.lines.filter((line) => !line.words).length
  return {
    applied: true,
    note:
      weak === 0
        ? 'Letra sincronizada pelo áudio, palavra por palavra.'
        : `Letra sincronizada pelo áudio. Em ${weak} de ${lines.length} linhas a voz é difícil de ouvir${synced ? ', e nelas vale a sincronia original' : ''}.`,
  }
}

/** Desfaz a sincronia pelo áudio: volta a letra para os tempos que tinha antes. */
export async function revertAudioSync(songId: string): Promise<boolean> {
  const doc = await getLyrics(songId)
  if (!doc || doc.timing !== 'audio' || !doc.previous) return false
  const { previous, timing: _timing, alignment: _alignment, ...rest } = doc
  await putLyrics({ ...rest, lines: previous.lines, level: previous.level, updatedAt: Date.now() })
  await useLibrary.getState().patch(songId, { lyrics: previous.level, lyricOffset: previous.lyricOffset })
  return true
}

// ---------- Conferência da letra pelo áudio ----------

/** Fração mínima de versos começando junto de uma frase cantada para a letra contar como encaixada. */
const FIT_MIN = 0.38
/** Só troca de sincronia quando a outra é claramente melhor: evita alternar entre duas equivalentes. */
const SWITCH_MARGIN = 0.06
const MAX_CANDIDATES = 6

export interface LyricsFit {
  /** false = o áudio não confirmou nenhuma das sincronias disponíveis. Nada foi alterado. */
  fitted: boolean
  switched: boolean
  offset: number
  note: string
}

/**
 * Compara as sincronias disponíveis com a voz separada da música, fica com a que
 * encaixa e acerta o atraso. Devolve null quando não há como comparar (música sem
 * voz separada ou sem letra sincronizada).
 *
 * `matches` são os candidatos já buscados na importação; sem eles, busca de novo.
 */
export async function fitLyrics(songId: string, matches?: LyricsMatch[], signal?: AbortSignal): Promise<LyricsFit | null> {
  const song = useLibrary.getState().songs.find((s) => s.id === songId)
  const melody = await getMelody(songId)
  if (!song || !melody?.fromVocals || melody.notes.length < 3) return null

  const current = await getLyrics(songId)
  const candidates: Array<{ record: LrclibRecord | null; alignment: Alignment }> = []
  const consider = (lines: LyricLine[], record: LrclibRecord | null) => {
    const alignment = alignLyrics(lines, melody.notes, song.duration)
    if (alignment) candidates.push({ record, alignment })
  }

  if (current && current.lines.length > 0) consider(current.lines, null)

  // Letra importada de arquivo ou marcada à mão é do usuário: só confere o atraso, não troca.
  const mayReplace = !current || current.source === 'lrclib'
  if (mayReplace) {
    const list = matches ?? (await searchLyrics(songQuery(song), signal))
    for (const match of distinctMatches(list).filter((m) => m.synced).slice(0, MAX_CANDIDATES)) {
      // A sincronia em uso já entrou acima.
      if (current?.lrclibId !== undefined && match.sameTiming.includes(current.lrclibId)) continue
      consider(lrcToLines(match.record.syncedLyrics ?? '', song.duration).lines, match.record)
    }
  }
  if (candidates.length === 0) return null

  const best = candidates.reduce((a, b) => (b.alignment.onsets > a.alignment.onsets ? b : a))
  if (best.alignment.onsets < FIT_MIN) {
    return {
      fitted: false,
      switched: false,
      offset: song.lyricOffset,
      note: 'Não consegui confirmar a sincronia da letra pelo áudio. Se ela ficar fora de tempo, troque em “Buscar letra”.',
    }
  }

  const inUse = candidates.find((c) => c.record === null)
  const chosen = inUse && inUse.alignment.onsets >= best.alignment.onsets - SWITCH_MARGIN ? inUse : best
  if (chosen.record) await applyLrclibRecord(songId, chosen.record, song.duration)

  // Correções menores que 0,3 s ficam dentro do erro da própria medida: melhor não mexer.
  const offset = Math.abs(chosen.alignment.offset) >= 0.3 ? Math.round(chosen.alignment.offset * 10) / 10 : 0
  await useLibrary.getState().patch(songId, { lyricOffset: offset })

  const switched = chosen.record !== null
  const base = switched ? 'Troquei a letra pela sincronia que encaixa no áudio desta gravação.' : 'Letra conferida com o áudio: a sincronia encaixa.'
  return { fitted: true, switched, offset, note: offset !== 0 ? `${base} Atraso ajustado para ${formatOffset(offset)}.` : base }
}

// ---------- Análise da melodia ----------

async function analyzeSong(songId: string, onProgress?: (ratio: number) => void): Promise<void> {
  const library = useLibrary.getState()
  const song = library.songs.find((s) => s.id === songId)
  if (!song) return

  try {
    // Com a voz separada, o guia sai só dela: sem os instrumentos, as notas são as que se canta.
    const file = await readFile('media', song.stems?.vocals ?? song.mediaFile)
    const analysis = await analyzeMedia(file, onProgress)
    const existing = await getMelody(songId)
    const annotated = existing?.source === 'ultrastar'
    await putMelody({
      songId,
      // Notas anotadas à mão valem mais que as extraídas: a análise só completa o resto.
      source: annotated ? 'ultrastar' : 'analise',
      notes: annotated ? existing.notes : analysis.notes,
      peaks: analysis.peaks,
      stereoWidth: song.stems ? existing?.stereoWidth : analysis.stereoWidth,
      fromVocals: !annotated && !!song.stems,
      version: MELODY_VERSION,
    })
    await library.patch(songId, { melody: 'ready', ...(song.duration > 0 ? {} : { duration: analysis.duration }) })
  } catch (err) {
    await library.patch(songId, { melody: 'failed' })
    throw err
  }
}

// Uma análise por vez: cada uma decodifica a música inteira na memória.
let queue: Promise<unknown> = Promise.resolve()

export function enqueueAnalysis(songId: string, onProgress?: (ratio: number) => void): Promise<void> {
  const run = queue.then(() => analyzeSong(songId, onProgress))
  queue = run.catch(() => {})
  return run.catch(() => {})
}

/** Ao abrir o app: retoma análises que ficaram pela metade (aba fechada no meio). */
export function resumePendingAnalyses(): void {
  for (const song of useLibrary.getState().songs) {
    if (song.melody === 'pending') void enqueueAnalysis(song.id)
    // Uma separação interrompida não tem como continuar: volta a ficar disponível para tentar de novo.
    if (song.separation === 'pending') void useLibrary.getState().patch(song.id, { separation: 'failed' })
  }
}

/** A letra salva só "conta" se ainda existir: usado depois de trocar ou apagar. */
export async function syncLyricsLevel(songId: string): Promise<void> {
  const doc = await getLyrics(songId)
  await useLibrary.getState().patch(songId, { lyrics: doc ? doc.level : 'none' })
}
