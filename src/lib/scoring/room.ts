import { ScoreEngine } from './engine'
import type { ScoreRules, ScoreSummary } from './engine'
import type { ScoreReference } from './reference'

/** Leitura de tom de um convidado: [instante em que foi captada, em ms no relógio do host; nota MIDI ou null]. */
export type PitchSample = [number, number | null]

export interface RoomEntry {
  name: string
  points: number
  streak: number
}

/**
 * Leitura mais velha que isto (s) é descartada: chegou tarde demais para saber com
 * segurança em que ponto da música foi cantada.
 */
export const MAX_SAMPLE_AGE = 1.2
/** O relógio do celular nunca fica exatamente igual ao do host: tolera leitura "do futuro" até aqui (s). */
const CLOCK_SLACK = 0.25
/** Leituras com voz (meio segundo cantando) para alguém entrar no resultado da rodada. */
export const MIN_VOICED = 12

interface Singer {
  engine: ScoreEngine
  voiced: number
}

/** Chave de comparação de nomes: sem acento, caixa nem espaços repetidos. Igual à do servidor da sala. */
export function nameKey(name: string): string {
  return name
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Pontuação dos convidados da sala: um motor por pessoa, todos sobre a mesma partitura.
 *
 * O tom de cada um chega do próprio celular, em lotes e com o atraso da rede. Por isso
 * cada leitura traz o instante em que foi captada, e é por ele que ela é encaixada na música.
 */
export class RoomScores {
  private reference: ScoreReference
  private readonly rules: ScoreRules
  private readonly singers = new Map<string, Singer>()
  private cutoff = 0

  constructor(reference: ScoreReference, rules: ScoreRules) {
    this.reference = reference
    this.rules = rules
  }

  get size(): number {
    return this.singers.size
  }

  private singer(name: string): Singer {
    let singer = this.singers.get(name)
    if (!singer) {
      singer = { engine: new ScoreEngine(this.reference, this.rules), voiced: 0 }
      this.singers.set(name, singer)
    }
    return singer
  }

  /** Reserva um lugar no placar para cada nome. Quem sai da sala continua com a nota que fez. */
  enroll(names: readonly string[]): void {
    for (const name of names) this.singer(name)
  }

  /**
   * A música voltou a tocar ou pulou de lugar em `wallNow` (ms): o que foi captado antes
   * disso foi cantado sobre outro trecho e não pode mais ser encaixado.
   */
  mark(wallNow: number): void {
    this.cutoff = wallNow
  }

  /**
   * `songNow` é a posição da música (s) no instante `wallNow` (ms). A música anda no ritmo
   * do relógio, então uma leitura captada há X segundos foi cantada em `songNow - X`.
   */
  push(name: string, samples: readonly unknown[], songNow: number, wallNow: number, latency: number): void {
    const singer = this.singer(name)
    for (const sample of samples) {
      // O que vem da rede não é de confiança: confere o formato antes de usar.
      if (!Array.isArray(sample)) continue
      const [capturedAt, midi] = sample as unknown[]
      if (typeof capturedAt !== 'number' || !Number.isFinite(capturedAt) || capturedAt < this.cutoff) continue
      const age = (wallNow - capturedAt) / 1000
      if (age < -CLOCK_SLACK || age > MAX_SAMPLE_AGE) continue

      const pitch = typeof midi === 'number' && midi > 20 && midi < 110 ? midi : null
      if (pitch !== null) singer.voiced++
      singer.engine.push(songNow - Math.max(0, age) - latency, pitch)
    }
  }

  /** Fecha as linhas já cantadas. Espera `MAX_SAMPLE_AGE` além do fim de cada uma: até lá ainda pode chegar leitura. */
  closeLines(songTime: number): void {
    for (const { engine } of this.singers.values()) engine.closeLines(songTime - MAX_SAMPLE_AGE)
  }

  /** A música recomeçou: todo mundo volta a zero. */
  restart(reference: ScoreReference): void {
    this.reference = reference
    for (const singer of this.singers.values()) {
      singer.engine = new ScoreEngine(reference, this.rules)
      singer.voiced = 0
    }
  }

  /** A partitura mudou (atraso da letra ajustado em `songTime`): o que cada um já cantou continua valendo. */
  rebase(reference: ScoreReference, songTime: number): void {
    this.reference = reference
    for (const singer of this.singers.values()) {
      singer.engine.closeLines(songTime)
      const engine = new ScoreEngine(reference, this.rules)
      engine.adopt(singer.engine)
      singer.engine = engine
    }
  }

  /** Todos os inscritos, na ordem em que entraram. */
  entries(): RoomEntry[] {
    return [...this.singers].map(([name, { engine }]) => ({ name, points: engine.points, streak: engine.currentStreak }))
  }

  /** Resultado de quem cantou de verdade. Quem só estava na sala fica de fora. */
  results(): Array<{ name: string; summary: ScoreSummary }> {
    return [...this.singers].filter(([, singer]) => singer.voiced >= MIN_VOICED).map(([name, { engine }]) => ({ name, summary: engine.summary() }))
  }
}
