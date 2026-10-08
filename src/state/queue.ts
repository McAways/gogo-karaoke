import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export interface QueueItem {
  /** Identifica a entrada, não a música: a mesma música pode entrar duas vezes na fila. */
  key: string
  songId: string
}

export interface Playlist {
  id: string
  name: string
  songIds: string[]
  /** album = a lista veio de um álbum inteiro (link do Spotify): aparece entre os álbuns, com o artista. */
  kind?: 'album'
  album?: string
  artist?: string
}

interface QueueStore {
  items: QueueItem[]
  playlists: Playlist[]
  /** Devolve a posição (a partir de 1) em que a música entrou. */
  add: (songId: string) => number
  remove: (key: string) => void
  /** delta = -1 sobe uma posição, +1 desce. */
  move: (key: string, delta: number) => void
  clear: () => void
  /** Tira a música da frente da fila, se for ela a primeira: é chamado quando ela começa a tocar. */
  started: (songId: string) => void
  /** Uma música excluída da biblioteca some da fila e das playlists. */
  forget: (songId: string) => void
  /** Guarda a fila atual com um nome. false quando o nome está vazio ou já existe. */
  savePlaylist: (name: string) => boolean
  /** Cria a playlist ou, se já existe uma com esse nome, troca as músicas dela. Usado ao importar listas. */
  upsertPlaylist: (name: string, songIds: string[], meta?: Pick<Playlist, 'kind' | 'album' | 'artist'>) => void
  /**
   * Cria a playlist ou, se já existe uma com esse nome, acrescenta nela as músicas que faltam.
   * Usado ao abrir um pacote: o que já estava na playlist deste aparelho não se perde.
   */
  mergePlaylist: (name: string, songIds: string[], meta?: Pick<Playlist, 'kind' | 'album' | 'artist'>) => void
  /** Cria uma playlist com essas músicas. Devolve o id, ou null quando o nome está vazio ou já existe. */
  createPlaylist: (name: string, songIds: string[]) => string | null
  /** false quando a música já estava na playlist. */
  addToPlaylist: (id: string, songId: string) => boolean
  /** Tira da playlist a música que está na posição `index` (a mesma música pode estar nela duas vezes). */
  removeFromPlaylist: (id: string, index: number) => void
  /** Põe as músicas no começo da fila, na ordem dada. */
  playNext: (songIds: string[]) => void
  loadPlaylist: (id: string) => void
  deletePlaylist: (id: string) => void
}

const sameName = (a: string, b: string) => a.trim().toLocaleLowerCase('pt-BR') === b.trim().toLocaleLowerCase('pt-BR')

export const useQueue = create<QueueStore>()(
  persist(
    (set, get) => ({
      items: [],
      playlists: [],

      add(songId) {
        set((state) => ({ items: [...state.items, { key: crypto.randomUUID(), songId }] }))
        return get().items.length
      },

      remove(key) {
        set((state) => ({ items: state.items.filter((item) => item.key !== key) }))
      },

      move(key, delta) {
        set((state) => {
          const from = state.items.findIndex((item) => item.key === key)
          const to = from + delta
          if (from < 0 || to < 0 || to >= state.items.length) return state
          const items = [...state.items]
          const [moved] = items.splice(from, 1)
          items.splice(to, 0, moved)
          return { items }
        })
      },

      clear() {
        set({ items: [] })
      },

      started(songId) {
        set((state) => (state.items[0]?.songId === songId ? { items: state.items.slice(1) } : state))
      },

      forget(songId) {
        set((state) => ({
          items: state.items.filter((item) => item.songId !== songId),
          playlists: state.playlists.map((p) => ({ ...p, songIds: p.songIds.filter((id) => id !== songId) })),
        }))
      },

      savePlaylist(name) {
        const clean = name.trim()
        const { items, playlists } = get()
        if (!clean || items.length === 0 || playlists.some((p) => sameName(p.name, clean))) return false
        set({ playlists: [...playlists, { id: crypto.randomUUID(), name: clean, songIds: items.map((item) => item.songId) }] })
        return true
      },

      upsertPlaylist(name, songIds, meta) {
        const clean = name.trim()
        if (!clean || songIds.length === 0) return
        set((state) => {
          const existing = state.playlists.find((p) => sameName(p.name, clean))
          if (!existing) return { playlists: [...state.playlists, { id: crypto.randomUUID(), name: clean, songIds, ...meta }] }
          return { playlists: state.playlists.map((p) => (p === existing ? { ...p, songIds, ...meta } : p)) }
        })
      },

      mergePlaylist(name, songIds, meta) {
        const clean = name.trim()
        if (!clean || songIds.length === 0) return
        set((state) => {
          const existing = state.playlists.find((p) => sameName(p.name, clean))
          if (!existing) return { playlists: [...state.playlists, { id: crypto.randomUUID(), name: clean, songIds, ...meta }] }
          const missing = songIds.filter((id) => !existing.songIds.includes(id))
          return { playlists: state.playlists.map((p) => (p === existing ? { ...p, songIds: [...p.songIds, ...missing], ...meta } : p)) }
        })
      },

      createPlaylist(name, songIds) {
        const clean = name.trim()
        if (!clean || get().playlists.some((p) => sameName(p.name, clean))) return null
        const id = crypto.randomUUID()
        set((state) => ({ playlists: [...state.playlists, { id, name: clean, songIds }] }))
        return id
      },

      addToPlaylist(id, songId) {
        const playlist = get().playlists.find((p) => p.id === id)
        if (!playlist || playlist.songIds.includes(songId)) return false
        set((state) => ({ playlists: state.playlists.map((p) => (p.id === id ? { ...p, songIds: [...p.songIds, songId] } : p)) }))
        return true
      },

      removeFromPlaylist(id, index) {
        set((state) => ({ playlists: state.playlists.map((p) => (p.id === id ? { ...p, songIds: p.songIds.filter((_, i) => i !== index) } : p)) }))
      },

      playNext(songIds) {
        set((state) => ({ items: [...songIds.map((songId) => ({ key: crypto.randomUUID(), songId })), ...state.items] }))
      },

      loadPlaylist(id) {
        const playlist = get().playlists.find((p) => p.id === id)
        if (!playlist) return
        set((state) => ({ items: [...state.items, ...playlist.songIds.map((songId) => ({ key: crypto.randomUUID(), songId }))] }))
      },

      deletePlaylist(id) {
        set((state) => ({ playlists: state.playlists.filter((p) => p.id !== id) }))
      },
    }),
    { name: 'gogo:queue', version: 1 },
  ),
)
