import { describe, expect, it } from 'vitest'
import { buildLines } from '../lyrics-timing'
import type { LyricLine, RefNote } from '../types'
import { MAX_POINTS, ScoreEngine, chromaDiff, gradeFor, ratingFor, rulesFor } from './engine'
import { buildReference } from './reference'

/** Três linhas de 2 s, cada uma com quatro notas de 0,5 s. */
function song(): { lines: LyricLine[]; notes: RefNote[] } {
  const lines = buildLines([
    { time: 10, text: 'primeira linha da canção' },
    { time: 12, text: '' },
    { time: 14, text: 'segunda linha da canção' },
    { time: 16, text: '' },
    { time: 18, text: 'terceira linha da canção' },
    { time: 20, text: '' },
  ])
  const pitches = [60, 62, 64, 65]
  const notes: RefNote[] = [10, 14, 18].flatMap((start) =>
    pitches.map((midi, i) => ({ start: start + i * 0.5, end: start + (i + 1) * 0.5, midi, conf: 1 })),
  )
  return { lines, notes }
}

/** Canta de `from` a `to`, 60 amostras por segundo, com a nota dada por `pitchAt`. */
function sing(engine: ScoreEngine, from: number, to: number, pitchAt: (t: number) => number | null): void {
  for (let t = from; t < to; t += 1 / 60) {
    engine.push(t, pitchAt(t))
    engine.closeLines(t)
  }
}

function targetAt(notes: RefNote[], t: number): number | null {
  return notes.find((n) => t >= n.start && t < n.end)?.midi ?? null
}

const exact = rulesFor('normal', true)

describe('referência', () => {
  it('liga notas às linhas e mantém os slots em ordem', () => {
    const { lines, notes } = song()
    const ref = buildReference(lines, notes)
    expect(ref.mode).toBe('melodia')
    expect(ref.melodyShare).toBe(1)
    expect(ref.lines.map((l) => l.mode)).toEqual(['melodia', 'melodia', 'melodia'])
    expect(ref.laneNotes).toHaveLength(12)
    for (let i = 1; i < ref.slots.length; i++) expect(ref.slots[i].t0).toBeGreaterThanOrEqual(ref.slots[i - 1].t1 - 1e-9)
    expect(ref.lines[1].firstSlot).toBe(ref.lines[0].lastSlot)
  })

  it('ignora notas fora das linhas (solo, introdução)', () => {
    const { lines, notes } = song()
    const solo: RefNote = { start: 2, end: 6, midi: 70, conf: 1 }
    const ref = buildReference(lines, [solo, ...notes])
    expect(ref.laneNotes.some((n) => n.midi === 70)).toBe(false)
  })

  it('cai para presença quando o guia não cobre a linha', () => {
    const { lines, notes } = song()
    const ref = buildReference(lines, notes.slice(0, 4))
    expect(ref.lines.map((l) => l.mode)).toEqual(['melodia', 'presenca', 'presenca'])
    expect(ref.melodyShare).toBeCloseTo(1 / 3, 6)
    expect(ref.slots.filter((s) => s.line === 1).every((s) => s.midi === null)).toBe(true)
  })

  it('sem letra, agrupa as notas em frases', () => {
    const { notes } = song()
    const ref = buildReference([], notes)
    expect(ref.lines).toHaveLength(3)
    expect(ref.mode).toBe('melodia')
  })

  it('sem letra e sem guia não há o que pontuar', () => {
    expect(buildReference([], []).mode).toBe('nenhum')
  })
})

