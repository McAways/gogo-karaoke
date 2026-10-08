import type { RefNote } from '../types'
import { FFT } from './fft'

/**
 * Extrai a melodia principal (quase sempre a voz) de uma gravação completa.
 *
 * É o que permite pontuar qualquer música sem um arquivo de notas: o guia sai do
 * próprio áudio. O método é uma versão enxuta do "Melodia" (Salamon & Gómez, 2012):
 *
 *   1. espectro do canal central (voz costuma estar no meio do estéreo);
 *   2. soma harmônica: cada pico do espectro vota nas fundamentais que o explicam;
 *   3. Viterbi escolhe, quadro a quadro, o caminho mais forte e mais contínuo;
 *   4. o contorno vira notas (trechos de altura estável).
 *
 * Não separa voz de instrumento. Em trechos instrumentais ele segue o solo, por isso
 * a pontuação só usa as notas que caem dentro das linhas da letra.
 */

const WINDOW = 2048
const FFT_SIZE = 4096
const HOP = 512

const BIN_CENTS = 10
const REF_HZ = 55 // A1 = MIDI 33
const REF_MIDI = 33
const SALIENCE_BINS = 600 // 5 oitavas, até 1760 Hz
const MELODY_MIN_HZ = 82 // E2
const MELODY_MAX_HZ = 1000 // B5

const MAX_HARMONICS = 12
const MAX_PEAKS = 48
const PEAK_FLOOR = 0.006 // -44 dB em relação ao maior pico do quadro
const CANDIDATES = 5

/** Parâmetros calibrados nos conjuntos ADC2004 e MIREX05 (ver melody.eval.test.ts). */
export interface MelodyTuning {
  harmonics: number
  harmonicDecay: number
  /** Quanto a saliência precisa valer para o quadro contar como cantado. */
  voicingThreshold: number
  /** Custo de entrar ou sair de um trecho cantado. */
  switchCost: number
  /** Custo por semitom de salto entre quadros vizinhos. */
  jumpCost: number
  /** Saltos até este tamanho (semitons) não custam nada: cobre o vibrato. */
  freeJump: number
}

// Medido em voz cantada: 81% de acerto de croma, guia cobrindo 89% do que é cantado
// e 89% das notas do guia a menos de 1 semitom da nota real (92% a menos de 1,5).
// O limiar de voz é baixo de propósito: nota sobrando em trecho instrumental não
// atrapalha, porque a pontuação só olha dentro das linhas da letra.
export const DEFAULT_TUNING: MelodyTuning = {
  harmonics: 12,
  harmonicDecay: 0.9,
  voicingThreshold: 0.25,
  switchCost: 0.3,
  jumpCost: 0.05,
  freeJump: 0.5,
}

const MIN_RUN_FRAMES = 5
const MIN_NOTE_FRAMES = 4
const NOTE_SPLIT_SEMITONES = 0.7

export interface MelodyAnalysis {
  notes: RefNote[]
  /** Nota MIDI por quadro. 0 quando o quadro não tem melodia. */
  contour: Float32Array
  hopSeconds: number
  /** Instante (s) que o quadro 0 representa: o centro da primeira janela. */
  contourStart: number
  peaks: Float32Array
  /** Energia do canal lateral sobre a do central. 0 = mono. */
  stereoWidth: number
}

function hann(size: number): Float64Array {
  const window = new Float64Array(size)
  for (let i = 0; i < size; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1))
  return window
}

/** Curva A: derruba o grave (baixo, bumbo) e realça a faixa onde a voz se destaca. */
function aWeight(hz: number): number {
  const f2 = hz * hz
  const num = 12194 ** 2 * f2 * f2
  const den = (f2 + 20.6 ** 2) * Math.sqrt((f2 + 107.7 ** 2) * (f2 + 737.9 ** 2)) * (f2 + 12194 ** 2)
  return (num / den) * 1.2589
}

