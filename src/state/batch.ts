import { create } from 'zustand'
import { searchVideos } from '@/lib/helper'
import type { VideoSummary } from '@/lib/helper'
import type { ImportPreset } from '@/lib/importer'
import { readFile, removeFile, saveBlob, storageSupported } from '@/lib/storage/files'
import { MIN_VIDEO_SCORE, findInLibrary, rankVideos, searchQueryFor, tidyTrackTitle, videoScore } from '@/lib/transfer'
import type { ExportFile } from '@/lib/transfer'
import type { MediaKind } from '@/lib/types'
import { useJobs } from './jobs'
import { useLibrary } from './library'
import { useQueue } from './queue'
import { useSettings } from './settings'

/**
 * Lista de músicas para baixar: veio de um arquivo exportado (outro aparelho) ou de uma
 * playlist do Spotify. Fica guardada no navegador, então dá para fechar o app no meio e
 * continuar depois. Três músicas andam ao mesmo tempo: quando uma termina, a próxima começa.
 * Os downloads correm juntos; separar a voz roda um por vez (ver `oneAtATime` no importador).
 */

export type BatchStatus = 'pendente' | 'procurando' | 'baixando' | 'pronta' | 'falhou' | 'sem-video' | 'na-biblioteca' | 'arquivo'

export interface BatchItem {
  key: string
  title: string
  artist: string
  album?: string
  /** Segundos. 0 = desconhecida. */
  duration: number
  kind?: MediaKind
  /** O vídeo a baixar: veio no arquivo exportado ou foi escolhido pela busca. */
  video?: VideoSummary
  /** Letra e ajustes que vieram na lista: aplicados no lugar da busca automática. */
  preset?: ImportPreset
  status: BatchStatus
  songId?: string
  error?: string
  /** Os vídeos da última busca, do mais ao menos parecido, para trocar à mão. */
  candidates?: VideoSummary[]
}

export interface Batch {
  id: string
  name: string
  source: 'arquivo' | 'spotify'
  /** Quando veio do Spotify: de uma playlist ou de um álbum. */
  kind?: 'playlist' | 'album'
  /** Aviso sobre a lista inteira (por exemplo: a playlist tem mais faixas do que deu para ler). */
  note?: string
  items: BatchItem[]
  /** Playlists a montar quando as músicas estiverem na biblioteca. `keys` são chaves de `items`. */
  playlists: Array<{ name: string; keys: string[]; kind?: 'album'; album?: string; artist?: string }>
}

interface BatchStore {
  batch: Batch | null
  /** true enquanto o "baixar tudo" está andando. */
  running: boolean
  load: () => Promise<void>
  fromExport: (file: ExportFile) => void
  fromSpotify: (list: { kind: 'playlist' | 'album' | 'track'; name: string; owner: string; tracks: Array<{ title: string; artist: string; duration: number }>; truncated: boolean }) => void
  discard: () => void
  downloadOne: (key: string) => Promise<void>
  downloadAll: () => Promise<void>
  stop: () => void
  /** Procura no YouTube os vídeos de um item, sem baixar. */
  findVideos: (key: string) => Promise<VideoSummary[]>
  choose: (key: string, video: VideoSummary) => void
}

const FILE = 'atual.json'
/** Quantas músicas da lista andam ao mesmo tempo. */
export const PARALLEL = 3
/** Quantas vezes a busca do vídeo é tentada. O download em si já é tentado três vezes pelo ajudante. */
const SEARCH_TRIES = 3
const BUSY: BatchStatus[] = ['procurando', 'baixando']
const DONE: BatchStatus[] = ['pronta', 'na-biblioteca']

/** Espera a biblioteca terminar de carregar: sem ela não dá para saber o que já foi baixado. */
function libraryReady(): Promise<void> {
  if (useLibrary.getState().status !== 'loading') return Promise.resolve()
  return new Promise((resolve) => {
    const stop = useLibrary.subscribe((state) => {
      if (state.status === 'loading') return
      stop()
      resolve()
    })
  })
}

let loaded = false
let stopRequested = false
let saving: Promise<void> = Promise.resolve()

