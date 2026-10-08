import type { Difficulty } from '../types'
import type { ScoreReference } from './reference'

export const MAX_POINTS = 10_000

export interface ScoreRules {
  /** Erro de tom, em semitons, que ainda vale acerto cheio. */
  tolerance: number
  /** Quanto o cantor pode adiantar ou atrasar, em segundos. */
  timingSlack: number
  /**
   * Fração de acerto que já vale nota máxima. O guia automático erra cerca de uma
   * em cada dez notas, então exigir 100% tornaria a nota máxima impossível.
   */
  ceiling: number
}

const BASE_RULES: Record<Difficulty, { tolerance: number; timingSlack: number }> = {
  facil: { tolerance: 2.0, timingSlack: 0.16 },
  normal: { tolerance: 1.4, timingSlack: 0.12 },
  dificil: { tolerance: 0.8, timingSlack: 0.07 },
}

/** `exactGuide`: notas anotadas à mão (UltraStar). Sem isso, o guia veio da análise do áudio. */
export function rulesFor(difficulty: Difficulty, exactGuide: boolean): ScoreRules {
  const base = BASE_RULES[difficulty]
  return exactGuide ? { ...base, ceiling: 1 } : { tolerance: base.tolerance + 0.3, timingSlack: base.timingSlack, ceiling: 0.9 }
}

export type Rating = 'perfeito' | 'otimo' | 'bom' | 'quase' | 'errou'

export const RATING_LABEL: Record<Rating, string> = {
  perfeito: 'Perfeito',
  otimo: 'Ótimo',
  bom: 'Bom',
  quase: 'Quase',
  errou: 'Errou',
}

export function ratingFor(ratio: number): Rating {
  if (ratio >= 0.85) return 'perfeito'
  if (ratio >= 0.65) return 'otimo'
  if (ratio >= 0.4) return 'bom'
  if (ratio >= 0.15) return 'quase'
  return 'errou'
}

export function gradeFor(points: number): { label: string; detail: string } {
  if (points >= 9000) return { label: 'Lendário', detail: 'Praticamente o original.' }
  if (points >= 7500) return { label: 'Estrela', detail: 'Afinação firme do começo ao fim.' }
  if (points >= 6000) return { label: 'Afinado', detail: 'A maior parte das notas no lugar.' }
  if (points >= 4000) return { label: 'No caminho', detail: 'Metade da música encaixou.' }
  if (points >= 2000) return { label: 'Aquecendo', detail: 'O ritmo veio, o tom ainda não.' }
  return { label: 'Tímido', detail: 'Chegue mais perto do microfone e solte a voz.' }
}

/** Diferença em semitons ignorando a oitava, entre -6 e 6. */
export function chromaDiff(sung: number, target: number): number {
  return ((((sung - target) % 12) + 18) % 12) - 6
}

export interface Judgment {
  /** Semitons de distância da nota alvo, já dobrados para a oitava mais próxima. null sem alvo. */
  diff: number | null
  /** Nota alvo usada na comparação. null sem alvo de tom. */
  target: number | null
  /** 0..1: quanto essa amostra valeu. */
  credit: number
}

export interface LineResult {
  line: number
  ratio: number
  rating: Rating
  streak: number
}

export interface ScoreSummary {
  points: number
  accuracy: number
  bestStreak: number
  lines: number[]
  mode: 'melodia' | 'presenca'
}

/**
 * Julga o canto contra a referência. Recebe uma amostra de tom por quadro
 * (`push`) e fecha as linhas conforme o tempo passa (`closeLines`).
 */
export class ScoreEngine {
  readonly reference: ScoreReference
  private readonly rules: ScoreRules
  private readonly values: Float32Array
  private readonly totalWeight: number
  private earned = 0
  private nextLine = 0
  private streak = 0
  private bestStreak = 0
  private readonly lineRatios: number[]

  constructor(reference: ScoreReference, rules: ScoreRules) {
    this.reference = reference
    this.rules = rules
    this.values = new Float32Array(reference.slots.length)
    this.totalWeight = reference.slots.reduce((sum, slot) => sum + slot.weight, 0)
    this.lineRatios = reference.lines.map(() => 0)
  }

