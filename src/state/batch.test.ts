import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { VideoSummary } from '@/lib/helper'
import type { ExportFile } from '@/lib/transfer'
import type { Song } from '@/lib/types'
import { PARALLEL, useBatch } from './batch'

const mocks = vi.hoisted(() => ({
  addYoutube: vi.fn(),
  searchVideos: vi.fn(),
  upsertPlaylist: vi.fn(),
  songs: [] as unknown[],
}))

// A fila de downloads é testada sozinha: o que baixa, o que guarda e o que busca são de mentira.
vi.mock('./jobs', () => ({ useJobs: { getState: () => ({ addYoutube: mocks.addYoutube }) } }))
vi.mock('./library', () => ({ useLibrary: { getState: () => ({ songs: mocks.songs, status: 'ready' }), subscribe: () => () => {} } }))
vi.mock('./queue', () => ({ useQueue: { getState: () => ({ upsertPlaylist: mocks.upsertPlaylist }) } }))
vi.mock('./settings', () => ({ useSettings: { getState: () => ({ downloadKind: 'audio' }) } }))
vi.mock('../lib/helper', () => ({ searchVideos: mocks.searchVideos }))

interface Started {
  video: VideoSummary
  finish: () => void
  fail: (message: string) => void
}

let started: Started[]
let active: number
let peak: number

const exported = (count: number, playlists: ExportFile['playlists'] = []): ExportFile => ({
  app: 'gogo-karaoke',
  kind: 'lista',
  version: 1,
  exportedAt: 0,
  name: 'Lista de teste',
  songs: Array.from({ length: count }, (_, i) => ({
    title: `Música ${i}`,
    artist: 'Banda',
    duration: 200,
    mediaKind: 'audio' as const,
    source: { type: 'youtube' as const, url: `https://www.youtube.com/watch?v=v${i}`, videoId: `v${i}` },
    lyricOffset: 0,
  })),
  playlists,
})

const statuses = () => useBatch.getState().batch!.items.map((item) => item.status)
const inFlight = () => statuses().filter((status) => status === 'baixando').length
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  started = []
  active = 0
  peak = 0
  mocks.songs.length = 0
  mocks.searchVideos.mockReset()
  mocks.upsertPlaylist.mockReset()
  mocks.addYoutube.mockReset()
  mocks.addYoutube.mockImplementation(
    (video: VideoSummary) =>
      new Promise<Song>((resolve, reject) => {
        active++
        peak = Math.max(peak, active)
        const done = () => void active--
        started.push({ video, finish: () => (done(), resolve({ id: `song-${video.id}` } as Song)), fail: (message) => (done(), reject(new Error(message))) })
      }),
  )
  useBatch.getState().discard()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('baixar a lista: três de cada vez', () => {
  it('mantém três em andamento, e a próxima começa assim que uma termina', async () => {
    useBatch.getState().fromExport(exported(7))
    const all = useBatch.getState().downloadAll()
    expect(PARALLEL).toBe(3)
    expect(started).toHaveLength(3)
    expect(inFlight()).toBe(3)
    expect(useBatch.getState().running).toBe(true)

    for (let i = 0; i < 7; i++) {
      // Antes de a música i terminar, já começaram ela e as duas seguintes (se houver).
      expect(started).toHaveLength(Math.min(7, i + 3))
      started[i].finish()
      await tick()
    }
    await all

    expect(peak).toBe(3)
    expect(statuses()).toEqual(Array(7).fill('pronta'))
    expect(useBatch.getState().running).toBe(false)
    // Cada música foi baixada uma vez só, na ordem da lista.
    expect(started.map((entry) => entry.video.id)).toEqual(['v0', 'v1', 'v2', 'v3', 'v4', 'v5', 'v6'])
  })

  it('não segue a ordem de chegada: quem termina primeiro libera a vaga', async () => {
    useBatch.getState().fromExport(exported(5))
    const all = useBatch.getState().downloadAll()
    started[2].finish()
    await tick()
    expect(started.map((entry) => entry.video.id)).toEqual(['v0', 'v1', 'v2', 'v3'])
    expect(statuses()).toEqual(['baixando', 'baixando', 'pronta', 'baixando', 'pendente'])
    for (const entry of [started[0], started[1], started[3]]) entry.finish()
    await tick()
    started[4].finish()
    await all
    expect(peak).toBe(3)
  })

  it('uma música que falha não para as outras', async () => {
    useBatch.getState().fromExport(exported(4))
    const all = useBatch.getState().downloadAll()
    started[0].fail('O YouTube recusou o download (403).')
    await tick()
    expect(started).toHaveLength(4)
    for (const entry of started.slice(1)) entry.finish()
    await all
    expect(statuses()).toEqual(['falhou', 'pronta', 'pronta', 'pronta'])
    expect(useBatch.getState().batch!.items[0].error).toBe('O YouTube recusou o download (403).')
  })

  it('parar deixa terminar as que estão baixando e não começa outras', async () => {
    useBatch.getState().fromExport(exported(6))
    const all = useBatch.getState().downloadAll()
    useBatch.getState().stop()
    for (const entry of started) entry.finish()
    await all
    expect(started).toHaveLength(3)
    expect(statuses()).toEqual(['pronta', 'pronta', 'pronta', 'pendente', 'pendente', 'pendente'])
    expect(useBatch.getState().running).toBe(false)
  })

  it('não baixa de novo o que já está na biblioteca', async () => {
    mocks.songs.push({ id: 'ja-tenho', title: 'Outro nome', artist: 'Banda', source: { type: 'youtube', url: '', videoId: 'v1' } })
    useBatch.getState().fromExport(exported(3))
    expect(statuses()).toEqual(['pendente', 'na-biblioteca', 'pendente'])
    const all = useBatch.getState().downloadAll()
    for (const entry of started) entry.finish()
    await all
    expect(started.map((entry) => entry.video.id)).toEqual(['v0', 'v2'])
  })

  it('monta a playlist da lista conforme as músicas ficam prontas', async () => {
    useBatch.getState().fromExport(exported(3, [{ name: 'Festa', songs: [2, 0] }]))
    const all = useBatch.getState().downloadAll()
    for (const entry of started) entry.finish()
    await all
    expect(mocks.upsertPlaylist).toHaveBeenLastCalledWith('Festa', ['song-v2', 'song-v0'], undefined)
  })
})

