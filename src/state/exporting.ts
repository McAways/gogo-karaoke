import { create } from 'zustand'
import type { PlaylistInput } from '@/lib/transfer'
import type { Song } from '@/lib/types'

export interface ExportRequest {
  /** Nome do que está sendo exportado: vai no nome do arquivo e no título do diálogo. */
  name: string
  songs: Song[]
  playlists: PlaylistInput[]
}

interface ExportStore {
  request: ExportRequest | null
  ask: (request: ExportRequest) => void
  close: () => void
}

/** O pedido de exportação em aberto. O diálogo mora no esqueleto da página e atende qualquer tela. */
export const useExport = create<ExportStore>()((set) => ({
  request: null,
  ask: (request) => set({ request }),
  close: () => set({ request: null }),
}))

/** Abre o diálogo de exportar para essas músicas: quem exporta escolhe entre a lista e as músicas completas. */
export function askExport(name: string, songs: Song[], playlists: PlaylistInput[] = []): void {
  if (songs.length === 0) return
  useExport.getState().ask({ name, songs, playlists })
}
