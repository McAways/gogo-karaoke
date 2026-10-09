import { describe, expect, it } from 'vitest'
import { VoiceTrace } from './voice-trace'

const FRAME = 1 / 60

/** Canta `midi` de `from` a `to` (s), uma leitura por quadro. O relógio de parede anda junto com a música. */
function sing(trace: VoiceTrace, from: number, to: number, midi: number | ((time: number) => number), target: number | null = 57): void {
  for (let time = from; time < to - 1e-9; time += FRAME) {
    const note = typeof midi === 'number' ? midi : midi(time)
    trace.push(time, time, note, target, target !== null && Math.abs(note - target) < 1, 60)
  }
}

describe('linha da voz na pista de tom', () => {
  it('atravessa um buraco curto sem partir a linha nem apagar a marca', () => {
    const trace = new VoiceTrace()
    sing(trace, 0, 0.5, 57)
    // 100 ms sem leitura (uma consoante): a marca fica onde estava.
    expect(trace.cursor(0.6)).toMatchObject({ value: 57, strength: 1 })
    sing(trace, 0.6, 1, 57)
    expect(trace.points.filter((point) => point.start)).toHaveLength(1)
    expect(trace.cursor(1)).toMatchObject({ value: 57, onPitch: true, strength: 1 })
  })

  it('a marca espera um pouco e depois apaga aos poucos', () => {
    const trace = new VoiceTrace()
    sing(trace, 0, 0.5, 57)
    const last = trace.points.at(-1)!.time
    expect(trace.cursor(last + 0.15)?.strength).toBe(1)
    expect(trace.cursor(last + 0.325)?.strength).toBeCloseTo(0.5, 1)
    expect(trace.cursor(last + 0.5)).toBeNull()
  })

  it('uma leitura sozinha não aparece', () => {
    const trace = new VoiceTrace()
    trace.push(1, 1, 57, 57, true, 60)
    expect(trace.cursor(1)).toBeNull()
    // Só existe o começo de um trecho: não há o que ligar, então nada é desenhado.
    expect(trace.points.filter((point) => !point.start)).toHaveLength(0)

    trace.push(1 + FRAME, 1 + FRAME, 57, 57, true, 60)
    expect(trace.cursor(1 + FRAME)).not.toBeNull()
  })

  it('um silêncio longo parte a linha e a voz precisa se firmar de novo', () => {
    const trace = new VoiceTrace()
    sing(trace, 0, 0.5, 57)
    trace.push(1.2, 1.2, 57, 57, true, 60)
    expect(trace.points.at(-1)?.start).toBe(true)
    expect(trace.cursor(1.2)).toBeNull()
  })

  it('desenha a voz na oitava da nota pedida e, fora de nota, na oitava em que vinha', () => {
    const trace = new VoiceTrace()
    // Cantando uma oitava abaixo da nota do guia.
    sing(trace, 0, 0.3, 45)
    expect(trace.points.at(-1)?.value).toBeCloseTo(57, 5)
    // A nota acaba e a voz segue um semitom acima: continua perto de 57, não cai para 46.
    sing(trace, 0.3, 0.6, 46, null)
    expect(trace.points.at(-1)?.value).toBeCloseTo(58, 1)
    expect(trace.points.filter((point) => point.start)).toHaveLength(1)
  })

  it('quem canta a meio caminho entre duas oitavas não faz a linha pular de cima para baixo', () => {
    const trace = new VoiceTrace()
    // Seis semitons acima da nota, com um leve vibrato: a oitava mais próxima troca a cada oscilação.
    sing(trace, 0, 1, (time) => 63 + 0.3 * Math.sin(time * 2 * Math.PI * 5.5))
    expect(trace.points.filter((point) => point.start)).toHaveLength(1)
    const values = trace.points.map((point) => point.value)
    expect(Math.max(...values) - Math.min(...values)).toBeLessThan(1)

    // A linha ficou embaixo da nota. Quando a voz chega perto da nota por cima, a dúvida acaba e a linha vai para lá.
    expect(values.every((value) => value < 57)).toBe(true)
    sing(trace, 1, 1.2, 60)
    expect(trace.points.at(-1)?.value).toBeCloseTo(60, 1)
    expect(trace.points.filter((point) => point.start)).toHaveLength(2)
  })

  it('sem nota nem voz anterior, usa a altura de referência', () => {
    const trace = new VoiceTrace()
    trace.push(0, 0, 38, null, false, 60)
    expect(trace.points[0].value).toBe(62)
  })

  it('um salto grande parte a linha, mas a marca não pisca', () => {
    const trace = new VoiceTrace()
    sing(trace, 0, 0.5, 57)
    trace.push(0.5, 0.5, 64, 64, true, 60)
    expect(trace.points.at(-1)).toMatchObject({ value: 64, start: true })
    expect(trace.cursor(0.5)).toMatchObject({ value: 64, strength: 1 })
  })

  it('tira o tremido da leitura sem sair da nota', () => {
    const trace = new VoiceTrace()
    let flip = 1
    sing(trace, 0, 1, () => 57 + 0.5 * (flip = -flip))
    const values = trace.points.slice(10).map((point) => point.value)
    expect(Math.max(...values) - Math.min(...values)).toBeLessThan(0.45)
    expect(Math.abs(values.reduce((sum, value) => sum + value, 0) / values.length - 57)).toBeLessThan(0.1)
  })

  it('limpar esquece tudo', () => {
    const trace = new VoiceTrace()
    sing(trace, 0, 0.5, 57)
    trace.clear()
    expect(trace.points).toHaveLength(0)
    expect(trace.cursor(0.5)).toBeNull()
  })
})