describe('pontuação', () => {
  it('dá nota máxima a quem canta as notas certas', () => {
    const { lines, notes } = song()
    const engine = new ScoreEngine(buildReference(lines, notes), exact)
    sing(engine, 9, 21, (t) => targetAt(notes, t))
    const result = engine.summary()
    expect(result.points).toBe(MAX_POINTS)
    expect(result.bestStreak).toBe(3)
    expect(result.lines).toEqual([1, 1, 1])
  })

  it('aceita cantar uma oitava abaixo ou acima', () => {
    const { lines, notes } = song()
    for (const shift of [-12, 12, -24]) {
      const engine = new ScoreEngine(buildReference(lines, notes), exact)
      sing(engine, 9, 21, (t) => {
        const target = targetAt(notes, t)
        return target === null ? null : target + shift
      })
      expect(engine.summary().points).toBe(MAX_POINTS)
    }
  })

  it('zera quem canta longe do tom', () => {
    const { lines, notes } = song()
    const engine = new ScoreEngine(buildReference(lines, notes), exact)
    // Sempre a 6 semitons (trítono) da nota certa: o pior erro possível.
    sing(engine, 9, 21, (t) => {
      const target = targetAt(notes, t)
      return target === null ? null : target + 6
    })
    const result = engine.summary()
    expect(result.points).toBe(0)
    expect(result.bestStreak).toBe(0)
  })

  it('não pontua silêncio', () => {
    const { lines, notes } = song()
    const engine = new ScoreEngine(buildReference(lines, notes), exact)
    sing(engine, 9, 21, () => null)
    expect(engine.summary().points).toBe(0)
  })

  it('dá crédito parcial a quem erra por pouco', () => {
    const { lines, notes } = song()
    const engine = new ScoreEngine(buildReference(lines, notes), exact)
    // 2,1 semitons acima em notas longe umas das outras: metade do caminho entre acerto e erro.
    const far: RefNote[] = [{ start: 10, end: 12, midi: 60, conf: 1 }]
    const ref = buildReference([lines[0]], far)
    const partial = new ScoreEngine(ref, exact)
    sing(partial, 9.5, 12.5, (t) => (t >= 10 && t < 12 ? 62.1 : null))
    expect(partial.summary().accuracy).toBeCloseTo(0.5, 1)
    expect(engine.points).toBe(0)
  })

  it('perdoa um pequeno atraso, mas não um grande', () => {
    const { lines } = song()
    // Melodia com saltos: em graus conjuntos, a nota atrasada cai dentro da tolerância.
    const leaps = [60, 67, 62, 69]
    const notes: RefNote[] = [10, 14, 18].flatMap((start) =>
      leaps.map((midi, i) => ({ start: start + i * 0.5, end: start + (i + 1) * 0.5, midi, conf: 1 })),
    )
    const late = (delay: number) => {
      const engine = new ScoreEngine(buildReference(lines, notes), exact)
      sing(engine, 9, 22, (t) => targetAt(notes, t - delay))
      return engine.summary().accuracy
    }
    expect(late(0.08)).toBeGreaterThan(0.97)
    expect(late(0.6)).toBeLessThan(0.3)
  })

  it('zera a sequência quando uma linha sai ruim', () => {
    const { lines, notes } = song()
    const engine = new ScoreEngine(buildReference(lines, notes), exact)
    const results = []
    for (let t = 9; t < 22; t += 1 / 60) {
      // Canta a primeira e a terceira linhas, fica mudo na segunda.
      engine.push(t, t >= 13 && t < 17 ? null : targetAt(notes, t))
      results.push(...engine.closeLines(t))
    }
    expect(results.map((r) => r.rating)).toEqual(['perfeito', 'errou', 'perfeito'])
    expect(results.map((r) => r.streak)).toEqual([1, 0, 1])
    expect(engine.summary().bestStreak).toBe(1)
  })

  it('em linha sem guia, basta cantar no tempo', () => {
    const { lines } = song()
    const ref = buildReference(lines, [])
    expect(ref.mode).toBe('presenca')
    const engine = new ScoreEngine(ref, exact)
    sing(engine, 9, 21, (t) => (lines.some((l) => t >= l.start && t < l.end) ? 57 : null))
    const result = engine.summary()
    expect(result.mode).toBe('presenca')
    expect(result.points).toBeGreaterThan(9000)
  })

  it('com guia automático, 90% de acerto já vale nota máxima', () => {
    const { lines, notes } = song()
    const auto = rulesFor('normal', false)
    expect(auto.ceiling).toBe(0.9)
    expect(auto.tolerance).toBeGreaterThan(exact.tolerance)
    const engine = new ScoreEngine(buildReference(lines, notes), auto)
    // Erra de propósito a última das 12 notas (8% da música).
    sing(engine, 9, 21, (t) => {
      const target = targetAt(notes, t)
      return target === null ? null : t >= 19.5 ? target + 6 : target
    })
    expect(engine.summary().points).toBe(MAX_POINTS)
  })

  it('classifica linhas e resultado final', () => {
    expect(chromaDiff(61, 60)).toBe(1)
    expect(chromaDiff(47, 60)).toBe(-1)
    expect(chromaDiff(66, 60)).toBe(-6)
    expect([0.9, 0.7, 0.5, 0.2, 0].map(ratingFor)).toEqual(['perfeito', 'otimo', 'bom', 'quase', 'errou'])
    expect(gradeFor(9500).label).toBe('Lendário')
    expect(gradeFor(100).label).toBe('Tímido')
  })
})
