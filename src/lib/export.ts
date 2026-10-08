import { PACKAGE_EXTENSION, buildPackage } from './package'
import type { SongParts } from './package'
import { getLyrics, getMelody } from './storage/db'
import { readFile } from './storage/files'
import { buildExport } from './transfer'
import type { PlaylistInput } from './transfer'
import type { LyricsDoc, MelodyDoc, Song } from './types'

/**
 * Levar músicas para outro aparelho, de dois jeitos:
 *
 * - a lista: um arquivo pequeno com de onde veio cada música, a letra e as playlists. O outro
 *   aparelho baixa as músicas de novo e prepara cada uma;
 * - o pacote: a lista mais os arquivos em si (áudio ou vídeo, capa, voz separada) e o guia de
 *   notas. O outro aparelho só copia para dentro: fica tudo pronto para cantar.
 */

export interface PreparedExport {
  list: { bytes: number; songs: number; save: () => void }
  pack: { bytes: number; songs: number; save: () => void }
  /** Músicas que vieram de arquivo do computador: na lista elas não têm de onde ser baixadas. */
  fromFiles: number
  /** Músicas cujo arquivo não está mais neste navegador: não entram no pacote. */
  missing: number
}

/** Entrega um arquivo para o navegador salvar na pasta de downloads. */
function saveAs(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.append(link)
  link.click()
  link.remove()
  // O navegador usa o endereço enquanto salva, e um pacote grande leva minutos.
  setTimeout(() => URL.revokeObjectURL(url), 30 * 60_000)
}

function fileName(name: string, extension: string): string {
  // Data do aparelho, não a de Greenwich: perto da meia-noite as duas diferem.
  const today = new Date()
  const stamp = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  const slug = name
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 40)
  return `gogo-${slug || 'musicas'}-${stamp}.${extension}`
}

const extensionOf = (name: string) => /\.([a-z0-9]{1,5})$/i.exec(name)?.[1].toLowerCase() ?? ''
const stored = (dir: 'media' | 'covers', name: string | undefined): Promise<File | null> => (name ? readFile(dir, name).catch(() => null) : Promise.resolve(null))

/**
 * Deixa as duas exportações prontas e diz quanto cada uma pesa. Nada é salvo ainda, e nenhum
 * arquivo de música é lido: o pacote só aponta para os arquivos guardados no navegador.
 */
export async function prepareExport(name: string, songs: Song[], playlists: PlaylistInput[]): Promise<PreparedExport> {
  const lyrics = new Map<string, LyricsDoc>()
  const melodies = new Map<string, MelodyDoc>()
  const packed: Song[] = []
  const parts: SongParts[] = []

  for (const song of songs) {
    const [doc, melody, media, cover, instrumental, vocals] = await Promise.all([
      getLyrics(song.id),
      getMelody(song.id),
      stored('media', song.mediaFile),
      stored('covers', song.coverFile),
      stored('media', song.stems?.instrumental),
      stored('media', song.stems?.vocals),
    ])
    if (doc) lyrics.set(song.id, doc)
    if (melody) melodies.set(song.id, melody)
    if (!media) continue
    packed.push(song)
    parts.push({
      media,
      mediaExt: extensionOf(song.mediaFile) || (song.mediaKind === 'video' ? 'mp4' : 'm4a'),
      mediaMime: song.mime,
      ...(cover ? { cover } : {}),
      ...(instrumental && vocals ? { instrumental, vocals } : {}),
      // Guia ainda em análise não viaja pela metade: o outro aparelho analisa.
      ...(melody && song.melody === 'ready' ? { melody } : {}),
    })
  }

  const now = Date.now()
  const list = new Blob([JSON.stringify(buildExport({ name, songs, lyrics, melodies, playlists, now }))], { type: 'application/json' })
  const pack = buildPackage(buildExport({ name, songs: packed, lyrics, melodies, playlists, now, full: true }), parts)

  return {
    list: { bytes: list.size, songs: songs.length, save: () => saveAs(list, fileName(name, 'json')) },
    pack: { bytes: pack.blob.size, songs: packed.length, save: () => saveAs(pack.blob, fileName(name, PACKAGE_EXTENSION)) },
    fromFiles: songs.filter((song) => song.source.type === 'file').length,
    missing: songs.length - packed.length,
  }
}
