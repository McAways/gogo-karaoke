import { describe, expect, it } from 'vitest'
import { buildPackage, isPackage, packMelody, packedBytes, readPackage, unpackMelody } from './package'
import type { SongParts } from './package'
import { buildExport } from './transfer'
import type { LyricsDoc, MelodyDoc, Song } from './types'

const song = (id: string, title: string, videoId: string | null, extra: Partial<Song> = {}): Song => ({
  id,
  title,
  artist: 'Banda',
  duration: 200,
  mediaKind: 'audio',
  mediaFile: `${id}.m4a`,
  mime: 'audio/mp4',
  size: 1000,
  source: videoId ? { type: 'youtube', url: `https://www.youtube.com/watch?v=${videoId}`, videoId } : { type: 'file', name: `${title}.mp3` },
  addedAt: 1,
  lyrics: 'word',
  lyricOffset: 0.2,
  melody: 'ready',
  plays: 3,
  bestScore: 9000,
  ...extra,
})

const bytes = (text: string) => new Blob([text])
const textOf = (blob: Blob) => blob.text()

const lyrics: LyricsDoc = {
  songId: 'a',
  lines: [{ start: 1, end: 3, text: 'Bom dia', words: [{ text: 'Bom', start: 1, end: 1.5 }, { text: 'dia', start: 1.5, end: 3 }] }],
  level: 'word',
  source: 'lrclib',
  timing: 'audio',
  alignment: { at: 5, score: 0.3, heard: 0.9, tied: 0 },
  previous: { lines: [{ start: 1.2, end: 3, text: 'Bom dia', words: [] }], level: 'line', lyricOffset: 0.4 },
  updatedAt: 9,
}

const melody: MelodyDoc = {
  songId: 'a',
  source: 'analise',
  notes: [{ start: 1, end: 2, midi: 60.25, conf: 0.8 }],
  peaks: Float32Array.from([0, 0.12345, 1]),
  stereoWidth: 0.4,
  fromVocals: true,
  version: 1,
}

function sample() {
  const songs = [song('a', 'Com Tudo', 'vid00000001', { album: 'Disco' }), song('b', 'Do Computador', null, { mediaKind: 'video', mediaFile: 'b.mp4', mime: 'video/mp4' })]
  const list = buildExport({
    name: 'Minha biblioteca',
    songs,
    lyrics: new Map([['a', lyrics]]),
    melodies: new Map([['a', melody]]),
    playlists: [
      { name: 'Festa', songIds: ['b', 'a'] },
      { name: 'Disco, de Banda', songIds: ['a'], kind: 'album', album: 'Disco', artist: 'Banda' },
    ],
    now: 123,
    full: true,
  })
  const parts: SongParts[] = [
    { media: bytes('AUDIO-DA-PRIMEIRA'), mediaExt: 'm4a', mediaMime: 'audio/mp4', cover: bytes('CAPA'), instrumental: bytes('SO-INSTRUMENTAL'), vocals: bytes('SO-VOZ'), melody },
    { media: bytes('VIDEO-DA-SEGUNDA-BEM-MAIOR'), mediaExt: 'MP4', mediaMime: 'video/mp4' },
  ]
  return { list, parts, ...buildPackage(list, parts) }
}