function persist(batch: Batch | null): void {
  if (!storageSupported()) return
  // Uma gravação por vez, na ordem: a última é a que fica.
  saving = saving
    .then(() => (batch ? saveBlob('listas', FILE, new Blob([JSON.stringify(batch)], { type: 'application/json' })) : removeFile('listas', FILE)))
    .catch(() => {})
}

const videoUrl = (id: string) => `https://www.youtube.com/watch?v=${id}`

export const useBatch = create<BatchStore>()((set, get) => {
  const commit = (batch: Batch | null) => {
    set({ batch })
    persist(batch)
  }

  const patch = (key: string, changes: Partial<BatchItem>) => {
    const { batch } = get()
    if (!batch) return
    commit({ ...batch, items: batch.items.map((item) => (item.key === key ? { ...item, ...changes } : item)) })
  }

  /** Monta (ou atualiza) as playlists da lista com as músicas que já estão na biblioteca. */
  const syncPlaylists = () => {
    const { batch } = get()
    if (!batch) return
    const songOf = new Map(batch.items.filter((item) => item.songId && DONE.includes(item.status)).map((item) => [item.key, item.songId!]))
    for (const playlist of batch.playlists) {
      const songIds = playlist.keys.map((key) => songOf.get(key)).filter((id): id is string => id !== undefined)
      if (songIds.length === 0) continue
      const meta = playlist.kind === 'album' ? { kind: 'album' as const, album: playlist.album, artist: playlist.artist } : undefined
      useQueue.getState().upsertPlaylist(playlist.name, songIds, meta)
    }
  }

  /** Marca o que já está na biblioteca: essas não são baixadas de novo. */
  const withLibrary = (items: BatchItem[]): BatchItem[] => {
    const songs = useLibrary.getState().songs
    return items.map((item) => {
      if (item.status !== 'pendente' && item.status !== 'arquivo') return item
      const found = findInLibrary({ title: item.title, artist: item.artist, videoId: item.video?.id }, songs)
      return found ? { ...item, status: 'na-biblioteca', songId: found.id } : item
    })
  }

  const start = (batch: Batch) => {
    stopRequested = false
    set({ running: false })
    commit({ ...batch, items: withLibrary(batch.items) })
    syncPlaylists()
  }

  return {
    batch: null,
    running: false,

    async load() {
      if (loaded || !storageSupported()) return
      loaded = true
      try {
        const saved = JSON.parse(await (await readFile('listas', FILE)).text()) as Batch
        if (!saved || !Array.isArray(saved.items)) return
        await libraryReady()
        // O que estava no meio quando o app fechou volta para a fila.
        const items = saved.items.map((item) => (BUSY.includes(item.status) ? { ...item, status: 'pendente' as const } : item))
        if (!get().batch) set({ batch: { ...saved, items: withLibrary(items) } })
      } catch {
        // Não havia lista guardada.
      }
    },

    fromExport(file) {
      const items = file.songs.map((song, index): BatchItem => {
        const youtube = song.source.type === 'youtube' ? song.source : null
        return {
          key: `m${index}`,
          title: song.title,
          artist: song.artist,
          ...(song.album ? { album: song.album } : {}),
          duration: song.duration,
          kind: song.mediaKind,
          ...(youtube ? { video: { id: youtube.videoId, url: youtube.url || videoUrl(youtube.videoId), title: song.title, channel: youtube.channel ?? song.artist, duration: song.duration, thumbnail: `https://i.ytimg.com/vi/${youtube.videoId}/mqdefault.jpg` } } : {}),
          preset: {
            title: song.title,
            artist: song.artist,
            ...(song.album ? { album: song.album } : {}),
            ...(song.lyrics ? { lyrics: song.lyrics, lyricOffset: song.lyricOffset } : {}),
            ...(song.notes ? { notes: song.notes } : {}),
          },
          // Música que veio de um arquivo do computador não tem de onde ser baixada de novo.
          status: youtube ? 'pendente' : 'arquivo',
        }
      })
      start({
        id: crypto.randomUUID(),
        name: file.name,
        source: 'arquivo',
        items,
        playlists: file.playlists.map((playlist) => ({
          name: playlist.name,
          keys: playlist.songs.map((index) => `m${index}`),
          ...(playlist.kind === 'album' ? { kind: 'album' as const, album: playlist.album, artist: playlist.artist } : {}),
        })),
      })
    },

    fromSpotify(list) {
      const album = list.kind === 'album'
      const items = list.tracks.map((track, index): BatchItem => {
        const title = tidyTrackTitle(track.title)
        // No álbum, o nome dele vai junto: ajuda a achar a letra da gravação certa.
        const preset = { title, artist: track.artist, ...(album ? { album: tidyTrackTitle(list.name) } : {}) }
        return { key: `s${index}`, title, artist: track.artist, ...(album ? { album: preset.album } : {}), duration: track.duration, preset, status: 'pendente' }
      })
      // A playlist criada leva o nome do álbum junto com o do artista, para não se confundir com outra.
      const name = album && list.owner ? `${list.name}, de ${list.owner}` : list.name
      start({
        id: crypto.randomUUID(),
        name,
        source: 'spotify',
        kind: album ? 'album' : 'playlist',
        ...(list.truncated ? { note: 'A página pública do Spotify mostra só as 100 primeiras faixas. Se houver mais, divida em playlists menores.' } : {}),
        items,
        playlists: [{ name, keys: items.map((item) => item.key), ...(album ? { kind: 'album' as const, album: tidyTrackTitle(list.name), artist: list.owner } : {}) }],
      })
    },

    discard() {
      stopRequested = true
      set({ running: false })
      commit(null)
    },

    async findVideos(key) {
      const item = get().batch?.items.find((entry) => entry.key === key)
      if (!item) return []
      let found: VideoSummary[] = []
      for (let tries = 1; ; tries++) {
        try {
          found = await searchVideos(searchQueryFor(item))
          break
        } catch (err) {
          if (tries >= SEARCH_TRIES) throw err
          await new Promise((resolve) => setTimeout(resolve, 1200 * tries))
        }
      }
      const ranked = rankVideos(item, found)
      patch(key, { candidates: ranked.slice(0, 8) })
      return ranked
    },

    choose(key, video) {
      patch(key, { video, status: 'pendente', error: undefined })
    },

    async downloadOne(key) {
      const item = get().batch?.items.find((entry) => entry.key === key)
      if (!item || BUSY.includes(item.status) || DONE.includes(item.status)) return
      const batchId = get().batch?.id
      const already = findInLibrary({ title: item.title, artist: item.artist, videoId: item.video?.id }, useLibrary.getState().songs)
      if (already) {
        patch(key, { status: 'na-biblioteca', songId: already.id })
        return syncPlaylists()
      }
      try {
        let video = item.video
        if (!video) {
          patch(key, { status: 'procurando', error: undefined })
          const ranked = await get().findVideos(key)
          if (get().batch?.id !== batchId) return
          // Nenhum vídeo parecido o bastante: melhor a pessoa escolher do que baixar a música errada.
          if (ranked.length === 0 || videoScore(item, ranked[0]) < MIN_VIDEO_SCORE) return patch(key, { status: 'sem-video' })
          video = ranked[0]
          patch(key, { video })
        }
        patch(key, { status: 'baixando', error: undefined })
        const song = await useJobs.getState().addYoutube(video, item.kind ?? useSettings.getState().downloadKind, item.preset)
        if (get().batch?.id !== batchId) return
        patch(key, { status: 'pronta', songId: song.id })
        syncPlaylists()
      } catch (err) {
        if (get().batch?.id !== batchId) return
        patch(key, { status: 'falhou', error: err instanceof Error ? err.message : 'O download falhou.' })
      }
    },

    async downloadAll() {
      if (get().running) return
      stopRequested = false
      set({ running: true })
      const claimed = new Set<string>()
      // Cada "trabalhador" pega a próxima pendente assim que termina a sua: sempre até três em andamento.
      const worker = async () => {
        for (;;) {
          if (stopRequested) return
          const next = get().batch?.items.find((item) => item.status === 'pendente' && !claimed.has(item.key))
          if (!next) return
          claimed.add(next.key)
          await get().downloadOne(next.key)
        }
      }
      try {
        await Promise.all(Array.from({ length: PARALLEL }, worker))
      } finally {
        set({ running: false })
      }
    },

    stop() {
      stopRequested = true
    },
  }
})
