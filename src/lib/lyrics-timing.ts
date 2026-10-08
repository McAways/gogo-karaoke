import type { LyricLine, LyricWord } from './types'

const VOWEL_GROUPS = /[aeiouyáàâãäåéèêëíìîïóòôõöúùûüœæ]+/gi
const CJK = /[぀-ヿ㐀-鿿가-힯]/

/** Conta grupos de vogais. Não é silabação de verdade, mas basta para distribuir o tempo. */
export function syllableCount(word: string): number {
  const groups = word.match(VOWEL_GROUPS)
  return Math.max(1, groups ? groups.length : 0)
}

interface Token {
  text: string
  glue: boolean
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = []
  for (const chunk of text.trim().split(/\s+/)) {
    if (!chunk) continue
    // Idiomas sem espaço entre palavras: cada caractere vira uma unidade de preenchimento.
    if (chunk.length > 1 && CJK.test(chunk)) {
      Array.from(chunk).forEach((char, i) => tokens.push({ text: char, glue: i > 0 }))
    } else {
      tokens.push({ text: chunk, glue: false })
    }
  }
  return tokens
}

/**
 * Espalha as palavras de uma linha entre `start` e `end`, com peso por sílaba.
 * Letras sincronizadas por linha não trazem o tempo de cada palavra, então este é
 * o melhor palpite: palavras longas duram mais e pontuação vira uma pequena pausa.
 */
export function distributeWords(text: string, start: number, end: number): LyricWord[] {
  const tokens = tokenize(text)
  if (tokens.length === 0) return []

  const span = Math.max(0.2, end - start)
  // Sobra um respiro no fim: quase ninguém canta até o instante exato da próxima linha.
  const tail = Math.min(0.8, Math.max(0.08, span * 0.1))
  const usable = span - tail

  const weights = tokens.map((t) => (t.glue ? 1 : syllableCount(t.text) + 0.35))
  const pauses: number[] = tokens.map((t, i) => (i < tokens.length - 1 && /[,.;:!?…]$/.test(t.text) ? 0.6 : 0))
  const total = weights.reduce((a, b) => a + b, 0) + pauses.reduce((a, b) => a + b, 0)
  const unit = usable / total

  const words: LyricWord[] = []
  let cursor = start
  tokens.forEach((token, i) => {
    const length = weights[i] * unit
    words.push({ text: token.text, start: cursor, end: cursor + length, ...(token.glue ? { glue: true } : {}) })
    cursor += length + pauses[i] * unit
  })
  return words
}

/** Duração provável de uma linha cantada, usada quando a fonte não diz onde a linha termina. */
export function estimateLineDuration(text: string): number {
  const syllables = tokenize(text).reduce((sum, t) => sum + (t.glue ? 1 : syllableCount(t.text)), 0)
  return Math.min(12, Math.max(1.6, 0.32 * syllables + 0.9))
}

export interface TimedText {
  time: number
  text: string
  words?: Array<{ time: number; text: string }>
}

/**
 * Converte marcações "tempo + texto" em linhas com início, fim e palavras.
 * Entradas com texto vazio marcam o fim da linha anterior (pausa instrumental).
 */
export function buildLines(entries: TimedText[], duration?: number): LyricLine[] {
  const sorted = [...entries].sort((a, b) => a.time - b.time)
  const lines: LyricLine[] = []

  sorted.forEach((entry, i) => {
    const text = entry.text.trim()
    if (!text) return

    const next = sorted[i + 1]
    const estimate = estimateLineDuration(text)
    const limit = next ? next.time : duration && duration > entry.time ? duration : entry.time + estimate
    let end: number
    if (next && !next.text.trim()) end = next.time
    else if (limit - entry.time <= estimate * 1.6) end = limit
    else end = entry.time + estimate
    end = Math.max(end, entry.time + 0.3)

    let words: LyricWord[]
    if (entry.words && entry.words.length > 0) {
      const timed = entry.words.filter((w) => w.text.trim())
      words = timed.map((w, k) => ({
        text: w.text.trim(),
        start: w.time,
        end: Math.max(w.time + 0.05, k < timed.length - 1 ? timed[k + 1].time : end),
        // Marca de palavra colada na anterior (sem espaço no texto original) é uma sílaba.
        ...(k > 0 && !/^\s/.test(w.text) && !/\s$/.test(timed[k - 1].text) ? { glue: true } : {}),
      }))
    } else {
      words = distributeWords(text, entry.time, end)
    }

    lines.push({ start: entry.time, end, text, words })
  })

  return lines
}

/** Texto de uma linha a partir das palavras, respeitando sílabas coladas. */
export function joinWords(words: LyricWord[]): string {
  return words.map((w, i) => (i > 0 && !w.glue ? ' ' : '') + w.text).join('')
}

/** Índice da linha ativa em `t`, ou da última que já começou. -1 antes da primeira. */
export function lineIndexAt(lines: LyricLine[], t: number): number {
  let lo = 0
  let hi = lines.length - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (lines[mid].start <= t) {
      found = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return found
}
