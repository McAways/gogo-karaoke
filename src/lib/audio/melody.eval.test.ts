// Medição em gravações reais com melodia anotada (ADC2004 e MIREX05).
//
// Só roda com MELODY_EVAL_DIRS apontando para as pastas dos conjuntos, separadas por ";":
//   http://labrosa.ee.columbia.edu/projects/melody/adc2004_full_set.zip
//   http://labrosa.ee.columbia.edu/projects/melody/mirex05TrainFiles.zip
// MELODY_SWEEP=1 compara variações dos parâmetros em vez de detalhar arquivo por arquivo.
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_TUNING, analyzeMelody } from './melody'
import type { MelodyTuning } from './melody'

const dirs = (process.env.MELODY_EVAL_DIRS ?? '').split(';').filter(Boolean)
const sweep = process.env.MELODY_SWEEP === '1'

function readWav(file: string): { channels: Float32Array[]; sampleRate: number } {
  const buf = readFileSync(file)
  let offset = 12
  let sampleRate = 44100
  let numChannels = 1
  let bits = 16
  while (offset < buf.length - 8) {
    const id = buf.toString('ascii', offset, offset + 4)
    const size = buf.readUInt32LE(offset + 4)
    if (id === 'fmt ') {
      numChannels = buf.readUInt16LE(offset + 10)
      sampleRate = buf.readUInt32LE(offset + 12)
      bits = buf.readUInt16LE(offset + 22)
    } else if (id === 'data') {
      const frames = Math.floor(size / (numChannels * (bits / 8)))
      const channels = Array.from({ length: numChannels }, () => new Float32Array(frames))
      for (let i = 0; i < frames; i++)
        for (let c = 0; c < numChannels; c++) channels[c][i] = buf.readInt16LE(offset + 8 + (i * numChannels + c) * 2) / 32768
      return { channels, sampleRate }
    }
    offset += 8 + size + (size % 2)
  }
  throw new Error(`WAV sem dados: ${file}`)
}

/** Reduz 44,1 kHz para 22,05 kHz com um passa-baixa simples antes de descartar amostras. */
function halve(x: Float32Array): Float32Array {
  const taps = 31
  const h = new Float64Array(taps)
  let sum = 0
  for (let i = 0; i < taps; i++) {
    const n = i - (taps - 1) / 2
    const sinc = n === 0 ? 0.5 : Math.sin(Math.PI * 0.5 * n) / (Math.PI * n)
    h[i] = sinc * (0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (taps - 1)))
    sum += h[i]
  }
  for (let i = 0; i < taps; i++) h[i] /= sum
  const out = new Float32Array(Math.floor(x.length / 2))
  for (let o = 0; o < out.length; o++) {
    let acc = 0
    for (let k = 0; k < taps; k++) {
      const idx = o * 2 + k - (taps - 1) / 2
      if (idx >= 0 && idx < x.length) acc += h[k] * x[idx]
    }
    out[o] = acc
  }
  return out
}

function hzToMidi(hz: number): number {
  return 69 + 12 * Math.log2(hz / 440)
}

function chromaDiff(a: number, b: number): number {
  return ((((a - b) % 12) + 18) % 12) - 6
}

const KEYS = ['voiced', 'rpa', 'rca', 'noteAny', 'note10', 'note15', 'note20', 'unvoiced', 'falseAlarm'] as const
type Stats = Record<(typeof KEYS)[number], number>
const emptyStats = (): Stats => Object.fromEntries(KEYS.map((k) => [k, 0])) as Stats

interface Excerpt {
  name: string
  vocal: boolean
  left: Float32Array
  right: Float32Array | null
  sampleRate: number
  ref: number[][]
}

function load(): Excerpt[] {
  const excerpts: Excerpt[] = []
  for (const dir of dirs) {
    for (const name of readdirSync(dir).filter((n) => n.endsWith('.wav')).sort()) {
      const ref = readFileSync(path.join(dir, name.replace(/(MIDI)?\.wav$/, 'REF.txt')), 'utf8')
        .split(/\r?\n/)
        .map((l) => l.trim().split(/\s+/).map(Number))
        .filter((r) => r.length >= 2 && Number.isFinite(r[0]) && Number.isFinite(r[1]))
      const wav = readWav(path.join(dir, name))
      let left = wav.channels[0]
      let right: Float32Array | null = wav.channels[1] ?? null
      let sampleRate = wav.sampleRate
      if (sampleRate === 44100) {
        left = halve(left)
        right = right ? halve(right) : null
        sampleRate = 22050
      }
      // "midi" e "jazz" do ADC2004 têm melodia instrumental; o resto é voz cantada.
      excerpts.push({ name, vocal: !/^(midi|jazz)|MIDI/.test(name), left, right, sampleRate, ref })
    }
  }
  return excerpts
}

