import { describe, expect, it } from 'vitest'
import { alignLyrics, phraseOnsets } from './alignment'
import type { Span } from './alignment'

/**
 * Uma "música" de teste: versos de tamanhos variados em três blocos, com pausas
 * instrumentais entre eles. A voz é cada verso cantado em duas ou três notas.
 */
function song(): { lines: Span[]; voice: Span[]; duration: number } {
  const lines: Span[] = []
  const voice: Span[] = []
  const lengths = [2.6, 3.4, 2.2, 4.1, 3.0, 2.8, 3.7, 2.4, 3.9, 2.9, 3.3, 2.5]
  let t = 12
  lengths.forEach((length, i) => {
    // Pausa instrumental a cada quatro versos.
    if (i > 0 && i % 4 === 0) t += 14
    lines.push({ start: t, end: t + length })
    const notes = 2 + (i % 2)
    for (let n = 0; n < notes; n++) {
      const start = t + (n * (length - 0.4)) / notes
      voice.push({ start, end: start + (length - 0.4) / notes - 0.05 })
    }
    // Respiro entre um verso e o seguinte.
    t += length + 0.5
  })
  return { lines, voice, duration: t + 15 }
}

const shift = (spans: Span[], seconds: number): Span[] => spans.map((s) => ({ start: s.start + seconds, end: s.end + seconds }))

describe('encaixe da letra no áudio', () => {
  it('acha atraso zero quando a letra já está no lugar', () => {
    const { lines, voice, duration } = song()
    const result = alignLyrics(lines, voice, duration)
    expect(result).not.toBeNull()
    expect(Math.abs(result!.offset)).toBeLessThan(0.06)
    expect(result!.onsets).toBeGreaterThan(0.9)
    expect(result!.coverage).toBeGreaterThan(0.7)
  })

  it('recupera o atraso de uma letra adiantada ou atrasada', () => {
    const { lines, voice, duration } = song()
    for (const seconds of [-7.3, -1.5, 0.8, 4.6, 12.2]) {
      // A letra foi escrita `seconds` antes do áudio: precisa ser atrasada nesse tanto.
      const result = alignLyrics(shift(lines, -seconds), voice, duration)
      expect(result!.offset).toBeCloseTo(seconds, 1)
      expect(result!.onsets).toBeGreaterThan(0.9)
    }
  })

  it('dá nota baixa a uma letra de outra versão da música', () => {
    const { lines, voice, duration } = song()
    // Mesma quantidade de versos, mas com outro andamento: nenhum atraso único faz encaixar.
    const otherVersion = lines.map((_, i) => ({ start: 5 + i * 5.3, end: 5 + i * 5.3 + 3 }))
    const right = alignLyrics(lines, voice, duration)!
    const wrong = alignLyrics(otherVersion, voice, duration)!
    expect(wrong.onsets).toBeLessThan(0.5)
    expect(right.onsets - wrong.onsets).toBeGreaterThan(0.4)
  })

  it('devolve null quando não há o que comparar', () => {
    const { lines, voice, duration } = song()
    expect(alignLyrics(lines.slice(0, 2), voice, duration)).toBeNull()
    expect(alignLyrics(lines, [], duration)).toBeNull()
    expect(alignLyrics(lines, voice, 0)).toBeNull()
  })

  it('conta como começo de frase só a nota que entra depois de um silêncio', () => {
    const onsets = phraseOnsets([
      { start: 1, end: 1.8 },
      { start: 1.85, end: 2.5 },
      { start: 3.2, end: 4 },
      { start: 4.1, end: 4.9 },
      { start: 6, end: 7 },
    ])
    expect(onsets).toEqual([1, 3.2, 6])
  })
})
