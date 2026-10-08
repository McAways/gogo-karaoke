import { describe, expect, it } from 'vitest'
import { buildLines } from '../lyrics-timing'
import type { RefNote } from '../types'
import { MAX_POINTS, rulesFor } from './engine'
import { buildReference } from './reference'
import type { ScoreReference } from './reference'
import { MAX_SAMPLE_AGE, RoomScores, nameKey } from './room'
import type { PitchSample } from './room'

/** Com saltos entre as notas: uma leitura encaixada no lugar errado cai longe do tom. */
const LEAPS = [60, 67, 62, 69]
/** Em graus conjuntos: quem canta um trítono acima fica longe de todas as notas vizinhas. */
const STEPS = [60, 62, 64, 65]

/** Três linhas de 2 s com quatro notas de 0,5 s cada. */
function song(offset = 0, pitches = LEAPS): { reference: ScoreReference; notes: RefNote[] } {
  const lines = buildLines([
    { time: 10 + offset, text: 'primeira linha da canção' },
    { time: 12 + offset, text: '' },
    { time: 14 + offset, text: 'segunda linha da canção' },
    { time: 16 + offset, text: '' },
    { time: 18 + offset, text: 'terceira linha da canção' },
    { time: 20 + offset, text: '' },
  ])
  const notes: RefNote[] = [10, 14, 18].flatMap((start) =>
    pitches.map((midi, i) => ({ start: start + offset + i * 0.5, end: start + offset + (i + 1) * 0.5, midi, conf: 1 })),
  )
  return { reference: buildReference(lines, notes), notes }
}

const targetAt = (notes: RefNote[], t: number): number | null => notes.find((n) => t >= n.start && t < n.end)?.midi ?? null
const rules = rulesFor('normal', true)
/** O relógio do host marca isto (ms) quando a música está no segundo zero. */
const EPOCH = 1_700_000_000_000

interface Phone {
  name: string
  pitchAt: (songTime: number) => number | null
  /** Atraso entre captar e o lote chegar ao host, em segundos. */
  delay?: number
}

/**
 * Toca a música de `from` a `to`. Cada celular lê o tom 25 vezes por segundo e manda
 * um lote a cada 120 ms, que chega ao host `delay` segundos depois.
 */
function play(room: RoomScores, phones: Phone[], from: number, to: number): void {
  const inbox: Array<{ arrives: number; name: string; samples: PitchSample[] }> = []
  for (const phone of phones) {
    let batch: PitchSample[] = []
    for (let t = from; t < to; t += 0.04) {
      batch.push([EPOCH + t * 1000, phone.pitchAt(t)])
      if (batch.length === 3) {
        inbox.push({ arrives: t + (phone.delay ?? 0.03), name: phone.name, samples: batch })
        batch = []
      }
    }
  }
  inbox.sort((a, b) => a.arrives - b.arrives)

  let next = 0
  for (let now = from; now < to + 3; now += 1 / 60) {
    while (next < inbox.length && inbox[next].arrives <= now) {
      const { name, samples } = inbox[next++]
      room.push(name, samples, now, EPOCH + now * 1000, 0)
    }
    room.closeLines(now)
  }
}