/** Quanto do que é cantado o guia cobre, e quanto do que ele cobre está na nota certa. */
function measure(excerpt: Excerpt, tuning: MelodyTuning, byConf?: Array<{ frames: number; hits: number }>) {
  const a = analyzeMelody(excerpt.left, excerpt.right, excerpt.sampleRate, undefined, tuning)
  const s = emptyStats()
  let noteIdx = 0
  for (const [t, hz] of excerpt.ref) {
    const f = Math.round((t - a.contourStart) / a.hopSeconds)
    const est = f >= 0 && f < a.contour.length ? a.contour[f] : 0
    while (noteIdx < a.notes.length && a.notes[noteIdx].end < t) noteIdx++
    const note = noteIdx < a.notes.length && a.notes[noteIdx].start <= t ? a.notes[noteIdx] : null
    if (hz > 0) {
      const truth = hzToMidi(hz)
      s.voiced++
      if (est > 0) {
        if (Math.abs(est - truth) <= 0.5) s.rpa++
        if (Math.abs(chromaDiff(est, truth)) <= 0.5) s.rca++
      }
      if (note && note.midi !== null) {
        s.noteAny++
        const d = Math.abs(chromaDiff(note.midi, truth))
        if (d <= 1.0) s.note10++
        if (d <= 1.5) s.note15++
        if (d <= 2.0) s.note20++
        if (byConf) {
          const bucket = byConf[Math.min(byConf.length - 1, Math.floor(note.conf * byConf.length))]
          bucket.frames++
          if (d <= 1.0) bucket.hits++
        }
      }
    } else {
      s.unvoiced++
      if (est > 0) s.falseAlarm++
    }
  }
  return { stats: s, notes: a.notes.length }
}

const pct = (n: number, d: number) => (d ? ((100 * n) / d).toFixed(1).padStart(5) : '    -')

function summary(s: Stats): string {
  return `RCA ${pct(s.rca, s.voiced)} | cobre ${pct(s.noteAny, s.voiced)} | certo ±1.0 ${pct(s.note10, s.noteAny)}  ±1.5 ${pct(s.note15, s.noteAny)}  ±2.0 ${pct(s.note20, s.noteAny)} | acerto total ±1.0 ${pct(s.note10, s.voiced)}`
}

describe.skipIf(dirs.length === 0)('melodia em gravações reais', () => {
  it.skipIf(sweep)('detalha arquivo por arquivo', { timeout: 300_000 }, () => {
    const rows: string[] = []
    const all = emptyStats()
    const vocal = emptyStats()
    const byConf = Array.from({ length: 5 }, () => ({ frames: 0, hits: 0 }))

    for (const excerpt of load()) {
      const { stats, notes } = measure(excerpt, DEFAULT_TUNING, excerpt.vocal ? byConf : undefined)
      for (const k of KEYS) {
        all[k] += stats[k]
        if (excerpt.vocal) vocal[k] += stats[k]
      }
      rows.push(`${excerpt.name.padEnd(16)} ${summary(stats)} | alarme falso ${pct(stats.falseAlarm, stats.unvoiced)} | ${notes} notas`)
    }
    rows.push(`${'TOTAL'.padEnd(16)} ${summary(all)}`, `${'SÓ VOZ'.padEnd(16)} ${summary(vocal)}`)
    rows.push('', 'Acerto (±1.0) por confiança da nota, só voz:')
    byConf.forEach((b, i) => rows.push(`  conf ${(i / 5).toFixed(1)}-${((i + 1) / 5).toFixed(1)}: ${pct(b.hits, b.frames)}  (${b.frames} quadros)`))
    console.log(`\n${rows.join('\n')}\n`)
    expect(all.voiced).toBeGreaterThan(0)
  })

  it.skipIf(!sweep)('compara variações dos parâmetros', { timeout: 1_800_000 }, () => {
    const excerpts = load()
    const variants: Array<[string, Partial<MelodyTuning>]> = [
      ["padrão", {}],
      ["A h10 d.9 v.30", {"harmonics":10,"harmonicDecay":0.9,"voicingThreshold":0.3}],
      ["B h12 d.9 v.30", {"harmonics":12,"harmonicDecay":0.9,"voicingThreshold":0.3}],
      ["C h12 d.85 v.30", {"harmonics":12,"harmonicDecay":0.85,"voicingThreshold":0.3}],
      ["D h10 d.9 v.25", {"harmonics":10,"harmonicDecay":0.9,"voicingThreshold":0.25}],
      ["E h10 d.9 v.20", {"harmonics":10,"harmonicDecay":0.9,"voicingThreshold":0.2}],
      ["F h12 d.95 v.30", {"harmonics":12,"harmonicDecay":0.95,"voicingThreshold":0.3}],
      ["G A+switch.5", {"harmonics":10,"harmonicDecay":0.9,"voicingThreshold":0.3,"switchCost":0.5}],
      ["H A+jump.03", {"harmonics":10,"harmonicDecay":0.9,"voicingThreshold":0.3,"jumpCost":0.03}],
      ["I B+v.25", {"harmonics":12,"harmonicDecay":0.9,"voicingThreshold":0.25}],
    ]
    const rows = variants.map(([label, patch]) => {
      const vocal = emptyStats()
      for (const excerpt of excerpts) {
        if (!excerpt.vocal) continue
        const { stats } = measure(excerpt, { ...DEFAULT_TUNING, ...patch })
        for (const k of KEYS) vocal[k] += stats[k]
      }
      return `${label.padEnd(14)} ${summary(vocal)}`
    })
    console.log(`\nSó trechos com voz cantada:\n${rows.join('\n')}\n`)
    expect(rows.length).toBe(variants.length)
  })
})