function binOf(hz: number): number {
  return (1200 * Math.log2(hz / REF_HZ)) / BIN_CENTS
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

export function analyzeMelody(
  left: Float32Array,
  right: Float32Array | null,
  sampleRate: number,
  onProgress?: (ratio: number) => void,
  tuning: MelodyTuning = DEFAULT_TUNING,
): MelodyAnalysis {
  const HARMONICS = Math.min(MAX_HARMONICS, tuning.harmonics)
  const frames = Math.max(0, Math.floor((left.length - WINDOW) / HOP) + 1)
  const hopSeconds = HOP / sampleRate
  const stereo = right !== null && right.length === left.length

  const fft = new FFT(FFT_SIZE)
  const window = hann(WINDOW)
  const reL = new Float64Array(FFT_SIZE)
  const imL = new Float64Array(FFT_SIZE)
  const reR = new Float64Array(FFT_SIZE)
  const imR = new Float64Array(FFT_SIZE)

  const hzPerBin = sampleRate / FFT_SIZE
  const kLo = Math.max(2, Math.floor(70 / hzPerBin))
  const kHi = Math.min(FFT_SIZE / 2 - 2, Math.ceil(5200 / hzPerBin))
  const weight = new Float64Array(kHi + 2)
  for (let k = kLo - 1; k <= kHi + 1; k++) weight[k] = aWeight(k * hzPerBin)
  const mag = new Float64Array(kHi + 2)

  const harmonicShift = new Float64Array(HARMONICS + 1)
  const harmonicGain = new Float64Array(HARMONICS + 1)
  for (let h = 1; h <= HARMONICS; h++) {
    harmonicShift[h] = (1200 * Math.log2(h)) / BIN_CENTS
    harmonicGain[h] = tuning.harmonicDecay ** (h - 1)
  }
  // Lóbulo cos² de ±1 semitom (±10 bins), tabelado a cada 0,1 bin.
  const lobe = new Float64Array(101)
  for (let i = 0; i <= 100; i++) lobe[i] = Math.cos(((i / 100) * Math.PI) / 2) ** 2

  const binLo = Math.max(1, Math.floor(binOf(MELODY_MIN_HZ)))
  const binHi = Math.min(SALIENCE_BINS - 2, Math.ceil(binOf(MELODY_MAX_HZ)))
  const salience = new Float64Array(SALIENCE_BINS)

  const peakBin = new Float64Array(MAX_PEAKS)
  const peakAmp = new Float64Array(MAX_PEAKS)
  const candBin = new Float32Array(frames * CANDIDATES)
  const candSal = new Float32Array(frames * CANDIDATES)
  const frameTop = new Float32Array(frames)

  let midEnergy = 0
  let sideEnergy = 0

  for (let f = 0; f < frames; f++) {
    const offset = f * HOP
    for (let i = 0; i < WINDOW; i++) {
      const l = left[offset + i]
      reL[i] = l * window[i]
      if (stereo) {
        const r = right[offset + i]
        reR[i] = r * window[i]
        if ((i & 7) === 0) {
          midEnergy += (l + r) * (l + r)
          sideEnergy += (l - r) * (l - r)
        }
      }
    }
    reL.fill(0, WINDOW)
    imL.fill(0)
    fft.transform(reL, imL)
    if (stereo) {
      reR.fill(0, WINDOW)
      imR.fill(0)
      fft.transform(reR, imR)
    }

    // 1. Espectro do centro: bins iguais nos dois canais passam, o resto é atenuado.
    for (let k = kLo - 1; k <= kHi + 1; k++) {
      let m: number
      if (stereo) {
        const pl = reL[k] * reL[k] + imL[k] * imL[k]
        const pr = reR[k] * reR[k] + imR[k] * imR[k]
        const cross = reL[k] * reR[k] + imL[k] * imR[k]
        const similarity = (2 * cross) / (pl + pr + 1e-12)
        const mask = similarity > 0 ? similarity * similarity * similarity : 0
        m = 0.5 * Math.sqrt(Math.max(0, pl + pr + 2 * cross)) * mask
      } else {
        m = Math.sqrt(reL[k] * reL[k] + imL[k] * imL[k])
      }
      mag[k] = m * weight[k]
    }

    // 2. Picos do espectro, com interpolação parabólica para acertar a frequência.
    let frameMax = 0
    for (let k = kLo; k <= kHi; k++) if (mag[k] > frameMax) frameMax = mag[k]
    let peakCount = 0
    if (frameMax > 1e-7) {
      const floor = frameMax * PEAK_FLOOR
      for (let k = kLo; k <= kHi; k++) {
        const m = mag[k]
        if (m < floor || m <= mag[k - 1] || m < mag[k + 1]) continue
        const a = Math.log(mag[k - 1] + 1e-12)
        const b = Math.log(m + 1e-12)
        const c = Math.log(mag[k + 1] + 1e-12)
        const denom = a - 2 * b + c
        const delta = denom < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / denom)) : 0
        const bin = binOf((k + delta) * hzPerBin)

        if (peakCount < MAX_PEAKS) {
          peakBin[peakCount] = bin
          peakAmp[peakCount] = m
          peakCount++
        } else {
          let weakest = 0
          for (let p = 1; p < MAX_PEAKS; p++) if (peakAmp[p] < peakAmp[weakest]) weakest = p
          if (m > peakAmp[weakest]) {
            peakBin[weakest] = bin
            peakAmp[weakest] = m
          }
        }
      }
    }

    // 3. Soma harmônica: o pico em f vota em f, f/2, f/3... como possíveis fundamentais.
    salience.fill(0)
    for (let p = 0; p < peakCount; p++) {
      for (let h = 1; h <= HARMONICS; h++) {
        const b = peakBin[p] - harmonicShift[h]
        if (b < -10) break
        if (b > SALIENCE_BINS + 9) continue
        const gain = peakAmp[p] * harmonicGain[h]
        const center = Math.round(b)
        const from = Math.max(0, center - 10)
        const to = Math.min(SALIENCE_BINS - 1, center + 10)
        for (let j = from; j <= to; j++) {
          const distance = Math.abs(j - b)
          if (distance < 10) salience[j] += gain * lobe[Math.round(distance * 10)]
        }
      }
    }

    // 4. Os candidatos do quadro são os maiores máximos locais da saliência.
    const base = f * CANDIDATES
    for (let j = binLo; j <= binHi; j++) {
      const s = salience[j]
      if (s <= 0 || s <= salience[j - 1] || s < salience[j + 1]) continue
      let slot = -1
      for (let c = 0; c < CANDIDATES; c++) {
        if (candSal[base + c] === 0) {
          slot = c
          break
        }
        if (slot === -1 || candSal[base + c] < candSal[base + slot]) slot = c
      }
      if (candSal[base + slot] !== 0 && candSal[base + slot] >= s) continue
      const a = salience[j - 1]
      const c2 = salience[j + 1]
      const denom = a - 2 * s + c2
      candBin[base + slot] = j + (denom < 0 ? (0.5 * (a - c2)) / denom : 0)
      candSal[base + slot] = s
    }
    let top = 0
    for (let c = 0; c < CANDIDATES; c++) if (candSal[base + c] > top) top = candSal[base + c]
    frameTop[f] = top

    if (onProgress && (f & 255) === 0) onProgress(f / frames)
  }

  const contour = trackContour(candBin, candSal, frameTop, frames, tuning)
  // O quadro f representa o áudio em torno do centro da janela, não do início dela.
  const contourStart = WINDOW / 2 / sampleRate
  const notes = contourToNotes(contour.midi, contour.strength, hopSeconds, contourStart)

  return {
    notes,
    contour: contour.midi,
    hopSeconds,
    contourStart,
    peaks: envelope(left, stereo ? right : null, 1200),
    stereoWidth: stereo && midEnergy > 0 ? Math.min(1, sideEnergy / midEnergy) : 0,
  }
}

