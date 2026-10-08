/**
 * Áudio sintético para testes: uma "voz" com vibrato e formantes sobre um
 * acompanhamento (baixo, acordes abertos no estéreo e ruído de bateria).
 * Como a melodia é conhecida, dá para medir o quanto o extrator acerta.
 */

export interface SynthNote {
  start: number
  end: number
  midi: number
}

export function midiToHz(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12)
}

function formant(hz: number): number {
  const bump = (center: number, width: number, gain: number) => gain * Math.exp(-(((hz - center) / width) ** 2))
  return 0.35 + bump(650, 280, 1.6) + bump(1250, 380, 1.1) + bump(2800, 600, 0.9)
}

/** Voz: 14 harmônicos moldados por formantes, vibrato de 5,5 Hz. */
export function renderVoice(out: Float32Array, sampleRate: number, notes: SynthNote[], gain = 0.25, vibratoSemitones = 0.25): void {
  for (const note of notes) {
    const from = Math.floor(note.start * sampleRate)
    const to = Math.min(out.length, Math.floor(note.end * sampleRate))
    const base = midiToHz(note.midi)
    const edge = Math.floor(0.03 * sampleRate)
    let phase = 0
    for (let i = from; i < to; i++) {
      const t = (i - from) / sampleRate
      const hz = base * 2 ** ((vibratoSemitones * Math.sin(2 * Math.PI * 5.5 * t)) / 12)
      phase += (2 * Math.PI * hz) / sampleRate
      let sample = 0
      for (let h = 1; h <= 14; h++) {
        if (h * hz > sampleRate * 0.45) break
        sample += (formant(h * hz) / h) * Math.sin(h * phase)
      }
      const env = Math.min(1, (i - from) / edge, (to - i) / edge)
      out[i] += gain * 0.5 * env * sample
    }
  }
}

/** Tom simples com poucos harmônicos (baixo, teclado). */
export function renderTone(out: Float32Array, sampleRate: number, notes: SynthNote[], gain: number, harmonics: number[], detuneCents = 0): void {
  for (const note of notes) {
    const from = Math.floor(note.start * sampleRate)
    const to = Math.min(out.length, Math.floor(note.end * sampleRate))
    const hz = midiToHz(note.midi + detuneCents / 100)
    const edge = Math.floor(0.02 * sampleRate)
    for (let i = from; i < to; i++) {
      const t = (i - from) / sampleRate
      let sample = 0
      harmonics.forEach((amp, k) => (sample += amp * Math.sin(2 * Math.PI * hz * (k + 1) * t)))
      out[i] += gain * Math.min(1, (i - from) / edge, (to - i) / edge) * sample
    }
  }
}

/** Ruído determinístico em rajadas curtas, para imitar caixa e chimbal. */
export function renderNoiseHits(out: Float32Array, sampleRate: number, everySeconds: number, gain: number): void {
  let seed = 1234567
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 0xffffffff - 0.5
  }
  const length = Math.floor(0.08 * sampleRate)
  for (let start = 0; start < out.length; start += Math.floor(everySeconds * sampleRate)) {
    for (let i = 0; i < length && start + i < out.length; i++) out[start + i] += gain * 2 * random() * Math.exp((-6 * i) / length)
  }
}

export interface SynthSong {
  left: Float32Array
  right: Float32Array
  sampleRate: number
  melody: SynthNote[]
}

const DEFAULT_MELODY = [57, 60, 62, 64, 62, 60, 57, 55, 57, 60, 64, 65, 64, 62, 60, 59, 57, 62]

/** Monta uma "música" de teste. `voiceGain: 0` gera só o acompanhamento. */
export function renderSong(options: { sampleRate?: number; melody?: number[]; noteSeconds?: number; voiceGain?: number; start?: number } = {}): SynthSong {
  const sampleRate = options.sampleRate ?? 22050
  const pitches = options.melody ?? DEFAULT_MELODY
  const noteSeconds = options.noteSeconds ?? 0.5
  const startAt = options.start ?? 0.6

  const melody: SynthNote[] = pitches.map((midi, i) => ({
    midi,
    start: startAt + i * (noteSeconds + 0.1),
    end: startAt + i * (noteSeconds + 0.1) + noteSeconds,
  }))
  const total = melody[melody.length - 1].end + 0.8
  const samples = Math.floor(total * sampleRate)
  const left = new Float32Array(samples)
  const right = new Float32Array(samples)
  const center = new Float32Array(samples)

  renderVoice(center, sampleRate, melody, options.voiceGain ?? 0.25)

  const bars = Math.ceil(total / 2)
  const bassLine = [45, 41, 43, 40]
  const bass: SynthNote[] = Array.from({ length: bars }, (_, i) => ({ midi: bassLine[i % 4], start: i * 2, end: i * 2 + 1.9 }))
  renderTone(center, sampleRate, bass, 0.16, [1, 0.5, 0.25])
  renderNoiseHits(center, sampleRate, 0.5, 0.05)

  // Acordes abertos: cada lado toca vozes diferentes, como um teclado em estéreo.
  const chords = [
    [69, 72, 76],
    [65, 69, 72],
    [67, 71, 74],
    [64, 68, 71],
  ]
  for (let i = 0; i < bars; i++) {
    const chord = chords[i % 4]
    const span = { start: i * 2, end: i * 2 + 1.9 }
    renderTone(left, sampleRate, [{ midi: chord[0], ...span }, { midi: chord[2], ...span }], 0.07, [1, 0.6, 0.4, 0.2], -7)
    renderTone(right, sampleRate, [{ midi: chord[1], ...span }, { midi: chord[2] - 12, ...span }], 0.07, [1, 0.6, 0.4, 0.2], 9)
  }

  for (let i = 0; i < samples; i++) {
    left[i] += center[i]
    right[i] += center[i]
  }
  return { left, right, sampleRate, melody }
}

/** Grava PCM 16 bits em WAV. Aceita 1 ou 2 canais. */
export function encodeWav(channels: Float32Array[], sampleRate: number): Uint8Array {
  const frames = channels[0].length
  const blockAlign = channels.length * 2
  const buffer = new ArrayBuffer(44 + frames * blockAlign)
  const view = new DataView(buffer)
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
  }

  ascii(0, 'RIFF')
  view.setUint32(4, 36 + frames * blockAlign, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channels.length, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * blockAlign, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, 16, true)
  ascii(36, 'data')
  view.setUint32(40, frames * blockAlign, true)

  let offset = 44
  for (let i = 0; i < frames; i++) {
    for (const channel of channels) {
      const clipped = Math.max(-1, Math.min(1, channel[i]))
      view.setInt16(offset, Math.round(clipped * 32767), true)
      offset += 2
    }
  }
  return new Uint8Array(buffer)
}
