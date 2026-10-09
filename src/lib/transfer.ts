import type { LyricLine, LyricsDoc, MediaKind, MelodyDoc, RefNote, Song, SongSource } from './types'

/**
 * Levar a biblioteca para outro aparelho, e montar listas de músicas para baixar.
 *
 * O arquivo exportado é uma lista, não uma cópia: guarda de onde cada música veio (o vídeo
 * do YouTube), a letra já sincronizada e as playlists. No outro aparelho o app baixa tudo de
 * novo a partir disso, sem ninguém precisar procurar música por música.
 */

export interface ExportedLyrics {
  lines: LyricLine[]
  plain?: string
  level: LyricsDoc['level']
  source: LyricsDoc['source']
  lrclibId?: number
  timing?: 'audio'
  alignment?: LyricsDoc['alignment']
  /** Só no pacote com as músicas completas: a sincronia de antes da medição pelo áudio, para poder desfazer. */
  previous?: LyricsDoc['previous']
}

export interface ExportedSong {
  title: string
  artist: string
  album?: string
  duration: number
  mediaKind: MediaKind
  source: SongSource
  lyricOffset: number
  lyrics?: ExportedLyrics
  /** Só as notas anotadas à mão (UltraStar). O guia tirado do áudio é refeito no outro aparelho. */
  notes?: RefNote[]
}

export interface ExportedPlaylist {
  name: string
  /** Posições na lista de músicas do arquivo. */
  songs: number[]
  /** Presente quando a lista é um álbum trazido inteiro: assim ele continua álbum no outro aparelho. */
  kind?: 'album'
  album?: string
  artist?: string
}

export interface ExportFile {
  app: 'gogo-karaoke'
  kind: 'lista'
  version: 1
  exportedAt: number
  name: string
  songs: ExportedSong[]
  playlists: ExportedPlaylist[]
}

/** Uma playlist da biblioteca, do jeito que entra na exportação. */
export interface PlaylistInput {
  name: string
  songIds: string[]
  kind?: 'album'
  album?: string
  artist?: string
}

