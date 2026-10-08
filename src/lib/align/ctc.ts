/**
 * Sincronia da letra pelo áudio (alinhamento forçado por CTC).
 *
 * Um modelo acústico ouve a voz e diz, quadro a quadro (50 por segundo), a probabilidade de
 * cada letra. Aqui entra só a parte de encaixar o texto nisso: programação dinâmica pura,
 * sem modelo nem áudio. É o que responde "em que instante cada palavra é cantada".
 *
 * Este arquivo não importa nada de propósito: é usado pelo app, pelos testes e pelo
 * ajudante, que roda no Node sem compilar.
 */

/** Vocabulário do modelo: caractere para índice da coluna. */
export type Vocab = Record<string, number>

const FOLD: Record<string, string> = { ß: 'ss', æ: 'ae', œ: 'oe', ø: 'o', đ: 'd', ł: 'l', þ: 'th', ð: 'd' }

/** Reduz uma palavra ao que o modelo conhece: letras sem acento e apóstrofo. */
export function romanize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[ßæœøđłþð]/g, (c) => FOLD[c])
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[’‘`´]/g, "'")
    .replace(/[^a-z']/g, '')
    .replace(/^'+|'+$/g, '')
}

export interface TokenPlan {
  /** Índice de coluna de cada letra, na ordem do texto. */
  ids: Int32Array
  /** A que palavra pertence cada letra. */
  wordOf: Int32Array
  /** A que linha pertence cada letra. */
  lineOf: Int32Array
  /** Total de palavras, contando as que ficaram sem letra nenhuma (números, símbolos). */
  words: number
}

/** `lines` traz as palavras de cada linha da letra, na ordem em que são cantadas. */
export function planTokens(lines: ReadonlyArray<readonly string[]>, vocab: Vocab): TokenPlan {
  const ids: number[] = []
  const wordOf: number[] = []
  const lineOf: number[] = []
  let word = 0
  lines.forEach((line, index) => {
    for (const text of line) {
      for (const char of romanize(text)) {
        const id = vocab[char]
        if (id === undefined) continue
        ids.push(id)
        wordOf.push(word)
        lineOf.push(index)
      }
      word++
    }
  })
  return { ids: Int32Array.from(ids), wordOf: Int32Array.from(wordOf), lineOf: Int32Array.from(lineOf), words: word }
}

/** Quadros [start, end) em que uma letra foi encaixada, e o quanto o modelo concordou (0 a 1). */
export interface TokenSpan {
  start: number
  end: number
  score: number
}

export interface AlignOptions {
  /**
   * Custo, por quadro, do silêncio no meio de uma linha. Uma linha é uma frase: as letras dela
   * ficam perto umas das outras. Sem isso, letra que o modelo não ouviu direito vai parar longe,
   * no meio do trecho instrumental vizinho. Entre uma linha e outra o silêncio não custa nada.
   */
  gapPenalty?: number
  /**
   * Faixa de quadros em que se espera que cada linha comece (um par por linha; NaN = livre).
   * Começar fora dela custa `expectedRate` por quadro, até `expectedCap`.
   */
  expectedLo?: ArrayLike<number>
  expectedHi?: ArrayLike<number>
  expectedRate?: number
  expectedCap?: number
  /**
   * Piso do log da probabilidade de uma letra. O modelo às vezes tem certeza absoluta de que uma
   * letra NÃO está num quadro; sem piso, essa certeza pesa mais do que tudo e arrasta linhas
   * inteiras para onde o som é só menos improvável. Com piso, onde a letra não foi ouvida o
   * custo é o mesmo em todo lugar, e quem decide são as outras regras.
   */
  floor?: number
}

const NEG = -1e30

/**
 * Melhor encaixe do texto no áudio (Viterbi sobre a treliça do CTC).
 *
 * `logProbs` tem `frames * classes` valores: log da probabilidade de cada coluna em cada quadro.
 * Devolve null quando não há como encaixar (mais letras do que quadros).
 */
export function forcedAlign(
  logProbs: Float32Array,
  frames: number,
  classes: number,
  plan: Pick<TokenPlan, 'ids' | 'lineOf'>,
  blank: number,
  options: AlignOptions = {},
): TokenSpan[] | null {
  const { ids, lineOf } = plan
  const count = ids.length
  if (count === 0 || frames < count) return null
  const gapPenalty = options.gapPenalty ?? 0
  const { expectedLo, expectedHi } = options
  const rate = options.expectedRate ?? 0.5
  const cap = options.expectedCap ?? 200
  const floor = options.floor ?? Math.log(1e-3)

  // Estados: branco, letra 0, branco, letra 1, ... , branco.
  const states = 2 * count + 1
  // Custo extra do branco: só quando ele está entre duas letras da mesma linha.
  const blankCost = new Float32Array(states)
  // Linha que cada estado abre (para o custo de começar fora do esperado). -1 nos demais.
  const opens = new Int32Array(states).fill(-1)
  for (let k = 0; k < count; k++) {
    if (k === 0 || lineOf[k] !== lineOf[k - 1]) opens[2 * k + 1] = lineOf[k]
    else blankCost[2 * k] = gapPenalty
  }
  const entryCost = (line: number, t: number): number => {
    if (!expectedLo || !expectedHi) return 0
    const lo = expectedLo[line]
    const hi = expectedHi[line]
    if (Number.isNaN(lo) || Number.isNaN(hi)) return 0
    const off = t < lo ? lo - t : t > hi ? t - hi : 0
    return Math.min(cap, off * rate)
  }

  let prev = new Float64Array(states).fill(NEG)
  let cur = new Float64Array(states)
  // Para cada célula, de quantos estados atrás veio o melhor caminho (0, 1 ou 2).
  const back = new Uint8Array(frames * states)

  prev[0] = logProbs[blank]
  prev[1] = Math.max(floor, logProbs[ids[0]]) - entryCost(lineOf[0], 0)

  for (let t = 1; t < frames; t++) {
    const row = t * classes
    const base = t * states
    // Só vale a faixa de estados aonde já deu para chegar e de onde ainda dá para terminar.
    const lo = Math.max(0, states - 2 * (frames - t))
    const hi = Math.min(states - 1, 2 * t + 1)
    cur.fill(NEG)
    const blankLp = logProbs[row + blank]

    for (let s = lo; s <= hi; s++) {
      if (s & 1) {
        const k = s >> 1
        // Chegada vinda de outro estado: do branco anterior ou, entre letras diferentes, direto da letra anterior.
        let enter = prev[s - 1]
        let move = 1
        if (s > 1 && ids[k] !== ids[k - 1] && prev[s - 2] > enter) {
          enter = prev[s - 2]
          move = 2
        }
        // Começar a linha fora do esperado custa. Continuar nela, não.
        if (opens[s] >= 0) enter -= entryCost(opens[s], t)
        if (prev[s] >= enter) {
          enter = prev[s]
          move = 0
        }
        const lp = logProbs[row + ids[k]]
        cur[s] = enter + (lp > floor ? lp : floor)
        back[base + s] = move
      } else {
        let best = prev[s]
        let move = 0
        if (s > 0 && prev[s - 1] > best) {
          best = prev[s - 1]
          move = 1
        }
        cur[s] = best + blankLp - blankCost[s]
        back[base + s] = move
      }
    }
    const swap = prev
    prev = cur
    cur = swap
  }

  let state = prev[states - 1] >= prev[states - 2] ? states - 1 : states - 2
  if (prev[state] <= NEG / 2) return null

  const spans: TokenSpan[] = Array.from({ length: count }, () => ({ start: -1, end: -1, score: 0 }))
  const hits = new Int32Array(count)
  for (let t = frames - 1; t >= 0; t--) {
    if (state & 1) {
      const k = state >> 1
      const span = spans[k]
      span.start = t
      if (span.end < 0) span.end = t + 1
      span.score += Math.exp(logProbs[t * classes + ids[k]])
      hits[k]++
    }
    state -= back[t * states + state]
  }
  for (let k = 0; k < count; k++) {
    if (hits[k] === 0) return null
    spans[k].score /= hits[k]
  }
  return spans
}

// ---------- da letra inteira aos tempos de cada linha e palavra ----------

export interface LineInput {
  /** As palavras da linha, como aparecem na tela. */
  words: string[]
  /** Início da linha na sincronia de referência (a feita à mão), em segundos. null = não há. */
  reference?: number | null
}

export interface AlignedWord {
  start: number
  end: number
  /** 0 a 1: o quanto o modelo ouviu as letras desta palavra. */
  score: number
}

export interface AlignedLine {
  start: number
  end: number
  /** 0 a 1: o quanto o modelo ouviu esta linha. */
  score: number
  /**
   * Tempo de cada palavra. null quando o modelo não ouviu a linha (voz com muito efeito, por
   * exemplo): o início da linha vale, mas quem usa distribui as palavras por conta própria.
   */
  words: AlignedWord[] | null
  /** true quando a linha foi posta pelo horário da referência, não pelo som. */
  tied: boolean
}

export interface AlignOutcome {
  lines: AlignedLine[]
  /** Média do quanto o modelo ouviu, linha a linha. */
  score: number
  /** Fração das linhas que o modelo ouviu de fato. */
  heard: number
  /** Linhas ouvidas com clareza, que serviram de âncora. */
  anchors: number
  /** Linhas postas pelo horário da referência. */
  tied: number
  /** Linhas pouco ouvidas, mas que estão onde a referência (corrigida pelas âncoras) diz. */
  confirmed: number
}

export interface AlignSettings {
  /** Segundos por quadro do modelo. */
  frameSeconds: number
  /** Um valor por quadro: 1 onde há voz. Serve para esticar a palavra enquanto a nota é segurada. */
  voiced?: Uint8Array | null
}

/** A partir daqui a linha foi ouvida com clareza: fica livre e serve de âncora para as vizinhas. */
const ANCHOR_SCORE = 0.25
/** Abaixo disto o modelo não ouviu a linha: sem outra confirmação, o tempo de cada palavra não é confiável. */
export const HEARD_SCORE = 0.08
/** Nem com a referência confirmando o lugar: abaixo disto as letras foram postas no escuro. */
const FAINT_SCORE = 0.02
/**
 * Tempo mínimo plausível por sílaba cantada (s). Letras que o modelo não ouviu ficam amontoadas
 * em volta das que ele ouviu; uma linha que "dura" menos que isto está amontoada, não cantada.
 */
const MIN_SYLLABLE = 0.16
const GAP_PENALTY = 0.03
/** Uma linha fora disto (s) do que as âncoras vizinhas indicam está solta, e é presa à referência. */
const CONSISTENT = 1
/** Folga (s) em volta do esperado para uma linha presa. */
const TIE_SLACK = 0.5
/** O quanto uma palavra pode ser esticada (s) além do fim ouvido, enquanto houver voz. */
const MAX_HOLD = 4
const MIN_WORD = 0.06

const median = (values: number[]): number => [...values].sort((a, b) => a - b)[values.length >> 1]

/** Conta de sílabas pelo número de grupos de vogais. Basta para saber se uma duração é plausível. */
function syllables(words: readonly string[]): number {
  let total = 0
  for (const word of words) total += romanize(word).match(/[aeiouy]+/g)?.length ?? 0
  return total
}

interface RawLine {
  first: number
  count: number
  start: number
  end: number
  score: number
  timed: boolean
}

function gatherLines(input: readonly LineInput[], words: ReadonlyArray<AlignedWord | null>): RawLine[] {
  let cursor = 0
  return input.map((line) => {
    const first = cursor
    cursor += line.words.length
    let start = NaN
    let end = NaN
    let total = 0
    let timed = 0
    for (let w = first; w < cursor; w++) {
      const word = words[w]
      if (!word) continue
      if (timed === 0) start = word.start
      end = word.end
      total += word.score
      timed++
    }
    return { first, count: line.words.length, start, end, score: timed > 0 ? total / timed : 0, timed: timed > 0 }
  })
}

function toWords(spans: readonly TokenSpan[], plan: TokenPlan, frameSeconds: number): Array<AlignedWord | null> {
  const out: Array<AlignedWord | null> = new Array<AlignedWord | null>(plan.words).fill(null)
  const counts = new Int32Array(plan.words)
  for (let k = 0; k < spans.length; k++) {
    const w = plan.wordOf[k]
    const span = spans[k]
    const entry = out[w]
    if (!entry) out[w] = { start: span.start * frameSeconds, end: span.end * frameSeconds, score: span.score }
    else {
      entry.end = span.end * frameSeconds
      entry.score += span.score
    }
    counts[w]++
  }
  for (let w = 0; w < plan.words; w++) {
    const entry = out[w]
    if (entry) entry.score /= counts[w]
  }
  return out
}

/**
 * Sincroniza a letra inteira.
 *
 * 1. Encaixa o texto no som, sem saber nada além do texto.
 * 2. Se há uma sincronia de referência, as linhas ouvidas com clareza viram âncoras: a diferença
 *    entre o som e a referência nelas diz onde procurar as linhas que o modelo não ouviu. Só
 *    essas são presas à referência; o resto fica onde o som mandou. A diferença é medida perto
 *    de cada linha, então uma pausa a mais no meio do vídeo não atrapalha.
 */
export function alignLines(
  logProbs: Float32Array,
  frames: number,
  classes: number,
  vocab: Vocab,
  blank: number,
  input: readonly LineInput[],
  settings: AlignSettings,
): AlignOutcome | null {
  const { frameSeconds } = settings
  const plan = planTokens(
    input.map((line) => line.words),
    vocab,
  )
  let spans = forcedAlign(logProbs, frames, classes, plan, blank, { gapPenalty: GAP_PENALTY })
  if (!spans) return null
  let words = toWords(spans, plan, frameSeconds)
  let lines = gatherLines(input, words)
  const tied = new Uint8Array(input.length)
  // Linhas que as âncoras vizinhas confirmam: estão onde a referência, corrigida, diz que deviam estar.
  const confirmed = new Uint8Array(input.length)

  const ref = (i: number): number | null => {
    const value = input[i].reference
    return value === null || value === undefined || Number.isNaN(value) ? null : value
  }
  const anchors: number[] = []
  lines.forEach((line, i) => {
    if (line.timed && line.score >= ANCHOR_SCORE && ref(i) !== null) anchors.push(i)
  })

  if (anchors.length >= 3) {
    const delta = (i: number): number => lines[i].start - ref(i)!
    const expectedLo = new Float64Array(input.length).fill(NaN)
    const expectedHi = new Float64Array(input.length).fill(NaN)
    let any = false
    let cursor = 0
    for (let i = 0; i < input.length; i++) {
      while (cursor < anchors.length && anchors[cursor] <= i) cursor++
      const reference = ref(i)
      const line = lines[i]
      if (reference === null || !line.timed || line.score >= ANCHOR_SCORE) continue
      // Diferença entre som e referência nas âncoras logo antes e logo depois desta linha.
      const before = anchors.slice(Math.max(0, cursor - 3), cursor).filter((a) => a < i)
      const after = anchors.slice(cursor, cursor + 3)
      const sides: number[] = []
      if (before.length > 0) sides.push(median(before.map(delta)))
      if (after.length > 0) sides.push(median(after.map(delta)))
      if (sides.length === 0) continue
      const lo = reference + Math.min(...sides)
      const hi = reference + Math.max(...sides)
      // Já está onde as vizinhas indicam (de um lado ou do outro de uma pausa): fica livre.
      if (line.start >= lo - CONSISTENT && line.start <= hi + CONSISTENT) {
        confirmed[i] = 1
        continue
      }
      expectedLo[i] = (lo - TIE_SLACK) / frameSeconds
      expectedHi[i] = (hi + TIE_SLACK) / frameSeconds
      tied[i] = 1
      any = true
    }
    if (any) {
      const again = forcedAlign(logProbs, frames, classes, plan, blank, { gapPenalty: GAP_PENALTY, expectedLo, expectedHi })
      if (again) {
        spans = again
        words = toWords(spans, plan, frameSeconds)
        lines = gatherLines(input, words)
      }
    }
  }

  // Linhas sem letra nenhuma (só símbolos): ficam logo depois da anterior.
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].timed) continue
    const previous = i > 0 ? lines[i - 1].end : 0
    lines[i].start = previous
    lines[i].end = previous
  }

  const voiced = settings.voiced ?? null
  const out: AlignedLine[] = lines.map((line, i) => {
    // O tempo de cada palavra só vale quando o modelo ouviu a linha, ou quando ouviu pouco mas a
    // referência confirma o lugar. E nunca quando as letras ficaram amontoadas num instante.
    // As letras de uma sílaba saem quase juntas, no começo dela: o que se mede é do início da primeira
    // sílaba ao início da última, daí o "menos um".
    const spread = line.end - line.start >= MIN_SYLLABLE * Math.max(0, syllables(input[i].words) - 1)
    const heard = line.timed && spread && tied[i] === 0 && (line.score >= HEARD_SCORE || (confirmed[i] === 1 && line.score >= FAINT_SCORE))
    const nextStart = i + 1 < lines.length ? lines[i + 1].start : Infinity
    if (!heard) return { start: line.start, end: Math.max(line.start, Math.min(line.end, nextStart)), score: line.score, words: null, tied: tied[i] === 1 }

    const list: AlignedWord[] = []
    for (let w = 0; w < line.count; w++) {
      const word = words[line.first + w]
      // Palavra sem letra (número, símbolo): ocupa o instante entre as vizinhas.
      if (!word) {
        const at = list.length > 0 ? list[list.length - 1].end : line.start
        list.push({ start: at, end: at, score: 0 })
        continue
      }
      list.push({ start: word.start, end: word.end, score: word.score })
    }
    for (let w = 0; w < list.length; w++) {
      const word = list[w]
      const limit = w + 1 < list.length ? list[w + 1].start : nextStart
      let end = Math.max(word.end, word.start + MIN_WORD)
      // Nota segurada: a palavra continua enquanto houver voz.
      if (voiced) {
        const stop = Math.min(limit, word.end + MAX_HOLD)
        let frame = Math.round(end / frameSeconds)
        while (frame < voiced.length && voiced[frame] && frame * frameSeconds < stop) frame++
        end = Math.max(end, Math.min(stop, frame * frameSeconds))
      }
      // Palavras praticamente emendadas: o destaque passa de uma para a outra sem buraco.
      if (limit - end < 0.25) end = limit
      word.end = Math.max(word.start, Math.min(end, limit))
    }
    return { start: list[0].start, end: Math.max(list[list.length - 1].end, list[0].start), score: line.score, words: list, tied: tied[i] === 1 }
  })

  const timedLines = lines.filter((line) => line.timed)
  return {
    lines: out,
    score: timedLines.length > 0 ? timedLines.reduce((sum, line) => sum + line.score, 0) / timedLines.length : 0,
    heard: timedLines.length > 0 ? timedLines.filter((line) => line.score >= HEARD_SCORE).length / timedLines.length : 0,
    anchors: anchors.length,
    tied: tied.reduce((sum, flag) => sum + flag, 0),
    confirmed: confirmed.reduce((sum, flag) => sum + flag, 0),
  }
}
