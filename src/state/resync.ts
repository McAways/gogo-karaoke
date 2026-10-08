import { create } from 'zustand'
import { canAlign, canSeparate, separateAndRefit, syncLyricsToAudio } from '@/lib/importer'
import { getLyrics } from '@/lib/storage/db'
import type { Song } from '@/lib/types'
import { useLibrary } from './library'

/**
 * Sincronizar pelo áudio as músicas que já estavam na biblioteca, uma por vez.
 * Cada uma leva de um a dois minutos (mais a separação de voz, se ainda não foi feita),
 * então o trabalho fica aqui, fora das telas: dá para sair de Ajustes e ele continua.
 */

interface ResyncStore {
  running: boolean
  /** Quantas já passaram nesta rodada, e de quantas. */
  done: number
  total: number
  /** Nome da música em andamento. */
  current: string | null
  /** Quantas ficaram como estavam (letra não reconhecida, ou algum passo falhou). */
  skipped: number
  start: () => Promise<void>
  stop: () => void
}

let stopRequested = false

/** As músicas cuja letra ainda não foi medida no áudio e pode ser. */
export async function songsToResync(): Promise<Song[]> {
  const pending: Song[] = []
  for (const song of useLibrary.getState().songs) {
    if (song.lyrics === 'none') continue
    const doc = await getLyrics(song.id)
    // UltraStar já traz o tempo de cada sílaba anotado à mão.
    if (!doc || doc.source === 'ultrastar' || doc.timing === 'audio') continue
    pending.push(song)
  }
  return pending
}

export const useResync = create<ResyncStore>()((set, get) => ({
  running: false,
  done: 0,
  total: 0,
  current: null,
  skipped: 0,

  async start() {
    if (get().running || !(await canAlign())) return
    stopRequested = false
    const songs = await songsToResync()
    set({ running: true, done: 0, total: songs.length, skipped: 0, current: null })
    try {
      for (const song of songs) {
        if (stopRequested) break
        set({ current: song.title })
        let applied = false
        try {
          const fresh = useLibrary.getState().songs.find((s) => s.id === song.id)
          if (fresh && !fresh.stems && (await canSeparate())) await separateAndRefit(song.id)
          // `separateAndRefit` já sincroniza quando o ajuste está ligado: só mede de novo se ainda falta.
          if ((await getLyrics(song.id))?.timing !== 'audio') await syncLyricsToAudio(song.id)
          applied = (await getLyrics(song.id))?.timing === 'audio'
        } catch {
          // Uma música que falha não interrompe as outras.
        }
        set((state) => ({ done: state.done + 1, skipped: state.skipped + (applied ? 0 : 1) }))
      }
    } finally {
      set({ running: false, current: null })
    }
  },

  stop() {
    stopRequested = true
  },
}))
