import { describe, expect, it } from 'vitest'
import { formatLrcTime } from './lrc'
import { distinctMatches, isConfidentMatch, pickAutomatic, rankRecords } from './lrclib'
import type { LrclibRecord } from './lrclib'

let nextId = 1

/** Letra sincronizada com um verso a cada `step` segundos, de `first` a `last`. */
function synced(first: number, last: number, step = 5): string {
  const lines: string[] = []
  for (let t = first; t <= last + 1e-9; t += step) lines.push(`[${formatLrcTime(t)}]verso aos ${t}`)
  return lines.join('\n')
}

function record(fields: Partial<LrclibRecord>): LrclibRecord {
  return {
    id: nextId++,
    trackName: 'Evidências',
    artistName: 'Chitãozinho & Xororó',
    albumName: null,
    duration: 280,
    instrumental: false,
    plainLyrics: 'texto da letra',
    syncedLyrics: null,
    ...fields,
  }
}

const query = { title: 'Evidências', artist: 'Chitãozinho & Xororó', duration: 280 }

describe('escolha da letra', () => {
  it('põe letra sincronizada sempre antes de letra só de texto', () => {
    // O registro de texto tem tudo a favor (nome e duração exatos); o sincronizado, duração bem diferente.
    const plain = record({ duration: 280 })
    const withTimes = record({ duration: 320, syncedLyrics: synced(20, 250) })
    const ranked = rankRecords([plain, withTimes], query)
    expect(ranked.map((m) => m.synced)).toEqual([true, false])
    expect(ranked[0].record.id).toBe(withTimes.id)
  })

  it('aplica sozinha a sincronizada, nunca a de texto', () => {
    const plain = record({ duration: 280 })
    const withTimes = record({ duration: 281, syncedLyrics: synced(20, 250) })
    const choice = pickAutomatic(rankRecords([plain, withTimes], query), query)
    expect(choice?.match.record.id).toBe(withTimes.id)
    expect(choice?.confident).toBe(true)

    expect(pickAutomatic(rankRecords([plain], query), query)).toBeNull()
  })

  it('rebaixa a letra cujo último verso não cabe na gravação', () => {
    // A duração cadastrada bate, mas o último verso começa depois do fim do áudio.
    const tooLong = record({ duration: 280, syncedLyrics: synced(20, 290) })
    const fits = record({ duration: 286, syncedLyrics: synced(12, 255) })
    const ranked = rankRecords([tooLong, fits], query)
    expect(ranked[0].record.id).toBe(fits.id)
    expect(ranked[1].tail).toBeLessThan(0)
    expect(isConfidentMatch(ranked[1], query)).toBe(false)
    expect(isConfidentMatch(ranked[0], query)).toBe(true)
  })

  it('prefere a sincronia que mais se repete no banco e mostra uma linha por sincronia', () => {
    const common = synced(24, 250)
    const rare = synced(12, 240)
    const records = [
      record({ duration: 282, syncedLyrics: rare, albumName: 'Regravação' }),
      ...['Álbum', 'Coletânea', 'Ao Vivo', 'Millennium'].map((albumName) => record({ duration: 282, syncedLyrics: common, albumName })),
      record({ duration: 280 }),
    ]
    const ranked = rankRecords(records, query)
    expect(ranked[0].sameTiming).toHaveLength(4)
    expect(ranked[0].firstVerse).toBe(24)

    const distinct = distinctMatches(ranked)
    expect(distinct.map((m) => (m.synced ? m.sameTiming.length : 0))).toEqual([4, 1, 0])
    expect(distinct[1].firstVerse).toBe(12)
  })

  it('sem candidata confiável, usa a melhor sincronizada e avisa que pode ser outra versão', () => {
    const otherVersion = record({ duration: 330, syncedLyrics: synced(30, 260) })
    const choice = pickAutomatic(rankRecords([otherVersion, record({ duration: 280 })], query), query)
    expect(choice?.match.record.id).toBe(otherVersion.id)
    expect(choice?.confident).toBe(false)
  })

  it('não aplica letra de outra música nem faixa instrumental', () => {
    const otherSong = record({ trackName: 'Fio de Cabelo', syncedLyrics: synced(10, 200) })
    expect(pickAutomatic(rankRecords([otherSong], query), query)).toBeNull()

    const instrumental = record({ instrumental: true, syncedLyrics: synced(10, 200) })
    expect(rankRecords([instrumental], query)).toHaveLength(0)
  })

  it('sem saber a duração do arquivo, vale só o nome', () => {
    const unknown = { ...query, duration: 0 }
    const ranked = rankRecords([record({ duration: 500, syncedLyrics: synced(20, 250) })], unknown)
    expect(ranked[0].tail).toBeNull()
    expect(isConfidentMatch(ranked[0], unknown)).toBe(true)
  })
})
