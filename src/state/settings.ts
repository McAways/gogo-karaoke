import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { ListenMode } from '@/lib/audio/mic'
import type { Difficulty, MediaKind } from '@/lib/types'

export type ThemeChoice = 'system' | 'light' | 'dark'
/** lista = só os links, as letras e as playlists. completo = as músicas em si, prontas para cantar. */
export type ExportKind = 'lista' | 'completo'

export interface Settings {
  theme: ThemeChoice
  difficulty: Difficulty
  listenMode: ListenMode
  micDeviceId: string | null
  /** Atraso entre o que toca e o que o microfone capta, em ms. Bluetooth pede bem mais. */
  latencyMs: number
  volume: number
  showLane: boolean
  downloadKind: MediaKind
  /** Separar voz e instrumental de cada música nova, quando o separador está instalado. */
  separateOnImport: boolean
  /** Volume da voz original no palco, de 0 (só instrumental) a 1. */
  vocalLevel: number
  /** Como quem canta neste computador aparece no placar da sala. */
  hostName: string
  /**
   * Medir a letra no áudio, sozinho, quando ela veio só em texto (sem tempos). Letra que já veio
   * sincronizada nunca é medida sozinha: só quando o usuário pede.
   */
  alignWhenUnsynced: boolean
  /** Na busca do YouTube, esconder os vídeos para os quais não há letra. */
  onlyWithLyrics: boolean
  /** O que foi escolhido da última vez no diálogo de exportar. */
  exportKind: ExportKind
}

interface SettingsStore extends Settings {
  update: (patch: Partial<Settings>) => void
}

const DEFAULTS: Settings = {
  theme: 'system',
  difficulty: 'normal',
  listenMode: 'caixas',
  micDeviceId: null,
  latencyMs: 90,
  volume: 0.9,
  showLane: true,
  downloadKind: 'audio',
  separateOnImport: true,
  vocalLevel: 1,
  hostName: 'Anfitrião',
  alignWhenUnsynced: true,
  onlyWithLyrics: true,
  exportKind: 'lista',
}

// A chave também é lida pelo script do index.html, que aplica o tema antes da primeira pintura.
export const useSettings = create<SettingsStore>()(
  persist((set) => ({ ...DEFAULTS, update: (patch) => set(patch) }), { name: 'gogo:settings', version: 1 }),
)

export function resolveTheme(choice: ThemeChoice): 'light' | 'dark' {
  if (choice !== 'system') return choice
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}
