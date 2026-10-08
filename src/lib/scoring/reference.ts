import type { LyricLine, RefNote } from '../types'

/** Fatia de tempo que o cantor precisa acertar. É a unidade da pontuação. */
export interface ScoreSlot {
  t0: number
  t1: number
  /** null = basta estar cantando (linha sem guia de melodia, ou rap). */
  midi: number | null
  line: number
  weight: number
}

export interface ScoreLine {
  start: number
  end: number
  firstSlot: number
  /** Exclusivo. */
  lastSlot: number
  mode: 'melodia' | 'presenca'
}

/** Nota desenhada na pista de tom, já recortada à linha a que pertence. */
export interface LaneNote {
  start: number
  end: number
  midi: number
  conf: number
  line: number
}

export interface ScoreReference {
  slots: ScoreSlot[]
  lines: ScoreLine[]
  laneNotes: LaneNote[]
  /** nenhum = a música não tem letra sincronizada nem guia: não dá para pontuar. */
  mode: 'melodia' | 'presenca' | 'nenhum'
  /** Fração das linhas pontuadas pelo tom, de 0 a 1. */
  melodyShare: number
}

const SLOT_SECONDS = 0.05
/** O guia pode começar um pouco antes ou depois do tempo marcado na letra. */
const LINE_MARGIN = 0.25
/** Abaixo disso o guia cobre pouco da linha e ela é pontuada só por presença. */
const MIN_MELODY_COVERAGE = 0.25
const PRESENCE_WEIGHT = 0.6
/** Sem letra, notas separadas por mais que isso viram frases diferentes. */
const PHRASE_GAP = 1.5

function pushSlots(slots: ScoreSlot[], from: number, to: number, midi: number | null, line: number, weightPerSecond: number): void {
  const duration = to - from
  if (duration <= 0.01) return
  const count = Math.max(1, Math.round(duration / SLOT_SECONDS))
  const step = duration / count
  for (let i = 0; i < count; i++) {
    slots.push({ t0: from + i * step, t1: from + (i + 1) * step, midi, line, weight: step * weightPerSecond })
  }
}

function noteWeight(note: RefNote): number {
  // Notas em que o guia confia pouco contam menos, mas nunca chegam a zero.
  return 0.35 + 0.65 * note.conf
}

/**
 * Cruza a letra com o guia de melodia e decide o que será cobrado do cantor.
 *
 * Cada linha vira "melodia" (compara o tom) quando o guia cobre uma parte razoável
 * dela, ou "presença" (basta cantar no tempo) quando não cobre.
 */
export function buildReference(lyricLines: LyricLine[], notes: RefNote[]): ScoreReference {
  const sortedNotes = [...notes].sort((a, b) => a.start - b.start)
  const slots: ScoreSlot[] = []
  const lines: ScoreLine[] = []
  const laneNotes: LaneNote[] = []

  if (lyricLines.length === 0) {
    // Sem letra sincronizada: as próprias notas definem as frases.
    let firstSlot = 0
    let phraseStart = 0
    sortedNotes.forEach((note, i) => {
      const next = sortedNotes[i + 1]
      if (i === 0) phraseStart = note.start
      pushSlots(slots, note.start, note.end, note.midi, lines.length, note.midi === null ? PRESENCE_WEIGHT : noteWeight(note))
      if (note.midi !== null) laneNotes.push({ start: note.start, end: note.end, midi: note.midi, conf: note.conf, line: lines.length })
      if (!next || next.start - note.end > PHRASE_GAP) {
        lines.push({ start: phraseStart, end: note.end, firstSlot, lastSlot: slots.length, mode: 'melodia' })
        firstSlot = slots.length
        if (next) phraseStart = next.start
      }
    })
    return finish(slots, lines, laneNotes)
  }

  let cursor = 0
  lyricLines.forEach((line, index) => {
    const prev = lyricLines[index - 1]
    const next = lyricLines[index + 1]
    // A margem nunca invade a linha vizinha: para no meio do intervalo entre as duas.
    const from = Math.max(line.start - LINE_MARGIN, prev ? (prev.end + line.start) / 2 : -Infinity)
    const to = Math.min(line.end + LINE_MARGIN, next ? (line.end + next.start) / 2 : Infinity)

    while (cursor < sortedNotes.length && sortedNotes[cursor].end <= from) cursor++
    const inLine: RefNote[] = []
    for (let i = cursor; i < sortedNotes.length && sortedNotes[i].start < to; i++) {
      const note = sortedNotes[i]
      const start = Math.max(note.start, from)
      const end = Math.min(note.end, to)
      if (end - start > 0.04) inLine.push({ ...note, start, end })
    }

    const covered = inLine.reduce((sum, n) => sum + (n.end - n.start), 0)
    const firstSlot = slots.length
    const useMelody = covered >= Math.max(0.2, (line.end - line.start) * MIN_MELODY_COVERAGE)

    if (useMelody) {
      for (const note of inLine) {
        pushSlots(slots, note.start, note.end, note.midi, index, note.midi === null ? PRESENCE_WEIGHT : noteWeight(note))
        if (note.midi !== null) laneNotes.push({ start: note.start, end: note.end, midi: note.midi, conf: note.conf, line: index })
      }
    } else if (line.words.length > 0) {
      for (const word of line.words) pushSlots(slots, word.start, word.end, null, index, PRESENCE_WEIGHT)
    } else {
      pushSlots(slots, line.start, line.end, null, index, PRESENCE_WEIGHT)
    }

    lines.push({ start: line.start, end: line.end, firstSlot, lastSlot: slots.length, mode: useMelody ? 'melodia' : 'presenca' })
  })

  return finish(slots, lines, laneNotes)
}

function finish(slots: ScoreSlot[], lines: ScoreLine[], laneNotes: LaneNote[]): ScoreReference {
  const scored = lines.filter((l) => l.lastSlot > l.firstSlot)
  const melodic = scored.filter((l) => l.mode === 'melodia').length
  return {
    slots,
    lines,
    laneNotes,
    mode: scored.length === 0 ? 'nenhum' : melodic > 0 ? 'melodia' : 'presenca',
    melodyShare: scored.length > 0 ? melodic / scored.length : 0,
  }
}