export function buildExport(input: {
  name: string
  songs: Song[]
  lyrics: Map<string, LyricsDoc>
  melodies: Map<string, MelodyDoc>
  playlists: PlaylistInput[]
  now: number
  /** true = para o pacote com as músicas completas: leva também a sincronia anterior à medição. */
  full?: boolean
}): ExportFile {
  const position = new Map(input.songs.map((song, index) => [song.id, index]))
  const songs = input.songs.map((song): ExportedSong => {
    const doc = input.lyrics.get(song.id)
    const melody = input.melodies.get(song.id)
    return {
      title: song.title,
      artist: song.artist,
      ...(song.album ? { album: song.album } : {}),
      duration: song.duration,
      mediaKind: song.mediaKind,
      source: song.source,
      lyricOffset: song.lyricOffset,
      ...(doc
        ? {
            lyrics: {
              lines: doc.lines,
              ...(doc.plain ? { plain: doc.plain } : {}),
              level: doc.level,
              source: doc.source,
              ...(doc.lrclibId !== undefined ? { lrclibId: doc.lrclibId } : {}),
              ...(doc.timing ? { timing: doc.timing } : {}),
              ...(doc.alignment ? { alignment: doc.alignment } : {}),
              ...(input.full && doc.previous ? { previous: doc.previous } : {}),
            },
          }
        : {}),
      ...(melody?.source === 'ultrastar' ? { notes: melody.notes } : {}),
    }
  })
  const playlists = input.playlists
    .map((playlist): ExportedPlaylist => ({
      name: playlist.name,
      songs: playlist.songIds.map((id) => position.get(id)).filter((index): index is number => index !== undefined),
      ...(playlist.kind === 'album' ? { kind: 'album', ...(playlist.album ? { album: playlist.album } : {}), ...(playlist.artist ? { artist: playlist.artist } : {}) } : {}),
    }))
    .filter((playlist) => playlist.songs.length > 0)
  return { app: 'gogo-karaoke', kind: 'lista', version: 1, exportedAt: input.now, name: input.name, songs, playlists }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

function readSource(raw: unknown): SongSource | null {
  if (!isRecord(raw)) return null
  if (raw.type === 'youtube' && typeof raw.url === 'string' && typeof raw.videoId === 'string') {
    return {
      type: 'youtube',
      url: raw.url,
      videoId: raw.videoId,
      ...(typeof raw.channel === 'string' ? { channel: raw.channel } : {}),
      ...(typeof raw.title === 'string' ? { title: raw.title } : {}),
    }
  }
  if (raw.type === 'file' && typeof raw.name === 'string') return { type: 'file', name: raw.name }
  return null
}

function readLines(raw: unknown[]): LyricLine[] {
  const lines: LyricLine[] = []
  for (const item of raw) {
    if (!isRecord(item) || typeof item.start !== 'number' || typeof item.end !== 'number' || typeof item.text !== 'string') continue
    const words = Array.isArray(item.words)
      ? item.words.flatMap((word) =>
          isRecord(word) && typeof word.text === 'string' && typeof word.start === 'number' && typeof word.end === 'number'
            ? [{ text: word.text, start: word.start, end: word.end, ...(word.glue === true ? { glue: true } : {}) }]
            : [],
        )
      : []
    lines.push({ start: item.start, end: item.end, text: item.text, words })
  }
  return lines
}

const isLevel = (value: unknown): value is ExportedLyrics['level'] => value === 'word' || value === 'line' || value === 'plain'

function readLyrics(raw: unknown): ExportedLyrics | undefined {
  if (!isRecord(raw) || !Array.isArray(raw.lines)) return undefined
  const lines = readLines(raw.lines)
  const level = isLevel(raw.level) ? raw.level : lines.length > 0 ? 'line' : 'plain'
  const source = raw.source === 'lrclib' || raw.source === 'arquivo' || raw.source === 'ultrastar' || raw.source === 'manual' ? raw.source : 'arquivo'
  const plain = typeof raw.plain === 'string' ? raw.plain : undefined
  if (lines.length === 0 && !plain) return undefined
  const alignment = isRecord(raw.alignment) && typeof raw.alignment.at === 'number' ? (raw.alignment as unknown as ExportedLyrics['alignment']) : undefined
  const before = raw.previous
  const previous =
    isRecord(before) && Array.isArray(before.lines)
      ? { lines: readLines(before.lines), level: isLevel(before.level) ? before.level : ('line' as const), lyricOffset: typeof before.lyricOffset === 'number' ? before.lyricOffset : 0 }
      : undefined
  return {
    lines,
    ...(plain ? { plain } : {}),
    level,
    source,
    ...(typeof raw.lrclibId === 'number' ? { lrclibId: raw.lrclibId } : {}),
    ...(raw.timing === 'audio' ? { timing: 'audio' as const } : {}),
    ...(alignment ? { alignment } : {}),
    ...(previous ? { previous } : {}),
  }
}

/** Notas de um guia. undefined quando não há nenhuma nota válida. */
export function readNotes(raw: unknown): RefNote[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const notes = raw.flatMap((note) =>
    isRecord(note) && typeof note.start === 'number' && typeof note.end === 'number' && (typeof note.midi === 'number' || note.midi === null)
      ? [{ start: note.start, end: note.end, midi: note.midi, conf: typeof note.conf === 'number' ? note.conf : 1 }]
      : [],
  )
  return notes.length > 0 ? notes : undefined
}

/** Uma música do arquivo. null quando falta o nome ou de onde ela veio. */
export function readExportedSong(raw: unknown): ExportedSong | null {
  if (!isRecord(raw) || typeof raw.title !== 'string' || !raw.title.trim()) return null
  const source = readSource(raw.source)
  if (!source) return null
  const lyrics = readLyrics(raw.lyrics)
  const notes = readNotes(raw.notes)
  return {
    title: raw.title.trim(),
    artist: typeof raw.artist === 'string' ? raw.artist.trim() : '',
    ...(typeof raw.album === 'string' && raw.album ? { album: raw.album } : {}),
    duration: typeof raw.duration === 'number' && raw.duration > 0 ? raw.duration : 0,
    mediaKind: raw.mediaKind === 'video' ? 'video' : 'audio',
    source,
    lyricOffset: typeof raw.lyricOffset === 'number' ? raw.lyricOffset : 0,
    ...(lyrics ? { lyrics } : {}),
    ...(notes ? { notes } : {}),
  }
}

/** As playlists do arquivo. `kept` leva a posição da música no arquivo à posição na lista já limpa. */
export function readExportedPlaylists(raw: unknown, kept: Map<number, number>): ExportedPlaylist[] {
  return (Array.isArray(raw) ? raw : []).flatMap((entry): ExportedPlaylist[] => {
    if (!isRecord(entry) || typeof entry.name !== 'string' || !Array.isArray(entry.songs)) return []
    const list = entry.songs.map((index) => (typeof index === 'number' ? kept.get(index) : undefined)).filter((index): index is number => index !== undefined)
    if (list.length === 0) return []
    const album =
      entry.kind === 'album'
        ? { kind: 'album' as const, ...(typeof entry.album === 'string' && entry.album ? { album: entry.album } : {}), ...(typeof entry.artist === 'string' && entry.artist ? { artist: entry.artist } : {}) }
        : {}
    return [{ name: entry.name.trim().slice(0, 60), songs: list, ...album }]
  })
}

/** Lê um arquivo exportado. Lança um erro com mensagem para o usuário quando o arquivo não serve. */
export function parseExport(text: string): ExportFile {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error('Esse arquivo não é uma lista exportada pelo Gogó.')
  }
  if (!isRecord(data) || data.app !== 'gogo-karaoke' || data.kind !== 'lista' || !Array.isArray(data.songs)) {
    throw new Error('Esse arquivo não é uma lista exportada pelo Gogó.')
  }
  if (typeof data.version === 'number' && data.version > 1) throw new Error('Essa lista foi exportada por uma versão mais nova do app. Atualize o app para abrir.')

  const songs: ExportedSong[] = []
  // Posição no arquivo para posição na lista limpa: músicas inválidas ficam de fora.
  const kept = new Map<number, number>()
  data.songs.forEach((raw: unknown, index: number) => {
    const song = readExportedSong(raw)
    if (!song) return
    kept.set(index, songs.length)
    songs.push(song)
  })
  if (songs.length === 0) throw new Error('A lista não tem nenhuma música.')

  const playlists = readExportedPlaylists(data.playlists, kept)

  return {
    app: 'gogo-karaoke',
    kind: 'lista',
    version: 1,
    exportedAt: typeof data.exportedAt === 'number' ? data.exportedAt : 0,
    name: typeof data.name === 'string' && data.name.trim() ? data.name.trim().slice(0, 80) : 'Lista importada',
    songs,
    playlists,
  }
}

