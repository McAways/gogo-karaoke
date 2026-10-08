import { create } from 'zustand'
import { deleteSongData, listSongs, putSong } from '@/lib/storage/db'
import { forgetCover, removeFile } from '@/lib/storage/files'
import type { Song } from '@/lib/types'
import { useQueue } from './queue'

interface LibraryStore {
  songs: Song[]
  status: 'loading' | 'ready' | 'error'
  load: () => Promise<void>
  save: (song: Song) => Promise<void>
  /** Aplica mudanças parciais sobre a versão mais recente da música. */
  patch: (id: string, changes: Partial<Song>) => Promise<Song | undefined>
  remove: (id: string) => Promise<void>
}

export const useLibrary = create<LibraryStore>()((set, get) => ({
  songs: [],
  status: 'loading',

  async load() {
    try {
      set({ songs: await listSongs(), status: 'ready' })
    } catch {
      set({ status: 'error' })
    }
  },

  async save(song) {
    await putSong(song)
    set((state) => {
      const exists = state.songs.some((s) => s.id === song.id)
      return { songs: exists ? state.songs.map((s) => (s.id === song.id ? song : s)) : [song, ...state.songs] }
    })
  },

  async patch(id, changes) {
    const current = get().songs.find((s) => s.id === id)
    if (!current) return undefined
    const next = { ...current, ...changes }
    await get().save(next)
    return next
  },

  async remove(id) {
    const song = get().songs.find((s) => s.id === id)
    if (!song) return
    set((state) => ({ songs: state.songs.filter((s) => s.id !== id) }))
    useQueue.getState().forget(id)
    await deleteSongData(id)
    await removeFile('media', song.mediaFile)
    if (song.stems) {
      await removeFile('media', song.stems.instrumental)
      await removeFile('media', song.stems.vocals)
    }
    if (song.coverFile) {
      forgetCover(song.coverFile)
      await removeFile('covers', song.coverFile)
    }
  },
}))

export function useSong(id: string | undefined): Song | undefined {
  return useLibrary((state) => (id ? state.songs.find((s) => s.id === id) : undefined))
}