describe('pacote com as músicas completas', () => {
  it('vai e volta com os arquivos byte a byte, a letra, o guia e as playlists', async () => {
    const { blob } = sample()
    expect(await isPackage(blob)).toBe(true)
    const { header, slice } = await readPackage(blob)

    expect(header.name).toBe('Minha biblioteca')
    expect(header.songs.map((s) => s.title)).toEqual(['Com Tudo', 'Do Computador'])
    const [first, second] = header.songs

    expect(await textOf(slice(first.files.media))).toBe('AUDIO-DA-PRIMEIRA')
    expect(await textOf(slice(first.files.cover!))).toBe('CAPA')
    expect(await textOf(slice(first.files.instrumental!))).toBe('SO-INSTRUMENTAL')
    expect(await textOf(slice(first.files.vocals!))).toBe('SO-VOZ')
    expect(await textOf(slice(second.files.media))).toBe('VIDEO-DA-SEGUNDA-BEM-MAIOR')
    expect(first.files.media).toMatchObject({ ext: 'm4a', mime: 'audio/mp4', size: 17 })
    expect(second.files.media).toMatchObject({ ext: 'mp4', mime: 'video/mp4' })
    expect(second.files.cover).toBeUndefined()
    expect(packedBytes(header.songs)).toBe(17 + 4 + 15 + 6 + 26)

    // A letra medida no áudio viaja com a sincronia de antes, para dar para desfazer lá também.
    expect(first.lyrics?.timing).toBe('audio')
    expect(first.lyrics?.previous).toEqual({ lines: [{ start: 1.2, end: 3, text: 'Bom dia', words: [] }], level: 'line', lyricOffset: 0.4 })
    expect(first.lyricOffset).toBe(0.2)
    expect(first.album).toBe('Disco')
    // Música que veio de arquivo do computador vai junto: no pacote ela tem o próprio arquivo.
    expect(second.source).toEqual({ type: 'file', name: 'Do Computador.mp3' })
    expect(second.melody).toBeUndefined()

    expect(header.playlists).toEqual([
      { name: 'Festa', songs: [1, 0] },
      { name: 'Disco, de Banda', songs: [0], kind: 'album', album: 'Disco', artist: 'Banda' },
    ])
  })

  it('leva o guia de notas pronto, com o envelope', async () => {
    const { blob } = sample()
    const { header } = await readPackage(blob)
    const back = unpackMelody(header.songs[0].melody!, 'novo-id')
    expect(back).toMatchObject({ songId: 'novo-id', source: 'analise', stereoWidth: 0.4, fromVocals: true, version: 1 })
    expect(back.notes).toEqual(melody.notes)
    expect(back.peaks).toBeInstanceOf(Float32Array)
    expect(Array.from(back.peaks!)).toEqual([0, expect.closeTo(0.123, 5), 1])
    // O que é de quem cantou não viaja.
    const text = JSON.stringify(header)
    expect(text).not.toContain('bestScore')
    expect(text).not.toContain('plays')
  })

  it('não confunde o envelope com números comuns ao guardar', () => {
    const packed = packMelody({ songId: 'x', source: 'ultrastar', notes: [{ start: 0, end: 1, midi: null, conf: 1 }], version: 2 })
    expect(packed).toEqual({ source: 'ultrastar', notes: [{ start: 0, end: 1, midi: null, conf: 1 }], version: 2 })
  })

  it('recusa o que não é pacote, com mensagem clara', async () => {
    await expect(readPackage(new Blob(['{"app":"gogo-karaoke","kind":"lista","songs":[]}']))).rejects.toThrow('não é um pacote')
    await expect(readPackage(new Blob(['x']))).rejects.toThrow('não é um pacote')
    expect(await isPackage(new Blob(['GOGOPKG']))).toBe(false)
    // Assinatura certa, cabeçalho que não é JSON.
    const fake = new Uint8Array(12 + 5)
    fake.set(new TextEncoder().encode('GOGOPKG1'))
    new DataView(fake.buffer).setUint32(8, 5, true)
    fake.set(new TextEncoder().encode('lixo!'), 12)
    await expect(readPackage(new Blob([fake]))).rejects.toThrow('não é um pacote')
  })

  it('avisa quando o pacote foi cortado no meio da cópia', async () => {
    const { blob } = sample()
    await expect(readPackage(blob.slice(0, blob.size - 10))).rejects.toThrow('incompleto')
    await expect(readPackage(blob.slice(0, 40))).rejects.toThrow('incompleto')
  })

  it('recusa pacote de versão mais nova e pacote sem música', async () => {
    const pack = (header: unknown) => {
      const body = new TextEncoder().encode(JSON.stringify(header))
      const preamble = new Uint8Array(12)
      preamble.set(new TextEncoder().encode('GOGOPKG1'))
      new DataView(preamble.buffer).setUint32(8, body.byteLength, true)
      return new Blob([preamble, body, 'dados'])
    }
    await expect(readPackage(pack({ app: 'gogo-karaoke', kind: 'pacote', version: 9, songs: [{}] }))).rejects.toThrow('versão mais nova')
    await expect(readPackage(pack({ app: 'gogo-karaoke', kind: 'pacote', version: 1, songs: [] }))).rejects.toThrow('nenhuma música')
    // Música sem arquivo, ou com extensão que não é só letras e números, fica de fora.
    const source = { type: 'youtube', url: 'u', videoId: 'v' }
    const odd = pack({
      app: 'gogo-karaoke',
      kind: 'pacote',
      version: 1,
      songs: [
        { title: 'Sem arquivo', source },
        { title: 'Extensão estranha', source, files: { media: { offset: 0, size: 2, ext: '../x', mime: 'audio/mp4' } } },
        { title: 'Boa', source, files: { media: { offset: 0, size: 5, ext: 'm4a', mime: 'audio/mp4' } } },
      ],
      playlists: [{ name: 'P', songs: [0, 1, 2] }],
    })
    const { header, slice } = await readPackage(odd)
    expect(header.songs.map((s) => s.title)).toEqual(['Boa'])
    expect(header.playlists).toEqual([{ name: 'P', songs: [0] }])
    expect(await textOf(slice(header.songs[0].files.media))).toBe('dados')
  })

  it('não lê os arquivos para montar: o pacote é feito de referências', () => {
    let read = 0
    const spy = (text: string) => {
      const blob = new Blob([text])
      for (const method of ['arrayBuffer', 'text', 'stream'] as const) {
        const original = blob[method].bind(blob) as () => unknown
        Object.defineProperty(blob, method, { value: () => (read++, original()) })
      }
      return blob
    }
    const { list } = sample()
    buildPackage(list, [
      { media: spy('AUDIO'), mediaExt: 'm4a', mediaMime: 'audio/mp4' },
      { media: spy('VIDEO'), mediaExt: 'mp4', mediaMime: 'video/mp4' },
    ])
    expect(read).toBe(0)
  })
})
