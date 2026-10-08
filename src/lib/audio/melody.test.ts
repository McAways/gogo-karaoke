import { describe, expect, it } from 'vitest'
import { analyzeMelody, envelope } from './melody'
import type { MelodyAnalysis } from './melody'
import { renderSong, renderVoice } from './synth'
import type { SynthNote } from './synth'
import { FFT } from './fft'

/** Diferença em semitons ignorando a oitava, entre -6 e 6. */
function chromaDiff(a: number, b: number): number {
  return ((((a - b) % 12) + 18) % 12) - 6
}

/** Fração dos quadros cantados em que o contorno acerta a nota (a menos de oitava). */
function chromaAccuracy(analysis: MelodyAnalysis, melody: SynthNote[], windowSeconds: number): number {
  let total = 0
  let correct = 0
  for (let f = 0; f < analysis.contour.length; f++) {
    const t = f * analysis.hopSeconds + windowSeconds / 2
    // Ignora as bordas das notas, onde a janela pega duas alturas ao mesmo tempo.
    const note = melody.find((n) => t >= n.start + 0.06 && t <= n.end - 0.06)
    if (!note) continue
    total++
    if (analysis.contour[f] > 0 && Math.abs(chromaDiff(analysis.contour[f], note.midi)) <= 0.5) correct++
  }
  return correct / total
}

describe('FFT', () => {
  it('acha a frequência de uma senoide', () => {
    const size = 1024
    const fft = new FFT(size)
    const re = new Float64Array(size)
    const im = new Float64Array(size)
    for (let i = 0; i < size; i++) re[i] = Math.sin((2 * Math.PI * 37 * i) / size)
    fft.transform(re, im)
    let peak = 0
    for (let k = 1; k < size / 2; k++) if (Math.hypot(re[k], im[k]) > Math.hypot(re[peak], im[peak])) peak = k
    expect(peak).toBe(37)
    expect(Math.hypot(re[37], im[37])).toBeCloseTo(size / 2, 3)
  })
})

describe('extração de melodia', () => {
  const window = 2048 / 22050

  it('segue uma voz sozinha (mono)', () => {
    const sampleRate = 22050
    const melody: SynthNote[] = [60, 64, 67, 72, 67, 64].map((midi, i) => ({ midi, start: 0.3 + i * 0.6, end: 0.3 + i * 0.6 + 0.5 }))
    const audio = new Float32Array(Math.floor(4.2 * sampleRate))
    renderVoice(audio, sampleRate, melody)

    const analysis = analyzeMelody(audio, null, sampleRate)
    expect(chromaAccuracy(analysis, melody, window)).toBeGreaterThan(0.95)
    expect(analysis.stereoWidth).toBe(0)
    // Sem acompanhamento, cada nota cantada vira uma nota do guia, na altura e na oitava certas.
    expect(analysis.notes).toHaveLength(melody.length)
    analysis.notes.forEach((note, i) => {
      expect(Math.abs((note.midi ?? 0) - melody[i].midi)).toBeLessThan(0.4)
      expect(Math.abs(note.start - melody[i].start)).toBeLessThan(0.08)
    })
  })

  it('segue a voz por cima de baixo, acordes e bateria', () => {
    const song = renderSong()
    const analysis = analyzeMelody(song.left, song.right, song.sampleRate)
    const accuracy = chromaAccuracy(analysis, song.melody, window)
    expect(accuracy).toBeGreaterThan(0.85)
    expect(analysis.stereoWidth).toBeGreaterThan(0.01)
  })

  it('aguenta a voz mais baixa que o acompanhamento', () => {
    const song = renderSong({ voiceGain: 0.12 })
    const analysis = analyzeMelody(song.left, song.right, song.sampleRate)
    expect(chromaAccuracy(analysis, song.melody, window)).toBeGreaterThan(0.75)
  })

  it('não inventa notas no silêncio', () => {
    const analysis = analyzeMelody(new Float32Array(22050 * 2), null, 22050)
    expect(analysis.notes).toHaveLength(0)
  })

  it('informa o progresso e gera o envelope', () => {
    const song = renderSong()
    const ticks: number[] = []
    const analysis = analyzeMelody(song.left, song.right, song.sampleRate, (r) => ticks.push(r))
    expect(ticks.length).toBeGreaterThan(1)
    expect(Math.max(...analysis.peaks)).toBeCloseTo(1, 5)
    expect(envelope(new Float32Array(10), null, 100)).toHaveLength(100)
  })
})
