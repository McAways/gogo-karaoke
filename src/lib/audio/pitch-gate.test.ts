import { describe, expect, it } from 'vitest'
import { PitchGate } from './pitch-gate'
import type { PitchReading } from './pitch-gate'

const A3 = 220
const MIDI_A3 = 57

/** Alimenta o portão com medidas regulares e devolve as leituras, uma por medida. */
function feed(gate: PitchGate, from: number, seconds: number, fps: number, frame: (time: number) => { hz: number; clarity: number; db: number }): PitchReading[] {
  const readings: PitchReading[] = []
  for (let i = 0; i < Math.round(seconds * fps); i++) {
    const time = from + i / fps
    readings.push(gate.push({ time, ...frame(time) }))
  }
  return readings
}

const room = () => ({ hz: 0, clarity: 0.2, db: -60 })
const voice = () => ({ hz: A3, clarity: 0.95, db: -20 })
const fading = () => ({ hz: A3, clarity: 0.75, db: -24 })

/** Um portão que já ouviu um segundo de sala vazia e meio segundo de voz firme. Devolve o instante seguinte. */
function singing(fps = 60): { gate: PitchGate; now: number } {
  const gate = new PitchGate()
  feed(gate, 0, 1, fps, room)
  feed(gate, 1, 0.5, fps, voice)
  return { gate, now: 1.5 }
}

describe('portão do detector de tom', () => {
  it('lê uma nota firme, e nada na sala vazia', () => {
    const gate = new PitchGate()
    expect(feed(gate, 0, 1, 60, room).every((r) => r.midi === null && r.shown === null)).toBe(true)
    const sung = feed(gate, 1, 0.5, 60, voice)
    expect(sung.every((r) => r.midi !== null && Math.abs(r.midi - MIDI_A3) < 0.01 && r.shown === r.midi)).toBe(true)
  })

  it('a nota que perde nitidez continua desenhada por um tempo, mas não vale ponto', () => {
    const { gate, now } = singing()
    const weak = feed(gate, now, 0.6, 60, fading)
    expect(weak.every((r) => r.midi === null)).toBe(true)
    // Segue por 0,4 s depois da última leitura firme, e aí para.
    expect(weak.slice(0, 20).every((r) => r.shown !== null && Math.abs(r.shown - MIDI_A3) < 0.01)).toBe(true)
    expect(weak.slice(-6).every((r) => r.shown === null)).toBe(true)
  })

  it('som pouco nítido que não continua uma voz não vira nota', () => {
    const gate = new PitchGate()
    feed(gate, 0, 1, 60, room)
    expect(feed(gate, 1, 0.5, 60, fading).every((r) => r.shown === null)).toBe(true)
  })

  it('na continuação, erro de oitava fica na oitava de antes e nota distante é descartada', () => {
    const octave = singing()
    const below = octave.gate.push({ time: octave.now, hz: A3 / 2, clarity: 0.75, db: -24 })
    expect(below.shown).toBeCloseTo(MIDI_A3, 2)

    const fifth = singing()
    expect(fifth.gate.push({ time: fifth.now, hz: A3 * 1.5, clarity: 0.75, db: -24 }).shown).toBeNull()
  })

  it('acompanha um deslize de nota enquanto continua', () => {
    const { gate, now } = singing()
    // Sobe dois semitons em 0,3 s, sempre pouco nítida.
    const slide = feed(gate, now, 0.3, 60, (time) => ({ hz: A3 * 2 ** ((2 * (time - now)) / 0.3 / 12), clarity: 0.75, db: -24 }))
    expect(slide.at(-1)?.shown).toBeGreaterThan(MIDI_A3 + 1.7)
  })

  it('tira o pulo de um instante, tanto a 60 quanto a 120 quadros por segundo', () => {
    for (const fps of [60, 120]) {
      const { gate, now } = singing(fps)
      // 16 ms de leitura errada (uma quinta acima) no meio da nota: um quadro a 60, dois a 120.
      const readings = feed(gate, now, 0.2, fps, (time) => (time - now > 0.0999 && time - now < 0.116 ? { hz: A3 * 1.5, clarity: 0.95, db: -20 } : voice()))
      expect(readings.every((r) => r.midi !== null && Math.abs(r.midi - MIDI_A3) < 0.01)).toBe(true)
    }
  })

  it('voz baixa demais em relação ao ruído da sala não passa', () => {
    const gate = new PitchGate()
    // Meio minuto de música saindo das caixas: o piso de ruído sobe devagar até ela.
    feed(gate, 0, 30, 60, () => ({ hz: 0, clarity: 0.2, db: -30 }))
    // Tonal, mas só 4 dB acima do que a sala já tinha.
    expect(feed(gate, 30, 0.2, 60, () => ({ hz: A3, clarity: 0.95, db: -26 })).every((r) => r.midi === null)).toBe(true)
    expect(feed(gate, 30.2, 0.2, 60, () => ({ hz: A3, clarity: 0.95, db: -18 })).every((r) => r.midi !== null)).toBe(true)
  })
})