function trackContour(candBin: Float32Array, candSal: Float32Array, frameTop: Float32Array, frames: number, tuning: MelodyTuning) {
  const { voicingThreshold: VOICING_THRESHOLD, switchCost: SWITCH_COST, jumpCost: JUMP_COST, freeJump: FREE_JUMP } = tuning
  const midi = new Float32Array(frames)
  const strength = new Float32Array(frames)
  if (frames === 0) return { midi, strength }

  // A escala de saliência muda de gravação para gravação: normaliza pelo percentil 90.
  const sortedTop = Array.from(frameTop).filter((v) => v > 0).sort((a, b) => a - b)
  if (sortedTop.length === 0) return { midi, strength }
  const reference = sortedTop[Math.min(sortedTop.length - 1, Math.floor(sortedTop.length * 0.9))] || 1

  const STATES = CANDIDATES + 1
  const UNVOICED = CANDIDATES
  const back = new Uint8Array(frames * STATES)
  let prev = new Float64Array(STATES)
  let cur = new Float64Array(STATES)

  for (let f = 0; f < frames; f++) {
    const base = f * CANDIDATES
    const prevBase = (f - 1) * CANDIDATES

    for (let j = 0; j < CANDIDATES; j++) {
      const sal = candSal[base + j]
      if (sal <= 0) {
        cur[j] = -Infinity
        continue
      }
      let best = prev[UNVOICED] - (f === 0 ? 0 : SWITCH_COST)
      let arg = UNVOICED
      if (f > 0) {
        for (let i = 0; i < CANDIDATES; i++) {
          if (prev[i] === -Infinity) continue
          const semitones = Math.abs(candBin[prevBase + i] - candBin[base + j]) / 10
          const score = prev[i] - Math.min(12, Math.max(0, semitones - FREE_JUMP)) * JUMP_COST
          if (score > best) {
            best = score
            arg = i
          }
        }
      }
      cur[j] = best + Math.min(2, sal / reference)
      back[f * STATES + j] = arg
    }

    let best = prev[UNVOICED]
    let arg = UNVOICED
    if (f > 0) {
      for (let i = 0; i < CANDIDATES; i++) {
        const score = prev[i] - SWITCH_COST
        if (score > best) {
          best = score
          arg = i
        }
      }
    }
    cur[UNVOICED] = best + VOICING_THRESHOLD
    back[f * STATES + UNVOICED] = arg

    const swap = prev
    prev = cur
    cur = swap
  }

  let state = 0
  for (let s = 1; s < STATES; s++) if (prev[s] > prev[state]) state = s
  for (let f = frames - 1; f >= 0; f--) {
    if (state !== UNVOICED) {
      midi[f] = REF_MIDI + candBin[f * CANDIDATES + state] / 10
      strength[f] = Math.min(1.5, candSal[f * CANDIDATES + state] / reference)
    }
    state = back[f * STATES + state]
  }
  return { midi, strength }
}

