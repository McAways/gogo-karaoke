import { joinWords } from './lyrics-timing'
import type { LyricLine, LyricWord, RefNote } from './types'

export interface UltraStarSong {
  title?: string
  artist?: string
  lines: LyricLine[]
  notes: RefNote[]
}

const NOTE = /^([:*FRG])\s+(-?\d+)\s+(\d+)\s+(-?\d+)(?:\s(.*))?$/
const BREAK = /^-\s*(-?\d+)(?:\s+(-?\d+))?/

function numberOf(raw: string | undefined): number {
  return raw ? Number(raw.replace(',', '.')) : NaN
}

/**
 * Lê arquivos .txt do UltraStar. É o melhor formato para karaoke com pontuação:
 * traz o tempo e a nota de cada sílaba, anotados à mão.
 *
 * Duetos: só a voz 1 (P1) é usada.
 */
export function parseUltraStar(source: string): UltraStarSong {
  const header: Record<string, string> = {}
  const lines: LyricLine[] = []
  const notes: RefNote[] = []

  let beatSeconds = 0
  let gap = 0
  let relative = false
  let relativeBase = 0
  let skipping = false
  let current: LyricWord[] = []
  let previousEndedWord = true

  const flush = () => {
    if (current.length === 0) return
    lines.push({ start: current[0].start, end: current[current.length - 1].end, text: joinWords(current), words: current })
    current = []
    previousEndedWord = true
  }

  for (const rawLine of source.replace(/^﻿/, '').split(/\r?\n/)) {
    // Espaço no fim de uma sílaba significa "fim da palavra", então só tabs e \r saem.
    const line = rawLine.replace(/[\t\r]+$/, '')

    if (line.startsWith('#')) {
      const colon = line.indexOf(':')
      if (colon > 1) header[line.slice(1, colon).trim().toUpperCase()] = line.slice(colon + 1).trim()
      continue
    }

    if (beatSeconds === 0) {
      const bpm = numberOf(header.BPM)
      if (!Number.isFinite(bpm) || bpm <= 0) continue
      // O BPM do UltraStar conta quartos de batida.
      beatSeconds = 60 / (bpm * 4)
      gap = (numberOf(header.GAP) || 0) / 1000
      relative = /^yes$/i.test(header.RELATIVE ?? '')
    }

    const trimmed = line.trimStart()
    if (/^P\s?\d/i.test(trimmed)) {
      skipping = !/^P\s?[13]/i.test(trimmed)
      flush()
      relativeBase = 0
      continue
    }
    if (trimmed === 'E' || trimmed.startsWith('E ')) break
    if (skipping) continue

    const lineBreak = BREAK.exec(trimmed)
    if (lineBreak) {
      flush()
      if (relative) relativeBase += Number(lineBreak[2] ?? lineBreak[1])
      continue
    }

    const note = NOTE.exec(trimmed)
    if (!note) continue

    const [, type, startBeat, lengthBeats, pitch] = note
    const rawText = note[5] ?? ''
    const start = gap + (relativeBase + Number(startBeat)) * beatSeconds
    const end = start + Math.max(1, Number(lengthBeats)) * beatSeconds

    // Freestyle (F) não é pontuado. Rap (R, G) conta só a presença da voz.
    if (type !== 'F') {
      notes.push({ start, end, midi: type === ':' || type === '*' ? 60 + Number(pitch) : null, conf: 1 })
    }

    const text = rawText.replace(/~/g, '')
    if (!text.trim()) {
      // "~" prolonga a sílaba anterior em outra nota.
      if (current.length > 0) current[current.length - 1].end = end
      continue
    }

    const startsWord = previousEndedWord || /^\s/.test(text)
    current.push({ text: text.trim(), start, end, ...(startsWord || current.length === 0 ? {} : { glue: true }) })
    previousEndedWord = /\s$/.test(text)
  }
  flush()

  return { title: header.TITLE, artist: header.ARTIST, lines, notes }
}

export function looksLikeUltraStar(source: string): boolean {
  return /^#BPM:/im.test(source) && /^[:*FRG]\s+-?\d+\s+\d+\s+-?\d+/m.test(source)
}
