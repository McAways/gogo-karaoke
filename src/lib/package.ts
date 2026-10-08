import { readExportedPlaylists, readExportedSong, readNotes } from './transfer'
import type { ExportFile, ExportedPlaylist, ExportedSong } from './transfer'
import type { MelodyDoc, RefNote } from './types'

/**
 * Pacote com as músicas completas: tudo o que o arquivo de lista leva (de onde veio cada
 * música, a letra, as playlists) mais os arquivos em si (áudio ou vídeo, capa, voz separada) e
 * o guia de notas. Quem abre o pacote em outro aparelho não baixa nem prepara nada.
 *
 * Formato: 8 bytes de assinatura, 4 com o tamanho do cabeçalho, o cabeçalho em JSON e, em
 * seguida, os arquivos colados um atrás do outro, sem compressão (áudio e vídeo já são
 * comprimidos). O cabeçalho diz onde começa e quanto mede cada arquivo.
 *
 * Nada aqui lê um arquivo inteiro para a memória: o pacote é montado com referências aos
 * arquivos (um Blob feito de Blobs) e lido por fatias. Medido no navegador com 4,5 GB.
 */

export const PACKAGE_EXTENSION = 'gogo'
const SIGNATURE = 'GOGOPKG1'
const PREAMBLE = SIGNATURE.length + 4
/** Cabeçalho maior que isto não é de um pacote de verdade: evita ler um arquivo qualquer inteiro. */
const MAX_HEADER = 512 * 1024 * 1024

const NOT_A_PACKAGE = 'Esse arquivo não é um pacote exportado pelo Gogó.'
const INCOMPLETE = 'O pacote está incompleto: a cópia do arquivo pode ter sido interrompida. Copie ou exporte de novo.'

export interface PackedFile {
  /** Posição do primeiro byte, contada a partir do fim do cabeçalho. */
  offset: number
  size: number
  /** Extensão, sem o ponto. */
  ext: string
  mime: string
}

export interface PackedFiles {
  media: PackedFile
  cover?: PackedFile
  /** As duas faixas separadas viajam juntas ou não viajam. */
  instrumental?: PackedFile
  vocals?: PackedFile
}

/** O guia de notas como estava guardado, com o envelope em números comuns (JSON não tem Float32Array). */
export interface PackedMelody {
  source: MelodyDoc['source']
  notes: RefNote[]
  peaks?: number[]
  stereoWidth?: number
  fromVocals?: boolean
  version: number
}

export interface PackedSong extends ExportedSong {
  /** Ausente quando a música ainda não tinha sido analisada: o outro aparelho analisa. */
  melody?: PackedMelody
  files: PackedFiles
}

export interface PackageHeader {
  app: 'gogo-karaoke'
  kind: 'pacote'
  version: 1
  exportedAt: number
  name: string
  songs: PackedSong[]
  playlists: ExportedPlaylist[]
}

