export type MediaKind = 'audio' | 'video'
export type Difficulty = 'facil' | 'normal' | 'dificil'

export type SongSource =
  | { type: 'youtube'; url: string; videoId: string; channel?: string }
  | { type: 'file'; name: string }

/** none = sem letra, plain = só o texto, line = sincronizada por linha, word = por palavra. */
export type LyricsLevel = 'none' | 'plain' | 'line' | 'word'

/** pending = ainda analisando, ready = guia pronto, failed = áudio não pôde ser lido. */
export type MelodyStatus = 'pending' | 'ready' | 'failed'

export interface Song {
  id: string
  title: string
  artist: string
  album?: string
  /** Segundos. */
  duration: number
  mediaKind: MediaKind
  /** Nome do arquivo dentro da pasta "media" do OPFS. */
  mediaFile: string
  mime: string
  size: number
  /** Nome do arquivo dentro da pasta "covers" do OPFS. */
  coverFile?: string
  source: SongSource
  addedAt: number
  lyrics: LyricsLevel
  /** Segundos somados aos tempos da letra. Positivo atrasa a letra. */
  lyricOffset: number
  melody: MelodyStatus
  bestScore?: number
  plays: number
  lastSungAt?: number
  /** Faixas separadas (nomes na pasta "media" do OPFS). Ausente = música não separada. */
  stems?: SongStems
  /** pending = separando agora. failed = tentou e não conseguiu. Ausente = nunca tentou ou deu certo. */
  separation?: 'pending' | 'failed'
}

export interface SongStems {
  instrumental: string
  vocals: string
}

export interface LyricWord {
  text: string
  start: number
  end: number
  /** true quando é continuação da palavra anterior (sílaba), sem espaço antes. */
  glue?: boolean
}

export interface LyricLine {
  start: number
  end: number
  text: string
  words: LyricWord[]
}

export type LyricsSource = 'lrclib' | 'arquivo' | 'ultrastar' | 'manual'

export interface LyricsDoc {
  songId: string
  lines: LyricLine[]
  /** Texto corrido, usado quando ainda não há sincronia. */
  plain?: string
  level: Exclude<LyricsLevel, 'none'>
  source: LyricsSource
  lrclibId?: number
  updatedAt: number
  /** audio = os tempos foram medidos na voz desta gravação, não vieram de uma sincronia feita à mão. */
  timing?: 'audio'
  /** Como saiu a sincronia pelo áudio. */
  alignment?: { at: number; score: number; heard: number; tied: number }
  /** A sincronia que havia antes da medição: é a referência para refazer e o que volta ao desfazer. */
  previous?: { lines: LyricLine[]; level: Exclude<LyricsLevel, 'none'>; lyricOffset: number }
}

export interface RefNote {
  start: number
  end: number
  /** Nota MIDI (pode ser fracionada). null = só conta presença de voz (rap, fala). */
  midi: number | null
  /** 0..1: quanto o guia confia nessa nota. Notas fracas pesam menos na pontuação. */
  conf: number
}

export interface MelodyDoc {
  songId: string
  /** analise = extraída do áudio, segue o tempo do arquivo. ultrastar = veio com a letra, segue o atraso dela. */
  source: 'analise' | 'ultrastar'
  notes: RefNote[]
  /** Envelope do áudio (0..1) para desenhar a barra de progresso. */
  peaks?: Float32Array
  /** 0 = mono, perto de 1 = bem aberto. A redução de voz depende de o arquivo ser estéreo. */
  stereoWidth?: number
  /** true quando as notas saíram da faixa de voz separada: guia limpo, sem instrumentos. */
  fromVocals?: boolean
  version: number
}

export interface ScoreRecord {
  id?: number
  songId: string
  date: number
  /** 0..10000 */
  points: number
  /** 0..1 */
  accuracy: number
  bestStreak: number
  difficulty: Difficulty
  /** melodia = tom comparado com o guia. presenca = só cantar no tempo certo. */
  mode: 'melodia' | 'presenca'
  /** Nota de cada linha, 0..1. */
  lines: number[]
  /** Nome de quem cantou, quando a música foi cantada com a sala aberta. Ausente = o host, sozinho. */
  singer?: string
  /** Identifica a apresentação: todas as notas da mesma rodada têm o mesmo valor. */
  round?: string
}