  /** `midi` null = o cantor está em silêncio. Devolve como a amostra foi julgada. */
  push(time: number, midi: number | null): Judgment {
    const { slots } = this.reference
    const { tolerance, timingSlack } = this.rules
    const judgment: Judgment = { diff: null, target: null, credit: 0 }
    if (slots.length === 0) return judgment

    // Primeiro slot que ainda pode ser alcançado por esta amostra.
    let lo = 0
    let hi = slots.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (slots[mid].t1 <= time - timingSlack) lo = mid + 1
      else hi = mid
    }

    let nearest = Infinity
    for (let i = lo; i < slots.length && slots[i].t0 < time + timingSlack; i++) {
      const slot = slots[i]
      const distance = time < slot.t0 ? slot.t0 - time : time > slot.t1 ? time - slot.t1 : 0

      let credit = 0
      let diff: number | null = null
      if (midi !== null) {
        if (slot.midi === null) {
          credit = 1
        } else {
          diff = chromaDiff(midi, slot.midi)
          const off = Math.abs(diff)
          credit = off <= tolerance ? 1 : off >= tolerance * 2 ? 0 : 1 - (off - tolerance) / tolerance
        }
        if (credit > this.values[i]) {
          this.earned += (credit - this.values[i]) * slot.weight
          this.values[i] = credit
        }
      }

      // O retorno visual segue o slot mais próximo do instante cantado.
      if (distance < nearest) {
        nearest = distance
        judgment.diff = diff
        judgment.target = slot.midi
        judgment.credit = credit
      }
    }
    return judgment
  }

  /** Linhas que terminaram antes de `time` e ainda não foram anunciadas. */
  closeLines(time: number): LineResult[] {
    const { lines, slots } = this.reference
    const closed: LineResult[] = []

    while (this.nextLine < lines.length) {
      const line = lines[this.nextLine]
      const lineEnd = line.lastSlot > line.firstSlot ? slots[line.lastSlot - 1].t1 : line.end
      if (time < lineEnd + this.rules.timingSlack + 0.05) break

      const index = this.nextLine++
      if (line.lastSlot === line.firstSlot) continue

      const ratio = this.lineRatio(index)
      this.lineRatios[index] = ratio
      const rating = ratingFor(ratio)
      this.streak = rating === 'perfeito' || rating === 'otimo' || rating === 'bom' ? this.streak + 1 : 0
      this.bestStreak = Math.max(this.bestStreak, this.streak)
      closed.push({ line: index, ratio, rating, streak: this.streak })
    }
    return closed
  }

  /**
   * Traz para esta partitura as linhas já cantadas em outra. Usado quando o atraso da
   * letra é ajustado no meio da música: a referência muda, mas o que foi cantado fica.
   */
  adopt(previous: ScoreEngine): void {
    const count = Math.min(previous.nextLine, this.reference.lines.length)
    for (let i = 0; i < count; i++) {
      const line = this.reference.lines[i]
      const value = Math.min(1, previous.lineRatios[i] * this.rules.ceiling)
      for (let slot = line.firstSlot; slot < line.lastSlot; slot++) {
        this.earned += (value - this.values[slot]) * this.reference.slots[slot].weight
        this.values[slot] = value
      }
      this.lineRatios[i] = previous.lineRatios[i]
    }
    this.nextLine = count
    this.streak = previous.streak
    this.bestStreak = previous.bestStreak
  }

  /** Acerto de um slot, para a pista de tom pintar o que já foi cantado. */
  slotValue(index: number): number {
    return this.values[index]
  }

  private lineRatio(index: number): number {
    const { lines, slots } = this.reference
    const line = lines[index]
    let earned = 0
    let total = 0
    for (let i = line.firstSlot; i < line.lastSlot; i++) {
      earned += this.values[i] * slots[i].weight
      total += slots[i].weight
    }
    return total > 0 ? Math.min(1, earned / total / this.rules.ceiling) : 0
  }

  /** Fração da música inteira já conquistada, de 0 a 1. */
  get accuracy(): number {
    return this.totalWeight > 0 ? Math.min(1, this.earned / this.totalWeight / this.rules.ceiling) : 0
  }

  get points(): number {
    return Math.round(this.accuracy * MAX_POINTS)
  }

  get currentStreak(): number {
    return this.streak
  }

  /** Fecha o que faltar e devolve o resultado final. */
  summary(): ScoreSummary {
    this.closeLines(Infinity)
    return {
      points: this.points,
      accuracy: this.accuracy,
      bestStreak: this.bestStreak,
      lines: [...this.lineRatios],
      mode: this.reference.mode === 'presenca' ? 'presenca' : 'melodia',
    }
  }
}