describe('sala', () => {
  it('dá uma nota para cada pessoa, sem uma interferir na outra', () => {
    const { reference, notes } = song(0, STEPS)
    const room = new RoomScores(reference, rules)
    play(
      room,
      [
        { name: 'Ana', pitchAt: (t) => targetAt(notes, t) },
        { name: 'Beto', pitchAt: (t) => (targetAt(notes, t) === null ? null : targetAt(notes, t)! + 6) },
        { name: 'Caio', pitchAt: (t) => (t < 14 ? targetAt(notes, t) : null) },
      ],
      9,
      21,
    )
    const results = Object.fromEntries(room.results().map((r) => [r.name, r.summary]))
    expect(results.Ana.points).toBe(MAX_POINTS)
    expect(results.Ana.bestStreak).toBe(3)
    expect(results.Beto.points).toBe(0)
    // Caio cantou só a primeira das três linhas.
    expect(results.Caio.lines).toEqual([1, 0, 0])
    expect(results.Caio.points).toBeGreaterThan(3000)
    expect(results.Caio.points).toBeLessThan(3700)
  })

  it('encaixa a leitura pelo instante em que foi captada, não pelo instante em que chegou', () => {
    const { reference, notes } = song()
    const room = new RoomScores(reference, rules)
    // Rede lenta: os lotes chegam 0,6 s depois. Sem o carimbo de tempo, as notas cairiam todas no lugar errado.
    play(room, [{ name: 'Ana', pitchAt: (t) => targetAt(notes, t), delay: 0.6 }], 9, 21)
    const [ana] = room.results()
    expect(ana.summary.points).toBe(MAX_POINTS)
    expect(ana.summary.lines).toEqual([1, 1, 1])
  })

  it('descarta leitura que chegou tarde demais', () => {
    const { reference, notes } = song()
    const room = new RoomScores(reference, rules)
    play(room, [{ name: 'Ana', pitchAt: (t) => targetAt(notes, t), delay: MAX_SAMPLE_AGE + 0.5 }], 9, 21)
    expect(room.entries()).toEqual([{ name: 'Ana', points: 0, streak: 0 }])
    expect(room.results()).toEqual([])
  })

  it('ignora o que foi captado antes de a música pular ou voltar a tocar', () => {
    const { reference, notes } = song()
    const room = new RoomScores(reference, rules)
    // A música foi retomada com o relógio em 12 s: o lote captado antes disso é de quando estava parada.
    room.mark(EPOCH + 12_000)
    const stale: PitchSample[] = [10.0, 10.04, 10.08, 10.12].map((t) => [EPOCH + t * 1000, targetAt(notes, t)])
    room.push('Ana', stale, 10.2, EPOCH + 10_200, 0)
    expect(room.entries()[0].points).toBe(0)
    const fresh: PitchSample[] = [12.0, 12.04, 12.08].map((t) => [EPOCH + t * 1000, 60])
    room.push('Ana', fresh, 10.1, EPOCH + 12_100, 0)
    expect(room.entries()[0].points).toBeGreaterThan(0)
  })

  it('quem está na sala e não canta aparece no placar, mas fica fora do resultado', () => {
    const { reference, notes } = song()
    const room = new RoomScores(reference, rules)
    room.enroll(['Ana', 'Dora'])
    play(room, [{ name: 'Ana', pitchAt: (t) => targetAt(notes, t) }], 9, 21)
    expect(room.size).toBe(2)
    expect(room.entries().map((e) => e.name)).toEqual(['Ana', 'Dora'])
    expect(room.entries()[1].points).toBe(0)
    expect(room.results().map((r) => r.name)).toEqual(['Ana'])
  })

  it('mantém o que já foi cantado quando o atraso da letra muda', () => {
    const { reference, notes } = song()
    const room = new RoomScores(reference, rules)
    play(room, [{ name: 'Ana', pitchAt: (t) => targetAt(notes, t) }], 9, 13)
    const before = room.entries()[0].points
    expect(before).toBeGreaterThan(3000)

    const later = song(0.3)
    room.rebase(later.reference, 13)
    expect(room.entries()[0].points).toBe(before)
    play(room, [{ name: 'Ana', pitchAt: (t) => targetAt(later.notes, t) }], 13, 21.5)
    expect(room.results()[0].summary.points).toBe(MAX_POINTS)
  })

  it('zera todo mundo quando a música recomeça', () => {
    const { reference, notes } = song()
    const room = new RoomScores(reference, rules)
    play(room, [{ name: 'Ana', pitchAt: (t) => targetAt(notes, t) }], 9, 21)
    room.restart(reference)
    expect(room.entries()).toEqual([{ name: 'Ana', points: 0, streak: 0 }])
    expect(room.results()).toEqual([])
  })

  it('não quebra com mensagem malformada', () => {
    const { reference } = song()
    const room = new RoomScores(reference, rules)
    const junk: unknown[] = [null, 7, 'x', [], ['agora', 60], [EPOCH + 10_000, 'dó'], [Number.NaN, 60], [EPOCH + 10_000, 9999]]
    expect(() => room.push('Ana', junk, 10, EPOCH + 10_000, 0)).not.toThrow()
    expect(room.entries()[0].points).toBe(0)
    expect(room.results()).toEqual([])
  })

  it('trata como iguais nomes que só mudam em acento, caixa ou espaços', () => {
    expect(nameKey('  ANÁ ')).toBe(nameKey('ana'))
    expect(nameKey('João  Pedro')).toBe(nameKey('joao pedro'))
    expect(nameKey('Ana')).not.toBe(nameKey('Anna'))
  })
})