describe('lista do Spotify', () => {
  const track = { title: 'Get Lucky', artist: 'Daft Punk', duration: 248 }
  const official: VideoSummary = { id: 'gl', url: 'https://www.youtube.com/watch?v=gl', title: 'Daft Punk - Get Lucky (Official Audio)', channel: 'Daft Punk', duration: 248, thumbnail: '' }

  it('tenta a busca do vídeo três vezes antes de desistir', async () => {
    vi.useFakeTimers()
    mocks.searchVideos.mockRejectedValueOnce(new Error('sem resposta')).mockRejectedValueOnce(new Error('sem resposta')).mockResolvedValue([official])
    useBatch.getState().fromSpotify({ kind: 'playlist', name: 'Pista', owner: 'Alguém', tracks: [track], truncated: false })
    const one = useBatch.getState().downloadOne('s0')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(mocks.searchVideos).toHaveBeenCalledTimes(3)
    expect(started.map((entry) => entry.video.id)).toEqual(['gl'])
    started[0].finish()
    await one
    expect(statuses()).toEqual(['pronta'])
  })

  it('marca a falha quando a busca não responde nas três vezes', async () => {
    vi.useFakeTimers()
    mocks.searchVideos.mockRejectedValue(new Error('O YouTube demorou demais para responder.'))
    useBatch.getState().fromSpotify({ kind: 'playlist', name: 'Pista', owner: 'Alguém', tracks: [track], truncated: false })
    const one = useBatch.getState().downloadOne('s0')
    await vi.advanceTimersByTimeAsync(10_000)
    await one
    expect(mocks.searchVideos).toHaveBeenCalledTimes(3)
    expect(started).toHaveLength(0)
    expect(statuses()).toEqual(['falhou'])
  })

  it('não baixa sozinho um vídeo que não parece ser a faixa', async () => {
    mocks.searchVideos.mockResolvedValue([{ ...official, title: 'Get Lucky KARAOKE com letra', channel: 'Karaokê Brasil' }])
    useBatch.getState().fromSpotify({ kind: 'playlist', name: 'Pista', owner: 'Alguém', tracks: [track], truncated: false })
    await useBatch.getState().downloadOne('s0')
    expect(started).toHaveLength(0)
    expect(statuses()).toEqual(['sem-video'])
  })

  it('um álbum vira álbum na biblioteca, com o nome e o artista', async () => {
    mocks.searchVideos.mockResolvedValue([official])
    useBatch.getState().fromSpotify({ kind: 'album', name: 'Random Access Memories', owner: 'Daft Punk', tracks: [track], truncated: false })
    const one = useBatch.getState().downloadOne('s0')
    await tick()
    started[0].finish()
    await one
    expect(mocks.upsertPlaylist).toHaveBeenLastCalledWith('Random Access Memories, de Daft Punk', ['song-gl'], { kind: 'album', album: 'Random Access Memories', artist: 'Daft Punk' })
  })
})