// ---------- achar o vídeo de uma faixa ----------

export interface WantedTrack {
  title: string
  artist: string
  /** Segundos. 0 = desconhecida. */
  duration: number
}

export interface VideoLike {
  id: string
  title: string
  channel: string
  duration: number
}

const clean = (text: string): string =>
  text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

/** Versões que não são a gravação pedida, a não ser que o próprio nome da faixa diga que é. */
const OTHER_VERSIONS: Array<[RegExp, number]> = [
  // Estas têm o nome e a duração certos e mesmo assim não servem: o desconto precisa vencer tudo isso.
  [/\b(karaoke|playback|instrumental|backing track)\b/, 10],
  [/\b(cover|tribute|tributo)\b/, 8],
  [/\b(react|reaction|reagindo|review|tutorial|aula|cifra|how to)\b/, 10],
  [/\b(sped up|speed up|slowed|nightcore|8d|bass boosted|reverb)\b/, 8],
  [/\b(ao vivo|live|acustico|acoustic|unplugged)\b/, 3],
  [/\b(remix|mashup|medley|pot pourri|pout pourri)\b/, 3],
]

/** Palavras que começam nome de artista sem dizer quem ele é. */
const GENERIC_WORDS = new Set(['the', 'los', 'las', 'banda', 'grupo', 'dupla', 'trio'])

