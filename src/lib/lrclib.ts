import { lrcToLines, parseLrc } from './lrc'
import { distributeWords } from './lyrics-timing'
import { normalize, similarity } from './titles'
import type { LyricLine, LyricsDoc } from './types'

/**
 * LRCLIB (https://lrclib.net): banco aberto de letras sincronizadas, sem chave de API
 * e com CORS liberado, então o navegador fala com ele direto.
 */
const API = 'https://lrclib.net/api'
const CLIENT = 'Gogo Karaoke 0.1 (uso pessoal)'

export interface LrclibRecord {
  id: number
  trackName: string
  artistName: string
  albumName: string | null
  duration: number
  instrumental: boolean
  hasWordSync?: boolean
  plainLyrics: string | null
  syncedLyrics: string | null
  /** YAML com tempos por linha e, quando `hasWordSync`, por palavra. */
  lyricsfile?: string | null
}

export class LrclibError extends Error {}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Tempo máximo de uma busca inteira (com as novas tentativas). O banco às vezes simplesmente não responde. */
const SEARCH_DEADLINE_MS = 25_000

/** Junta o cancelamento de quem chamou com o prazo da busca. */
function withDeadline(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const deadline = AbortSignal.timeout(ms)
  return signal ? AbortSignal.any([signal, deadline]) : deadline
}

/** O serviço responde 503 "ServerOverloaded" com retry-after quando está cheio: tenta de novo. */
async function request(path: string, params: Record<string, string>, signal?: AbortSignal): Promise<Response> {
  const url = `${API}${path}?${new URLSearchParams(params)}`
  let lastStatus = 0
  for (let attempt = 0; attempt < 4; attempt++) {
    let res: Response
    try {
      res = await fetch(url, { signal, headers: { 'Lrclib-Client': CLIENT } })
    } catch (err) {
      // TimeoutError = o prazo da busca estourou. AbortError = quem chamou desistiu.
      if (err instanceof DOMException && err.name === 'TimeoutError') throw new LrclibError('O banco de letras não respondeu a tempo.')
      if (signal?.aborted) throw err
      throw new LrclibError('Sem conexão com o banco de letras.')
    }
    if (res.status !== 503 && res.status !== 429) return res
    lastStatus = res.status
    const retryAfter = Number(res.headers.get('retry-after'))
    await wait(Math.min(8000, (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 800) * (attempt + 1)))
  }
  throw new LrclibError(`O banco de letras está sobrecarregado (HTTP ${lastStatus}). Tente de novo em instantes.`)
}

async function searchOnce(params: Record<string, string>, signal?: AbortSignal): Promise<LrclibRecord[]> {
  const res = await request('/search', params, signal)
  if (!res.ok) throw new LrclibError(`O banco de letras respondeu com erro (HTTP ${res.status}).`)
  const data: unknown = await res.json()
  return Array.isArray(data) ? (data as LrclibRecord[]) : []
}

export interface LyricsQuery {
  title: string
  artist: string
  duration: number
}

export interface LyricsMatch {
  record: LrclibRecord
  score: number
  /** Segundos de diferença entre a duração cadastrada da letra e a do arquivo da música. */
  durationDelta: number
  synced: boolean
  /** Instante do primeiro verso, em segundos. null sem sincronia. */
  firstVerse: number | null
  /** Segundos de música que sobram depois que o último verso começa. Negativo = a letra passa do fim. */
  tail: number | null
  /**
   * Ids de todos os registros do resultado com exatamente os mesmos tempos.
   * O banco tem muitas cópias da mesma sincronia cadastradas em álbuns diferentes.
   */
  sameTiming: number[]
}

interface Timing {
  key: string
  first: number
  last: number
}

function timingOf(record: LrclibRecord): Timing | null {
  if (!record.syncedLyrics) return null
  const verses = parseLrc(record.syncedLyrics).entries.filter((entry) => entry.text.trim())
  if (verses.length === 0) return null
  return { key: verses.map((v) => v.time.toFixed(1)).join(','), first: verses[0].time, last: verses[verses.length - 1].time }
}

/**
 * Ordena os registros de uma busca, do mais provável para o menos.
 *
 * Regra número um: letra sincronizada vem sempre antes de letra só de texto.
 * Entre as sincronizadas, a duração cadastrada ajuda mas não manda: o banco tem a
 * mesma sincronia copiada em faixas de durações bem diferentes. Por isso entram
 * também o que a própria letra diz (o último verso precisa caber na gravação) e
 * quantas cópias daquela sincronia existem (a mais repetida costuma ser a do álbum).
 */