function contourToNotes(midi: Float32Array, strength: Float32Array, hopSeconds: number, timeOffset: number): RefNote[] {
  const frames = midi.length
  const notes: RefNote[] = []

  let f = 0
  while (f < frames) {
    if (midi[f] === 0) {
      f++
      continue
    }
    let end = f
    while (end < frames && midi[end] !== 0) end++

    if (end - f < MIN_RUN_FRAMES) {
      midi.fill(0, f, end)
    } else {
      splitRun(midi, strength, f, end, hopSeconds, timeOffset, notes)
    }
    f = end
  }
  return mergeNotes(notes, hopSeconds)
}

function splitRun(
  midi: Float32Array,
  strength: Float32Array,
  from: number,
  to: number,
  hopSeconds: number,
  timeOffset: number,
  out: RefNote[],
): void {
  let start = from
  let values: number[] = [midi[from]]
  let center = midi[from]
  let drift = 0

  const close = (end: number) => {
    if (end - start >= MIN_NOTE_FRAMES) {
      let sum = 0
      for (let i = start; i < end; i++) sum += strength[i]
      out.push({
        start: Math.max(0, start * hopSeconds + timeOffset - hopSeconds / 2),
        end: end * hopSeconds + timeOffset - hopSeconds / 2,
        midi: Math.round(median(values) * 100) / 100,
        conf: Math.round(Math.min(1, sum / (end - start)) * 100) / 100,
      })
    }
  }

  for (let i = from + 1; i < to; i++) {
    // Vibrato oscila em torno do centro; só vira outra nota se o desvio se mantiver.
    if (Math.abs(midi[i] - center) > NOTE_SPLIT_SEMITONES) {
      drift++
      if (drift >= 3) {
        const splitAt = i - drift + 1
        values.length = Math.max(1, values.length - (drift - 1))
        close(splitAt)
        start = splitAt
        values = []
        for (let k = splitAt; k <= i; k++) values.push(midi[k])
        center = median(values)
        drift = 0
        continue
      }
    } else {
      drift = 0
    }
    values.push(midi[i])
    if (values.length <= 12 || values.length % 4 === 0) center = median(values)
  }
  close(to)
}

function mergeNotes(notes: RefNote[], hopSeconds: number): RefNote[] {
  const merged: RefNote[] = []
  for (const note of notes) {
    const last = merged[merged.length - 1]
    if (last && last.midi !== null && note.midi !== null && note.start - last.end <= hopSeconds * 2 && Math.abs(note.midi - last.midi) < 0.5) {
      const a = last.end - last.start
      const b = note.end - note.start
      last.midi = Math.round(((last.midi * a + note.midi * b) / (a + b)) * 100) / 100
      last.conf = Math.round(((last.conf * a + note.conf * b) / (a + b)) * 100) / 100
      last.end = note.end
    } else {
      merged.push({ ...note })
    }
  }
  return merged
}

/** Envelope de amplitude em `buckets` pontos, normalizado em 0..1. */
export function envelope(left: Float32Array, right: Float32Array | null, buckets: number): Float32Array {
  const out = new Float32Array(buckets)
  const size = left.length / buckets
  if (size < 1) return out
  // Amostrar 1 a cada `stride` basta para um desenho e evita varrer o arquivo inteiro.
  const stride = Math.max(1, Math.floor(size / 400))
  let max = 0
  for (let b = 0; b < buckets; b++) {
    const from = Math.floor(b * size)
    const to = Math.min(left.length, Math.floor((b + 1) * size))
    let sum = 0
    let count = 0
    for (let i = from; i < to; i += stride) {
      const v = right ? (left[i] + right[i]) * 0.5 : left[i]
      sum += v * v
      count++
    }
    out[b] = count > 0 ? Math.sqrt(sum / count) : 0
    if (out[b] > max) max = out[b]
  }
  if (max > 0) for (let b = 0; b < buckets; b++) out[b] /= max
  return out
}
