import { buildLines } from './lyrics-timing'
import type { TimedText } from './lyrics-timing'
import type { LyricLine } from './types'

const TAG = /^\[([^\]]*)\]/
const TIME = /^(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?$/
const WORD_TAG = /<(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?>/g

function toSeconds(min: string, sec: string, frac?: string): number {
  const fraction = frac ? Number(`0.${frac}`) : 0
  return Number(min) * 60 + Number(sec) + fraction
}

export interface ParsedLrc {
  entries: TimedText[]
  meta: Record<string, string>
  /** true quando o arquivo traz marcações por palavra (LRC "enhanced"). */
  hasWordTimes: boolean
}

/**
 * Lê LRC simples e "enhanced" (marcas <mm:ss.xx> por palavra).
 * Aceita vários tempos na mesma linha e a tag [offset:±ms].
 */
export function parseLrc(source: string): ParsedLrc {
  const entries: TimedText[] = []
  const meta: Record<string, string> = {}
  let hasWordTimes = false

  for (const rawLine of source.replace(/^﻿/, '').split(/\r?\n/)) {
    let rest = rawLine.trim()
    const times: number[] = []

    for (let match = TAG.exec(rest); match; match = TAG.exec(rest)) {
      const body = match[1].trim()
      const time = TIME.exec(body)
      if (time) {
        times.push(toSeconds(time[1], time[2], time[3]))
      } else {
        const colon = body.indexOf(':')
        if (colon > 0) meta[body.slice(0, colon).trim().toLowerCase()] = body.slice(colon + 1).trim()
      }
      rest = rest.slice(match[0].length).trimStart()
    }
    if (times.length === 0) continue

    let words: TimedText['words']
    let text = rest
    if (WORD_TAG.test(rest)) {
      hasWordTimes = true
      words = []
      WORD_TAG.lastIndex = 0
      let cursor = 0
      let pendingTime = times[0]
      for (let m = WORD_TAG.exec(rest); m; m = WORD_TAG.exec(rest)) {
        const chunk = rest.slice(cursor, m.index)
        if (chunk.trim()) words.push({ time: pendingTime, text: chunk })
        pendingTime = toSeconds(m[1], m[2], m[3])
        cursor = m.index + m[0].length
      }
      const last = rest.slice(cursor)
      if (last.trim()) words.push({ time: pendingTime, text: last })
      text = words.map((w) => w.text).join('').replace(/\s+/g, ' ')
    }
    WORD_TAG.lastIndex = 0

    times.forEach((time, i) => {
      // Marcas por palavra só valem para a primeira repetição: as outras têm outro tempo base.
      const shifted = i === 0 || !words ? words : undefined
      entries.push({ time, text: text.trim(), ...(shifted ? { words: shifted } : {}) })
    })
  }

  // Convenção do formato: offset positivo adianta a letra.
  const offset = Number(meta.offset)
  if (Number.isFinite(offset) && offset !== 0) {
    for (const entry of entries) {
      entry.time = Math.max(0, entry.time - offset / 1000)
      entry.words?.forEach((w) => (w.time = Math.max(0, w.time - offset / 1000)))
    }
  }

  entries.sort((a, b) => a.time - b.time)
  return { entries, meta, hasWordTimes }
}

export function lrcToLines(source: string, duration?: number): { lines: LyricLine[]; hasWordTimes: boolean } {
  const parsed = parseLrc(source)
  return { lines: buildLines(parsed.entries, duration), hasWordTimes: parsed.hasWordTimes }
}

/** Uma linha LRC por linha da letra. Textos sem tempo ficam de fora. */
export function linesToLrc(lines: LyricLine[]): string {
  return lines.map((line) => `[${formatLrcTime(line.start)}]${line.text}`).join('\n')
}

export function formatLrcTime(seconds: number): string {
  const safe = Math.max(0, seconds)
  const min = Math.floor(safe / 60)
  const sec = safe - min * 60
  return `${String(min).padStart(2, '0')}:${sec.toFixed(2).padStart(5, '0')}`
}

/** Heurística para saber se um texto colado é LRC ou letra corrida. */
export function looksLikeLrc(source: string): boolean {
  return /^\s*\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]/m.test(source)
}