export function rankRecords(records: LrclibRecord[], query: LyricsQuery): LyricsMatch[] {
  const usable = records.filter((r) => !r.instrumental && (r.syncedLyrics || r.plainLyrics))
  const timings = new Map<number, Timing | null>(usable.map((r) => [r.id, timingOf(r)]))

  const groups = new Map<string, number[]>()
  for (const record of usable) {
    const timing = timings.get(record.id)
    if (timing) groups.set(timing.key, [...(groups.get(timing.key) ?? []), record.id])
  }

  const matches = usable.map((record): LyricsMatch => {
    const timing = timings.get(record.id) ?? null
    const synced = timing !== null
    const durationDelta = Math.abs(record.duration - query.duration)
    const sameTiming = timing ? groups.get(timing.key) ?? [record.id] : [record.id]
    const tail = timing && query.duration > 0 ? query.duration - timing.last : null

    let score = 0
    if (record.hasWordSync) score += 15

    if (query.duration > 0) {
      if (durationDelta <= 2) score += 40
      else if (durationDelta <= 5) score += 25
      else if (durationDelta <= 10) score += 8
      else score -= durationDelta > 30 ? 40 : 20
    }

    if (tail !== null) {
      // O último verso começa depois (ou quase no fim) do áudio: a letra é de uma versão mais longa.
      if (tail < 0) score -= 60
      else if (tail < 3) score -= 20
    }
    score += Math.min(12, 3 * (sameTiming.length - 1))

    score += similarity(record.trackName, query.title) * 30
    if (query.artist) score += similarity(record.artistName, query.artist) * 20
    // Registros que repetem "Artista - Música" em todos os campos costumam ser envios de baixa qualidade.
    if (normalize(record.trackName) === normalize(record.artistName)) score -= 10

    return { record, score, durationDelta, synced, firstVerse: timing?.first ?? null, tail, sameTiming }
  })

  return matches.sort((a, b) => Number(b.synced) - Number(a.synced) || b.score - a.score)
}

/** Busca por artista e título e, se não vier letra sincronizada, tenta de novo com buscas mais abertas. */
export async function searchLyrics(query: LyricsQuery, outerSignal?: AbortSignal): Promise<LyricsMatch[]> {
  const signal = withDeadline(outerSignal, SEARCH_DEADLINE_MS)
  const seen = new Map<number, LrclibRecord>()
  const collect = (records: LrclibRecord[]) => {
    for (const record of records) seen.set(record.id, record)
  }

  const title = query.title.trim()
  const artist = query.artist.trim()
  if (!title) return []

  if (artist) collect(await searchOnce({ track_name: title, artist_name: artist }, signal))
  const hasSynced = () => [...seen.values()].some((r) => r.syncedLyrics && !r.instrumental)
  if (!hasSynced()) collect(await searchOnce({ q: `${artist} ${title}`.trim() }, signal))
  if (!hasSynced() && artist) collect(await searchOnce({ q: title }, signal))

  return rankRecords([...seen.values()], query)
}

/**
 * Tira as cópias: fica o melhor registro de cada sincronia distinta, seguido das
 * letras só de texto. É o que a tela de escolha mostra.
 */
export function distinctMatches(matches: LyricsMatch[]): LyricsMatch[] {
  const seen = new Set<number>()
  return matches.filter((match) => {
    if (!match.synced) return true
    if (seen.has(match.record.id)) return false
    for (const id of match.sameTiming) seen.add(id)
    return true
  })
}

/**
 * exata = há letra sincronizada com a duração do vídeo.
 * outra = há letra sincronizada, mas de outra versão da música (duração diferente).
 * texto = só há a letra em texto, sem tempos.
 */
export type LyricsAvailability = 'exata' | 'outra' | 'texto'

/**
 * Para a tela de busca: que vídeos têm letra, e de que tipo.
 *
 * Duração igual (até 2 s) à de uma letra sincronizada é um bom sinal de que a sincronia vai
 * encaixar sem ajuste. Letra sincronizada de outra duração tende a sair do tempo. Letra só em
 * texto precisa da sincronia pelo áudio. Vídeo fora do mapa não tem letra conhecida.
 */
export async function lyricsAvailability(
  query: string,
  videos: Array<{ id: string; title: string; duration: number }>,
  outerSignal?: AbortSignal,
): Promise<Map<string, LyricsAvailability>> {
  const records = (await searchOnce({ q: query }, withDeadline(outerSignal, SEARCH_DEADLINE_MS))).filter((r) => !r.instrumental && (r.syncedLyrics || r.plainLyrics))
  const found = new Map<string, LyricsAvailability>()
  for (const video of videos) {
    const title = normalize(video.title)
    const same = records.filter((r) => {
      const track = normalize(r.trackName)
      return track.length >= 3 && title.includes(track)
    })
    const synced = same.filter((r) => r.syncedLyrics)
    if (synced.some((r) => Math.abs(r.duration - video.duration) <= 2)) found.set(video.id, 'exata')
    else if (synced.length > 0) found.set(video.id, 'outra')
    else if (same.length > 0) found.set(video.id, 'texto')
  }
  return found
}

