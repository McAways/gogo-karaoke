import { chromaDiff } from '@/lib/scoring/engine'

/** Um ponto da linha da voz na pista de tom. */
export interface TracePoint {
  /** Instante da música em que isto foi cantado. */
  time: number
  /** Altura a desenhar, já na oitava da pista. */
  value: number
  onPitch: boolean
  /** Começo de um trecho: não se liga ao ponto anterior. */
  start: boolean
}

/** Onde a voz está agora. `strength` vai de 1 a 0 enquanto a marca apaga. */
export interface VoiceCursor {
  value: number
  onPitch: boolean
  strength: number
}

/** Sem leitura por até este tempo (s), a marca fica onde estava. Depois apaga aos poucos. */
const HOLD = 0.2
const FADE = 0.25
/** Buraco máximo (s de música) que a linha atravessa sem se partir. */
const BRIDGE = 0.25
/** Salto (semitons) a partir do qual é outra nota: a linha se parte em vez de riscar a pista. */
const LEAP = 5
/** A partir desta distância da nota (semitons), a oitava mais próxima é duvidosa e não se troca à toa. */
const OCTAVE_DOUBT = 4.5
/** Constante de tempo (s) da suavização: tira o tremido sem atrasar a marca de forma visível. */
const SMOOTH = 0.045
const LIMIT = 600

/**
 * A voz como a pista de tom a desenha: uma linha contínua, e não um ponto por leitura.
 *
 * O detector perde a voz por instantes o tempo todo (consoante, respiração, nota grave). A
 * pontuação já perdoa isso; o desenho não perdoava, e a marca piscava. Aqui a linha atravessa os
 * buracos curtos, a marca do "agora" espera um pouco antes de sumir, e uma leitura isolada, que
 * quase sempre é ruído, não chega a aparecer.
 */
export class VoiceTrace {
  readonly points: TracePoint[] = []
  private heardAt = -Infinity
  private run = 0

  clear(): void {
    this.points.length = 0
    this.heardAt = -Infinity
    this.run = 0
  }

  /**
   * `time` é o instante da música; `wall`, o relógio de parede em segundos (a marca apaga mesmo
   * com a música parada). `target` é a nota que deveria estar sendo cantada, ou null fora de uma
   * nota. `anchor` é a altura de referência para quando não há nota nem voz anterior.
   */
  push(time: number, wall: number, midi: number, target: number | null, onPitch: boolean, anchor: number): void {
    const last = this.points[this.points.length - 1]
    const gap = last ? time - last.time : Infinity
    const joined = last !== undefined && gap >= 0 && gap <= BRIDGE

    // A pontuação ignora a oitava, então a voz é desenhada na oitava mais próxima da nota pedida.
    // Fora de uma nota, fica na oitava em que já vinha: sem isso o ponto pulava ao sair da nota.
    const near = target ?? (joined ? last.value : anchor)
    let raw = near + chromaDiff(midi, near)
    // Quem canta longe da nota fica a meio caminho entre duas oitavas, e a "mais próxima" troca a
    // cada tremida da voz: a linha pulava de cima para baixo da pista. Aí vale a oitava em que vinha.
    if (target !== null && joined && Math.abs(raw - target) > OCTAVE_DOUBT) {
      const kept = last.value + chromaDiff(midi, last.value)
      if (Math.abs(kept - target) <= 12 - OCTAVE_DOUBT) raw = kept
    }

    const follows = joined && Math.abs(raw - last.value) <= LEAP
    const value = follows ? last.value + (raw - last.value) * (1 - Math.exp(-gap / SMOOTH)) : raw
    // Um salto parte a linha, mas a voz é a mesma: só o silêncio recomeça a contagem.
    this.run = joined ? this.run + 1 : 1
    this.heardAt = wall
    this.points.push({ time, value, onPitch, start: !follows })
    if (this.points.length > LIMIT) this.points.splice(0, this.points.length - LIMIT)
  }

  /** A marca do "agora", ou null quando não há voz. */
  cursor(wall: number): VoiceCursor | null {
    const last = this.points[this.points.length - 1]
    // Uma leitura sozinha ainda não é voz.
    if (!last || this.run < 2) return null
    const silent = wall - this.heardAt
    if (silent > HOLD + FADE) return null
    return { value: last.value, onPitch: last.onPitch, strength: silent <= HOLD ? 1 : 1 - (silent - HOLD) / FADE }
  }
}
