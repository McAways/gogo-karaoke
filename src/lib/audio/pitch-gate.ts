/** O que o detector de tom mediu num instante. */
export interface PitchFrame {
  /** Segundos, em qualquer relógio que só avance. */
  time: number
  hz: number
  /** Nitidez do tom, de 0 a 1. */
  clarity: number
  /** Volume de entrada, em dB. */
  db: number
}

export interface PitchReading {
  /** Nota MIDI (fracionada) pela regra exigente: é a que vale ponto. null = silêncio ou som sem tom definido. */
  midi: number | null
  /**
   * Nota para desenhar. É a de `midi` quando há; senão, a voz que vinha soando e continua um
   * pouco menos nítida. Sem isso a marca da voz pisca a cada consoante e a cada respiração.
   */
  shown: number | null
}

const MIN_HZ = 70
const MAX_HZ = 1100
/** Abaixo disso o detector está chutando: voz cantada costuma ficar acima de 0,9. */
const MIN_CLARITY = 0.86
/** Para continuar mostrando uma nota que já vinha soando, basta bem menos. */
const KEEP_CLARITY = 0.68
/** Por quanto tempo (s), depois da última leitura exigente, a regra tolerante vale. */
const KEEP_SECONDS = 0.4
/** A continuação tem de ficar perto da nota que vinha soando (semitons, ignorando a oitava). */
const KEEP_SEMITONES = 3
const SILENCE_DB = -52
/** A voz precisa passar do ruído de fundo (e do som das caixas) por esta margem. */
const GATE_MARGIN_DB = 8
const KEEP_MARGIN_DB = 4
/** A mediana que tira os pulos de um quadro só olha este tanto de tempo, não um número de quadros. */
const MEDIAN_SECONDS = 0.05
const FORGET_SECONDS = 0.1

/** Diferença em semitons ignorando a oitava, entre -6 e 6. */
function chroma(from: number, to: number): number {
  return ((((to - from) % 12) + 18) % 12) - 6
}

/**
 * Decide, a cada medida do detector, se há uma voz cantando e em que nota.
 *
 * Tudo aqui conta tempo, não quadros: numa tela de 120 Hz as medidas chegam com o dobro da
 * frequência, e filtros contados em quadros passariam a valer metade.
 */
export class PitchGate {
  private floorDb = -70
  private recent: Array<{ time: number; midi: number }> = []
  private lastTime: number | null = null
  private sureAt = -Infinity
  private note = 0

  reset(): void {
    this.floorDb = -70
    this.recent = []
    this.lastTime = null
    this.sureAt = -Infinity
  }

  push({ time, hz, clarity, db }: PitchFrame): PitchReading {
    const elapsed = this.lastTime === null ? 1 / 60 : Math.min(0.1, Math.max(0, time - this.lastTime))
    this.lastTime = time

    const inRange = hz >= MIN_HZ && hz <= MAX_HZ
    const tonal = inRange && clarity >= MIN_CLARITY

    // O piso de ruído só sobe com som sem tom (música das caixas, ventilador).
    // Uma nota longa não o empurra para cima, senão ela cortaria a si mesma.
    if (db < this.floorDb) this.floorDb = db
    else if (!tonal) this.floorDb += Math.min(3 * elapsed, (db - this.floorDb) * (1 - Math.exp(-1.2 * elapsed)))

    const raw = inRange ? 69 + 12 * Math.log2(hz / 440) : null

    if (raw !== null && tonal && db >= Math.max(SILENCE_DB, this.floorDb + GATE_MARGIN_DB)) {
      this.recent.push({ time, midi: raw })
      while (this.recent.length > 1 && time - this.recent[0].time > MEDIAN_SECONDS) this.recent.shift()
      const sorted = this.recent.map((entry) => entry.midi).sort((a, b) => a - b)
      const midi = sorted[sorted.length >> 1]
      this.sureAt = time
      this.note = midi
      return { midi, shown: midi }
    }
    if (time - this.sureAt > FORGET_SECONDS) this.recent = []

    // A nota que vinha soando continua, só menos nítida (consoante, vibrato, fim do fôlego):
    // segue desenhada. Na oitava de antes, porque é aí que o detector mais erra quando a nitidez cai.
    if (raw !== null && time - this.sureAt <= KEEP_SECONDS && clarity >= KEEP_CLARITY && db >= Math.max(SILENCE_DB, this.floorDb + KEEP_MARGIN_DB)) {
      const step = chroma(this.note, raw)
      if (Math.abs(step) <= KEEP_SEMITONES) {
        this.note += step
        return { midi: null, shown: this.note }
      }
    }
    return { midi: null, shown: null }
  }
}