/** Letra só de texto cujo nome bate com o da música: serve quando a sincronia vai sair do áudio. */
export function isPlausiblePlain(match: LyricsMatch, query: LyricsQuery): boolean {
  return !match.synced && !!match.record.plainLyrics && similarity(match.record.trackName, query.title) >= 0.5
}

/** Sincronizada, com nome parecido, duração próxima e último verso cabendo na gravação. */
export function isConfidentMatch(match: LyricsMatch, query: LyricsQuery): boolean {
  if (!match.synced || similarity(match.record.trackName, query.title) < 0.5) return false
  if (query.duration <= 0) return true
  return match.durationDelta <= 8 && (match.tail === null || match.tail >= 3)
}

export interface AutomaticChoice {
  match: LyricsMatch
  /** false = é a melhor sincronizada disponível, mas pode ser de outra versão da música. */
  confident: boolean
}

/**
 * A letra que o app aplica sozinho. Sempre uma sincronizada: primeiro a melhor que
 * passa nos critérios de confiança; se nenhuma passar, a melhor sincronizada cujo
 * nome ao menos lembra o da música. Letra só de texto nunca é aplicada sozinha.
 */
export function pickAutomatic(matches: LyricsMatch[], query: LyricsQuery): AutomaticChoice | null {
  const synced = matches.filter((m) => m.synced)
  const confident = synced.find((m) => isConfidentMatch(m, query))
  if (confident) return { match: confident, confident: true }

  const fallback = synced.find((m) => similarity(m.record.trackName, query.title) >= 0.3 && (m.tail === null || m.tail >= 0))
  return fallback ? { match: fallback, confident: false } : null
}

interface LyricsfileWord {
  text?: unknown
  start_ms?: unknown
  end_ms?: unknown
}

interface LyricsfileLine {
  text?: unknown
  start_ms?: unknown
  end_ms?: unknown
  words?: LyricsfileWord[]
}

/**
 * Lê o formato "lyricsfile" da LRCLIB quando ele traz tempos por palavra.
 * O parser de YAML só é carregado nesse caso, que ainda é raro no banco.
 */
async function wordSyncedLines(lyricsfile: string): Promise<LyricLine[] | null> {
  const { parse } = await import('yaml')
  const doc = parse(lyricsfile) as { lines?: LyricsfileLine[] } | null
  if (!doc?.lines?.length) return null

  const lines: LyricLine[] = []
  let anyWordTimes = false
  for (const raw of doc.lines) {
    const text = typeof raw.text === 'string' ? raw.text.trim() : ''
    const start = Number(raw.start_ms) / 1000
    if (!text || !Number.isFinite(start)) continue
    const end = Number.isFinite(Number(raw.end_ms)) ? Number(raw.end_ms) / 1000 : start + 3

    const timed = (raw.words ?? []).filter((w) => typeof w.text === 'string' && w.text.trim() && Number.isFinite(Number(w.start_ms)))
    if (timed.length > 0) anyWordTimes = true
    const words =
      timed.length > 0
        ? timed.map((w, i) => {
            const wordStart = Number(w.start_ms) / 1000
            const next = timed[i + 1]
            const wordEnd = Number.isFinite(Number(w.end_ms)) ? Number(w.end_ms) / 1000 : next ? Number(next.start_ms) / 1000 : end
            return { text: String(w.text).trim(), start: wordStart, end: Math.max(wordStart + 0.05, wordEnd) }
          })
        : distributeWords(text, start, end)
    lines.push({ start, end: Math.max(end, start + 0.3), text, words })
  }
  return anyWordTimes ? lines : null
}

export async function recordToDoc(record: LrclibRecord, songId: string, duration: number): Promise<LyricsDoc | null> {
  const base = { songId, source: 'lrclib' as const, lrclibId: record.id, updatedAt: Date.now() }

  if (record.hasWordSync && record.lyricsfile) {
    try {
      const lines = await wordSyncedLines(record.lyricsfile)
      if (lines && lines.length > 0) return { ...base, lines, level: 'word' }
    } catch {
      // Formato inesperado: segue com a sincronia por linha.
    }
  }
  if (record.syncedLyrics) {
    const { lines, hasWordTimes } = lrcToLines(record.syncedLyrics, duration)
    if (lines.length > 0) return { ...base, lines, level: hasWordTimes ? 'word' : 'line' }
  }
  if (record.plainLyrics?.trim()) return { ...base, lines: [], plain: record.plainLyrics.trim(), level: 'plain' }
  return null
}
