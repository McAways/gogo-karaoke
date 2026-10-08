// Medição do encaixe letra x áudio em gravações reais.
//
// Só roda com ALIGN_EVAL_DIR apontando para uma pasta com, para cada música:
//   <nome>.f32          áudio estéreo intercalado, float 32 bits, 22.050 Hz. Deve ser a faixa de
//                       VOZ já separada (ffmpeg -i voz.wav -ac 2 -ar 22050 -f f32le nome.f32)
//   lyrics-<nome>.json  registros da LRCLIB (id, trackName, artistName, albumName, duration, syncedLyrics)
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { alignLyrics } from './alignment'
import { analyzeMelody } from './audio/melody'
import { lrcToLines } from './lrc'
import { distinctMatches, rankRecords } from './lrclib'
import type { LrclibRecord } from './lrclib'

const dir = process.env.ALIGN_EVAL_DIR ?? ''

function readStereo(file: string): { left: Float32Array; right: Float32Array } {
  const buf = readFileSync(file)
  const frames = Math.floor(buf.length / 8)
  const left = new Float32Array(frames)
  const right = new Float32Array(frames)
  for (let i = 0; i < frames; i++) {
    left[i] = buf.readFloatLE(i * 8)
    right[i] = buf.readFloatLE(i * 8 + 4)
  }
  return { left, right }
}

describe.skipIf(!dir)('encaixe da letra em gravações reais', () => {
  it('compara cada sincronia distinta com cada áudio', { timeout: 600_000 }, () => {
    const rows: string[] = []
    for (const file of readdirSync(dir).filter((n) => n.endsWith('.f32')).sort()) {
      const name = file.replace(/\.f32$/, '')
      const lyricsFile = path.join(dir, `lyrics-${name}.json`)
      if (!existsSync(lyricsFile)) continue

      const { left, right } = readStereo(path.join(dir, file))
      const duration = left.length / 22050
      const analysis = analyzeMelody(left, right, 22050)

      let voiced = 0
      for (const note of analysis.notes) voiced += note.end - note.start
      rows.push(`\n== ${name}: ${duration.toFixed(0)} s, ${analysis.notes.length} notas cobrindo ${((100 * voiced) / duration).toFixed(0)}% do tempo`)

      const records = (JSON.parse(readFileSync(lyricsFile, 'utf8')) as Array<Partial<LrclibRecord>>).map(
        (r): LrclibRecord => ({ id: 0, trackName: '', artistName: '', albumName: null, duration: 0, instrumental: false, plainLyrics: null, syncedLyrics: null, ...r }),
      )
      const query = { title: records[0].trackName, artist: records[0].artistName, duration }
      for (const match of distinctMatches(rankRecords(records, query))) {
        const { lines } = lrcToLines(match.record.syncedLyrics ?? '', duration)
        const a = alignLyrics(lines, analysis.notes, duration)
        rows.push(
          a
            ? `  encaixe ${a.score.toFixed(2)}  margem ${a.margin.toFixed(2)}  atraso ${a.offset.toFixed(2).padStart(7)} s  cobre ${(a.coverage * 100).toFixed(0).padStart(3)}%  inícios ${(a.onsets * 100).toFixed(0).padStart(3)}% | ${String(match.sameTiming.length).padStart(2)} cópias | 1º verso ${(match.firstVerse ?? 0).toFixed(1).padStart(5)} s | cadastro ${Math.round(match.record.duration)} s | ${lines.length} linhas`
            : `  sem material para comparar | ${match.sameTiming.length} cópias`,
        )
      }
    }
    console.log(rows.join('\n'))
    expect(rows.length).toBeGreaterThan(0)
  })
})