/** O quanto um vídeo parece ser a gravação pedida. Quanto maior, melhor. */
export function videoScore(track: WantedTrack, video: VideoLike): number {
  const title = clean(video.title)
  const channel = clean(video.channel)
  const wantedTitle = clean(track.title)
  const wantedArtist = clean(track.artist)
  let score = 0

  if (wantedTitle && title.includes(wantedTitle)) score += 4
  else {
    const words = wantedTitle.split(' ').filter((word) => word.length > 2)
    score += words.length > 0 ? (4 * words.filter((word) => title.includes(word)).length) / words.length - 1.5 : 0
  }

  // Basta o primeiro nome do artista aparecer no título ou no canal: "Chitãozinho & Xororó",
  // "Chitãozinho e Xororó" e "Chitãozinho, Xororó" são a mesma dupla.
  const first = wantedArtist.split(' ').find((word) => word.length > 2 && !GENERIC_WORDS.has(word))
  if (first) {
    if (title.includes(first) || channel.includes(first)) score += 2.5
    else score -= 1.5
  }

  if (track.duration > 0 && video.duration > 0) {
    const gap = Math.abs(video.duration - track.duration)
    score += gap <= 2 ? 4 : gap <= 5 ? 3 : gap <= 15 ? 1 : gap <= 45 ? -1 : -4
  }

  // Faixa de álbum publicada pela gravadora: é a gravação original, sem introdução de clipe.
  if (/ topic$/.test(channel) || /\b(official audio|audio oficial|audio)\b/.test(title)) score += 1

  for (const [pattern, cost] of OTHER_VERSIONS) {
    if (pattern.test(title) && !pattern.test(wantedTitle)) score -= cost
  }
  return score
}

/** Os vídeos da busca, do que mais parece ser a faixa pedida para o que menos parece. */
export function rankVideos<T extends VideoLike>(track: WantedTrack, videos: readonly T[]): T[] {
  return videos
    .map((video, index) => ({ video, index, score: videoScore(track, video) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.video)
}

/** Abaixo disto, nem o melhor vídeo parece ser a faixa: melhor não baixar sozinho. */
export const MIN_VIDEO_SCORE = 3.5

/** A música da biblioteca que corresponde a um item da lista, pelo vídeo ou pelo nome. */
export function findInLibrary(item: { title: string; artist: string; videoId?: string }, songs: readonly Song[]): Song | undefined {
  if (item.videoId) {
    const same = songs.find((song) => song.source.type === 'youtube' && song.source.videoId === item.videoId)
    if (same) return same
  }
  const title = clean(item.title)
  const artist = clean(item.artist)
  if (!title) return undefined
  return songs.find((song) => clean(song.title) === title && (!artist || !clean(song.artist) || clean(song.artist) === artist))
}

/**
 * Tira do nome da faixa os sufixos de catálogo ("- 2004 Remaster", "- Single Version"), que
 * atrapalham a busca do vídeo e da letra. O que muda a gravação de verdade fica (ao vivo,
 * acústico, remix).
 */
export function tidyTrackTitle(title: string): string {
  const keep = /ao vivo|live|ac[uú]stic|acoustic|remix|unplugged/i
  const drop = /remaster|version|vers[aã]o|edit\b|mix\b|mono|stereo|bonus|deluxe|anniversary|edition|edi[cç][aã]o|from |trilha|soundtrack|original/i
  let out = title.trim()
  const dash = out.lastIndexOf(' - ')
  if (dash > 0) {
    const suffix = out.slice(dash + 3)
    if (drop.test(suffix) && !keep.test(suffix)) out = out.slice(0, dash)
  }
  out = out.replace(/\s*[([]([^)\]]*)[)\]]\s*$/, (whole, inner) => (drop.test(inner) && !keep.test(inner) ? '' : whole))
  return out.trim() || title.trim()
}

/** Texto de busca para achar a faixa no YouTube. */
export function searchQueryFor(track: WantedTrack): string {
  return [track.artist, track.title].filter(Boolean).join(' ').trim()
}

/** Diz se o texto é um link do Spotify que o app sabe ler, e de quê: playlist, álbum ou música. */
export function spotifyLinkKind(text: string): 'playlist' | 'album' | 'track' | null {
  const match = /(?:open\.spotify\.com\/(?:intl-[a-z-]+\/)?(?:embed\/)?(playlist|album|track)\/|spotify:(playlist|album|track):)[A-Za-z0-9]{16,40}/.exec(text.trim())
  return match ? ((match[1] ?? match[2]) as 'playlist' | 'album' | 'track') : null
}