/** Os arquivos de uma música, na mesma ordem das músicas da lista. */
export interface SongParts {
  media: Blob
  mediaExt: string
  mediaMime: string
  cover?: Blob
  instrumental?: Blob
  vocals?: Blob
  melody?: MelodyDoc
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null
const round3 = (value: number) => Math.round(value * 1000) / 1000

export function packMelody(doc: MelodyDoc): PackedMelody {
  return {
    source: doc.source,
    notes: doc.notes,
    ...(doc.peaks ? { peaks: Array.from(doc.peaks, round3) } : {}),
    ...(doc.stereoWidth !== undefined ? { stereoWidth: doc.stereoWidth } : {}),
    ...(doc.fromVocals ? { fromVocals: true } : {}),
    version: doc.version,
  }
}

export function unpackMelody(packed: PackedMelody, songId: string): MelodyDoc {
  return {
    songId,
    source: packed.source,
    notes: packed.notes,
    ...(packed.peaks ? { peaks: Float32Array.from(packed.peaks) } : {}),
    ...(packed.stereoWidth !== undefined ? { stereoWidth: packed.stereoWidth } : {}),
    ...(packed.fromVocals ? { fromVocals: true } : {}),
    version: packed.version,
  }
}

/**
 * Monta o pacote. `list` é a mesma lista do arquivo de lista; `parts` traz os arquivos de cada
 * música, na mesma ordem. O Blob devolvido só aponta para os arquivos: nada é copiado aqui.
 */
export function buildPackage(list: ExportFile, parts: readonly SongParts[]): { blob: Blob; header: PackageHeader } {
  if (parts.length !== list.songs.length) throw new Error('Cada música do pacote precisa dos seus arquivos.')

  const chunks: Blob[] = []
  let offset = 0
  const place = (blob: Blob, ext: string, mime: string): PackedFile => {
    const ref = { offset, size: blob.size, ext, mime }
    chunks.push(blob)
    offset += blob.size
    return ref
  }

  const songs = list.songs.map((song, index): PackedSong => {
    const part = parts[index]
    const files: PackedFiles = { media: place(part.media, part.mediaExt.toLowerCase(), part.mediaMime) }
    if (part.cover) files.cover = place(part.cover, 'jpg', 'image/jpeg')
    if (part.instrumental && part.vocals) {
      files.instrumental = place(part.instrumental, 'm4a', 'audio/mp4')
      files.vocals = place(part.vocals, 'm4a', 'audio/mp4')
    }
    return { ...song, ...(part.melody ? { melody: packMelody(part.melody) } : {}), files }
  })

  const header: PackageHeader = { app: 'gogo-karaoke', kind: 'pacote', version: 1, exportedAt: list.exportedAt, name: list.name, songs, playlists: list.playlists }
  const body = new TextEncoder().encode(JSON.stringify(header))
  const preamble = new Uint8Array(PREAMBLE)
  preamble.set(new TextEncoder().encode(SIGNATURE))
  new DataView(preamble.buffer).setUint32(SIGNATURE.length, body.byteLength, true)
  return { blob: new Blob([preamble, body, ...chunks], { type: 'application/octet-stream' }), header }
}

/** true quando o arquivo começa com a assinatura do pacote. Lê só os primeiros bytes. */
export async function isPackage(file: Blob): Promise<boolean> {
  if (file.size < PREAMBLE) return false
  return new TextDecoder().decode(await file.slice(0, SIGNATURE.length).arrayBuffer()) === SIGNATURE
}

function readFileRef(raw: unknown): PackedFile | null {
  if (!isRecord(raw)) return null
  const { offset, size, ext, mime } = raw
  if (typeof offset !== 'number' || typeof size !== 'number' || !Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 0 || size <= 0) return null
  // A extensão vira nome de arquivo no navegador: só letras e números.
  if (typeof ext !== 'string' || !/^[a-z0-9]{1,5}$/.test(ext)) return null
  return { offset, size, ext, mime: typeof mime === 'string' ? mime.slice(0, 80) : 'application/octet-stream' }
}

function readFiles(raw: unknown): PackedFiles | null {
  if (!isRecord(raw)) return null
  const media = readFileRef(raw.media)
  if (!media) return null
  const cover = readFileRef(raw.cover)
  const instrumental = readFileRef(raw.instrumental)
  const vocals = readFileRef(raw.vocals)
  return { media, ...(cover ? { cover } : {}), ...(instrumental && vocals ? { instrumental, vocals } : {}) }
}

function readMelody(raw: unknown): PackedMelody | undefined {
  if (!isRecord(raw)) return undefined
  const notes = readNotes(raw.notes)
  if (!notes) return undefined
  const peaks = Array.isArray(raw.peaks) ? raw.peaks.slice(0, 20_000).map((value) => (typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0)) : undefined
  return {
    source: raw.source === 'ultrastar' ? 'ultrastar' : 'analise',
    notes,
    ...(peaks && peaks.length > 0 ? { peaks } : {}),
    ...(typeof raw.stereoWidth === 'number' && Number.isFinite(raw.stereoWidth) ? { stereoWidth: raw.stereoWidth } : {}),
    ...(raw.fromVocals === true ? { fromVocals: true } : {}),
    version: typeof raw.version === 'number' ? raw.version : 1,
  }
}

export interface OpenPackage {
  header: PackageHeader
  /** O arquivo guardado no pacote, como uma fatia dele: nada é copiado. */
  slice: (ref: PackedFile) => Blob
}

/** Abre um pacote: lê e confere o cabeçalho. Lança um erro com mensagem para o usuário quando o arquivo não serve. */
export async function readPackage(file: Blob): Promise<OpenPackage> {
  if (!(await isPackage(file))) throw new Error(NOT_A_PACKAGE)
  const length = new DataView(await file.slice(SIGNATURE.length, PREAMBLE).arrayBuffer()).getUint32(0, true)
  if (length === 0 || length > MAX_HEADER) throw new Error(NOT_A_PACKAGE)
  const start = PREAMBLE + length
  if (start > file.size) throw new Error(INCOMPLETE)

  let data: unknown
  try {
    data = JSON.parse(await file.slice(PREAMBLE, start).text())
  } catch {
    throw new Error(NOT_A_PACKAGE)
  }
  if (!isRecord(data) || data.app !== 'gogo-karaoke' || data.kind !== 'pacote' || !Array.isArray(data.songs)) throw new Error(NOT_A_PACKAGE)
  if (typeof data.version === 'number' && data.version > 1) throw new Error('Esse pacote foi exportado por uma versão mais nova do app. Atualize o app para abrir.')

  const room = file.size - start
  const songs: PackedSong[] = []
  // Posição no pacote para posição na lista limpa: músicas inválidas ficam de fora.
  const kept = new Map<number, number>()
  data.songs.forEach((raw: unknown, index: number) => {
    const song = readExportedSong(raw)
    const files = isRecord(raw) ? readFiles(raw.files) : null
    if (!song || !files) return
    // Um arquivo que passa do fim do pacote: a cópia foi cortada no meio.
    if (Object.values(files).some((ref) => ref.offset + ref.size > room)) throw new Error(INCOMPLETE)
    const melody = isRecord(raw) ? readMelody(raw.melody) : undefined
    kept.set(index, songs.length)
    songs.push({ ...song, ...(melody ? { melody } : {}), files })
  })
  if (songs.length === 0) throw new Error('O pacote não tem nenhuma música.')

  return {
    header: {
      app: 'gogo-karaoke',
      kind: 'pacote',
      version: 1,
      exportedAt: typeof data.exportedAt === 'number' ? data.exportedAt : 0,
      name: typeof data.name === 'string' && data.name.trim() ? data.name.trim().slice(0, 80) : 'Pacote importado',
      songs,
      playlists: readExportedPlaylists(data.playlists, kept),
    },
    slice: (ref) => file.slice(start + ref.offset, start + ref.offset + ref.size, ref.mime),
  }
}

/** Soma dos arquivos das músicas dadas, em bytes. */
export function packedBytes(songs: readonly PackedSong[]): number {
  return songs.reduce((total, song) => total + Object.values(song.files).reduce((sum, ref) => sum + ref.size, 0), 0)
}
