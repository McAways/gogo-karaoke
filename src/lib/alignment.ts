/**
 * Confere uma letra sincronizada contra o áudio.
 *
 * A letra vem de um banco público onde cada música tem vários registros: versão de
 * estúdio, ao vivo, regravações, clipes com introdução. Duração e nome não bastam
 * para saber qual deles serve para ESTA gravação. O que basta é o próprio áudio:
 * a letra certa tem versos onde há voz.
 *
 * Só funciona com a voz já separada do instrumental. Na mixagem completa o guia de
 * melodia acha "nota" o tempo todo (sempre há um instrumento tocando), e a comparação
 * não distingue nada. Ver "Tentado e descartado" no registro de andamento.
 *
 * Desliza a letra sobre o áudio e, para cada atraso, mede duas coisas: quantos versos
 * começam junto de uma frase cantada, e quanto do tempo de letra tem voz por baixo.
 * O atraso que maximiza as duas é o encaixe.
 */

export interface Span {
  start: number
  end: number
}

export interface Alignment {
  /** Segundos a somar aos tempos da letra para ela encaixar no áudio. */
  offset: number
  /** Correlação entre "há verso" e "há voz" no melhor encaixe, de -1 a 1. */
  score: number
  /** Quanto o melhor encaixe supera o segundo melhor, de 0 a 1. Perto de 0 = ambíguo. */
  margin: number
  /** Fração do tempo de letra em que há voz, no melhor encaixe. */
  coverage: number
  /** Fração dos versos que começam junto de uma frase cantada, no melhor encaixe. */
  onsets: number
}

export interface AlignOptions {
  /** Maior atraso procurado, para os dois lados, em segundos. */
  maxOffset?: number
}

const STEP = 0.05
const FINE_STEP = 0.02
/** Silêncio mínimo antes de uma nota para ela contar como começo de frase. */
const PHRASE_GAP = 0.3
/** Tolerância (s) entre o começo do verso e o da frase cantada. */
const ONSET_WIDTH = 0.16
/** Um segundo pico só conta como "outro encaixe" se estiver a esta distância (s) do melhor. */
const RIVAL_DISTANCE = 1

function mask(spans: Span[], length: number, shiftBins = 0): Uint8Array {
  const out = new Uint8Array(length)
  for (const span of spans) {
    const from = Math.max(0, Math.round(span.start / STEP) + shiftBins)
    const to = Math.min(length, Math.round(span.end / STEP) + shiftBins)
    for (let i = from; i < to; i++) out[i] = 1
  }
  return out
}

/** Começos de frase: notas que entram depois de um silêncio. */
export function phraseOnsets(notes: Span[]): number[] {
  const sorted = [...notes].sort((a, b) => a.start - b.start)
  const onsets: number[] = []
  let lastEnd = -Infinity
  for (const note of sorted) {
    if (note.start - lastEnd >= PHRASE_GAP) onsets.push(note.start)
    lastEnd = Math.max(lastEnd, note.end)
  }
  return onsets
}

/** null quando não há material para comparar (sem versos ou sem voz). */
export function alignLyrics(lines: Span[], voice: Span[], duration: number, options: AlignOptions = {}): Alignment | null {
  if (lines.length < 3 || voice.length < 3 || duration <= 0) return null

  const maxOffset = options.maxOffset ?? 30
  const maxShift = Math.round(maxOffset / STEP)
  const length = Math.ceil(duration / STEP)
  const voiceMask = mask(voice, length)

  let voiceSum = 0
  for (let i = 0; i < length; i++) voiceSum += voiceMask[i]
  const voiceMean = voiceSum / length
  const voiceVar = voiceMean * (1 - voiceMean)
  if (voiceVar === 0) return null

  // 1. Para cada atraso, quanto de "há verso" coincide com "há voz".
  // A letra é desenhada com folga dos dois lados para poder deslizar sem recalcular.
  const lyric = mask(lines, length + 2 * maxShift, maxShift)
  const correlation = new Float32Array(2 * maxShift + 1)
  const coverage = new Float32Array(2 * maxShift + 1)
  for (let k = -maxShift; k <= maxShift; k++) {
    // Atrasar a letra em k passos = ler a máscara k posições antes.
    const base = maxShift - k
    let lyricSum = 0
    let both = 0
    for (let i = 0; i < length; i++) {
      const l = lyric[base + i]
      lyricSum += l
      both += l & voiceMask[i]
    }
    const index = k + maxShift
    const lyricMean = lyricSum / length
    const lyricVar = lyricMean * (1 - lyricMean)
    correlation[index] = lyricVar > 0 ? (both / length - voiceMean * lyricMean) / Math.sqrt(voiceVar * lyricVar) : -1
    coverage[index] = lyricSum > 0 ? both / lyricSum : 0
  }

  // 2. Para cada atraso, quantos versos começam junto de uma frase cantada. É este o
  // critério que manda: versos seguidos formam um bloco contínuo, e a cobertura sozinha
  // quase não muda quando o bloco desliza um ou dois segundos. Os começos mudam.
  const onsets = phraseOnsets(voice)
  if (onsets.length === 0) return null
  const starts = lines.map((line) => line.start).sort((a, b) => a - b)

  const steps = Math.round((2 * maxOffset) / FINE_STEP) + 1
  const values = new Float32Array(steps)
  const matches = new Float32Array(steps)
  let best = 0
  for (let step = 0; step < steps; step++) {
    const offset = -maxOffset + step * FINE_STEP
    let total = 0
    let cursor = 0
    for (const start of starts) {
      const time = start + offset
      while (cursor < onsets.length - 1 && onsets[cursor + 1] <= time) cursor++
      let nearest = Math.abs(onsets[cursor] - time)
      if (cursor + 1 < onsets.length) nearest = Math.min(nearest, Math.abs(onsets[cursor + 1] - time))
      total += Math.exp(-((nearest / ONSET_WIDTH) ** 2))
    }
    matches[step] = total / starts.length
    // A cobertura entra como peso: descarta atrasos em que os versos caem em trecho instrumental.
    const index = Math.min(coverage.length - 1, Math.max(0, Math.round(offset / STEP) + maxShift))
    values[step] = matches[step] * (0.4 + 0.6 * coverage[index])
    if (values[step] > values[best]) best = step
  }

  const rivalDistance = Math.round(RIVAL_DISTANCE / FINE_STEP)
  let rival = 0
  for (let step = 0; step < steps; step++) {
    if (Math.abs(step - best) >= rivalDistance && values[step] > rival) rival = values[step]
  }

  const offset = -maxOffset + best * FINE_STEP
  const index = Math.min(coverage.length - 1, Math.max(0, Math.round(offset / STEP) + maxShift))
  return {
    offset: Math.round(offset * 100) / 100,
    score: correlation[index],
    margin: values[best] > 0 ? Math.max(0, Math.min(1, (values[best] - rival) / values[best])) : 0,
    coverage: coverage[index],
    onsets: matches[best],
  }
}
