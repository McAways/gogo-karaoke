import { lrcToLines, parseLrc } from './lrc'
import { distributeWords } from './lyrics-timing'
import { artistParts, coreTitle, firstArtist, isFiller, isVersionWord, normalize, parseVideoTitle, searchText, titleHead, tokens, versionMarks } from './titles'
import type { LyricLine, LyricsDoc, Song } from './types'

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

/** Tempo máximo de um pedido (com as novas tentativas). O banco às vezes simplesmente não responde. */
const REQUEST_DEADLINE_MS = 25_000
/** Depois disto a busca em degraus não abre pedido novo e fica com o que já achou. */
const SEARCH_BUDGET_MS = 60_000

/** Intervalo entre um pedido e o seguinte, e a espera antes de repetir um que voltou "ocupado". Os testes zeram. */
export const pacing = { gapMs: 250, retryMs: 800 }

let line: Promise<unknown> = Promise.resolve()

/** O banco responde "ocupado" a pedidos em rajada: eles saem um de cada vez, com um respiro entre um e outro. */
function inLine<T>(task: () => Promise<T>): Promise<T> {
  const run = line.then(task)
  const rest = () => wait(pacing.gapMs)
  line = run.then(rest, rest)
  return run
}

/** Junta o cancelamento de quem chamou com o prazo do pedido. */
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
      // TimeoutError = o prazo do pedido estourou. AbortError = quem chamou desistiu.
      if (err instanceof DOMException && err.name === 'TimeoutError') throw new LrclibError('O banco de letras não respondeu a tempo.')
      if (signal?.aborted) throw err
      throw new LrclibError('Sem conexão com o banco de letras.')
    }
    if (res.status !== 503 && res.status !== 429) return res
    lastStatus = res.status
    const retryAfter = Number(res.headers.get('retry-after'))
    await wait(Math.min(8000, (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : pacing.retryMs) * (attempt + 1)))
  }
  throw new LrclibError(`O banco de letras está sobrecarregado (HTTP ${lastStatus}). Tente de novo em instantes.`)
}

function searchOnce(params: Record<string, string>, outerSignal?: AbortSignal): Promise<LrclibRecord[]> {
  return inLine(async () => {
    // Quem desistiu enquanto esperava a vez não gasta um pedido.
    outerSignal?.throwIfAborted()
    const res = await request('/search', params, withDeadline(outerSignal, REQUEST_DEADLINE_MS))
    if (!res.ok) throw new LrclibError(`O banco de letras respondeu com erro (HTTP ${res.status}).`)
    const data: unknown = await res.json()
    return Array.isArray(data) ? (data as LrclibRecord[]) : []
  })
}

/** O que se sabe da música na hora de procurar a letra. */
export interface LyricsQuery {
  title: string
  artist: string
  duration: number
  /** Título do vídeo de onde a música veio, como estava no YouTube. */
  videoTitle?: string
  channel?: string
  /** O que a pessoa digitou para chegar a esta música. */
  typed?: string
  /** Texto que só ajuda a reconhecer o artista: a busca que trouxe uma lista de vídeos vale para o artista de todos, não para o nome de cada um. */
  artistHint?: string
}

/** O quanto o nome e o artista de um registro aparecem no que se sabe da música. */
export interface NameEvidence {
  /** 0..1: o nome do registro é o nome desta música? */
  title: number
  /** 0..1: o artista do registro aparece? null = não há como saber (só se conhece o nome da música). */
  artist: number | null
}

export interface LyricsMatch {
  record: LrclibRecord
  score: number
  names: NameEvidence
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

/** A partir daqui o nome do registro é o da música. Abaixo de `NAME_MAYBE` é outra música. */
const NAME_SURE = 0.7
const NAME_MAYBE = 0.4
const ARTIST_SURE = 0.6

/** Palavras que aparecem em nome de artista sem identificar ninguém. */
const ARTIST_FILLER = new Set(['e', 'and', 'the', 'os', 'as', 'o', 'a', 'de', 'da', 'do', 'dos', 'das', 'mc', 'dj', 'banda', 'grupo'])

function distinctive(words: string[]): string[] {
  const kept = words.filter((word) => !ARTIST_FILLER.has(word))
  return kept.length > 0 ? kept : words
}

function share(words: string[], known: ReadonlySet<string>): number {
  if (words.length === 0) return 0
  return words.filter((word) => known.has(word)).length / words.length
}

/**
 * Compara do registro para a música, e não o contrário. O título de um vídeo vem cheio de coisa
 * ("(Ao Vivo)", "Clipe Oficial", o nome do DVD, dois artistas) e tirar dele um nome limpo falha
 * de muitos jeitos. O registro do banco já é limpo: basta conferir se o nome e o artista dele
 * aparecem no que se sabe da música. Palavra sobrando no vídeo deixa de atrapalhar.
 */
export function nameEvidence(record: Pick<LrclibRecord, 'trackName' | 'artistName' | 'albumName'>, query: LyricsQuery): NameEvidence {
  const known = new Set(tokens([query.title, query.artist, query.videoTitle, query.channel, query.typed].filter(Boolean).join(' ')))
  const track = tokens(coreTitle(record.trackName))
  if (track.length === 0 || known.size === 0) return { title: 0, artist: null }

  const artist = tokens(record.artistName)
  const album = tokens(record.albumName ?? '')

  // O nome do registro cabe inteiro no que se sabe da música? E o nome que o app tem: quanto
  // dele o registro explica, contando nome, artista e álbum? Vale o nome guardado ou o que o
  // título do vídeo dá, o que casar melhor: assim a conta não muda entre a tela de busca (que
  // só tem o vídeo) e a importação (que já tem os dados de música do YouTube).
  const inside = share(track, known)
  const explained = new Set([...track, ...artist, ...album])
  const names = [query.title, ...(query.videoTitle ? [parseVideoTitle(query.videoTitle, query.channel ?? '').title] : [])]
  // O começo do nome, antes do primeiro separador, conta por si: o que vem depois costuma ser enfeite.
  const back = Math.max(
    ...names
      .flatMap((name) => [coreTitle(name), titleHead(name)])
      .map((name) => {
        const own = tokens(name).filter((word) => !isFiller(word))
        return own.length === 0 ? 1 : share(own, explained)
      }),
  )
  const title = inside * (0.5 + 0.5 * back)

  // O artista do registro aparece em algum lugar? Num nome composto ("A, B & C") basta um dos
  // artistas por inteiro. Nome de uma palavra curta ("Leo") não conta sozinho: casaria com gente demais.
  const about = new Set([...known, ...tokens(query.artistHint ?? '')])
  const parts = artistParts(record.artistName)
    .map((part) => distinctive(tokens(part)))
    .filter((words) => words.length >= 2 || (words[0]?.length ?? 0) >= 5)
  const found = Math.max(share(distinctive(artist), about), ...parts.map((words) => share(words, about)))
  if (found >= ARTIST_SURE) return { title, artist: found }

  // Não apareceu. Isso só desmente o registro se havia onde um artista aparecer: o campo de
  // artista, o canal, a parte de artista do título do vídeo ou o que foi digitado. Palavra que
  // sobrou do nome da música não diz nada sobre quem canta.
  const spoken = new Set([...track, ...album])
  const named = tokens([query.artist, query.channel, query.typed, query.artistHint, query.videoTitle ? parseVideoTitle(query.videoTitle, '').artist : ''].filter(Boolean).join(' '))
  const rest = named.filter((word) => !spoken.has(word) && !isFiller(word) && !isVersionWord(word) && !ARTIST_FILLER.has(word))
  return { title, artist: rest.length === 0 ? null : found }
}

function artistOk(names: NameEvidence): boolean {
  return names.artist === null || names.artist >= ARTIST_SURE
}

/**
 * O registro pode ser desta música: ou o nome é o dela, ou lembra o dela e o artista confere.
 * O resto é outra música que veio junto na busca ("Voz" numa busca por "Rua da Voz").
 */
export function resemblesSong(match: LyricsMatch): boolean {
  return match.names.title >= NAME_SURE || (match.names.title >= NAME_MAYBE && artistOk(match.names))
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

  const wanted = versionMarks([query.title, query.videoTitle, query.typed].filter(Boolean).join(' ')).join()

  const matches = usable.map((record): LyricsMatch => {
    const timing = timings.get(record.id) ?? null
    const synced = timing !== null
    const durationDelta = Math.abs(record.duration - query.duration)
    const sameTiming = timing ? groups.get(timing.key) ?? [record.id] : [record.id]
    const tail = timing && query.duration > 0 ? query.duration - timing.last : null
    const names = nameEvidence(record, query)

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

    score += names.title * 30
    if (names.artist !== null) score += names.artist * 20
    // "Ao vivo", "acústico" e "remix" são outra gravação: os tempos da letra mudam.
    const marks = versionMarks(`${record.trackName} ${record.albumName ?? ''}`).join()
    if (wanted || marks) score += wanted === marks ? 8 : -12
    // Registros que repetem "Artista - Música" em todos os campos costumam ser envios de baixa qualidade.
    if (normalize(record.trackName) === normalize(record.artistName)) score -= 10

    return { record, score, names, durationDelta, synced, firstVerse: timing?.first ?? null, tail, sameTiming }
  })

  return matches.sort((a, b) => Number(b.synced) - Number(a.synced) || b.score - a.score)
}

/**
 * As buscas a tentar, da mais exata para a mais aberta. O banco só devolve registro que tenha
 * todas as palavras da busca: uma palavra a mais ("DVD", "Clipe Oficial", o segundo artista)
 * zera o resultado, e palavras a menos não atrapalham. Por isso cada degrau usa menos texto.
 */
export function searchSteps(query: LyricsQuery): Array<Record<string, string>> {
  const steps: Array<Record<string, string>> = []
  const seen = new Set<string>()
  const add = (params: Record<string, string>) => {
    const entries = Object.entries(params).map(([key, value]) => [key, value.trim()] as const)
    if (entries.some(([, value]) => !normalize(value))) return
    const key = entries.map(([name, value]) => `${name}=${normalize(value)}`).join('&')
    if (seen.has(key)) return
    seen.add(key)
    steps.push(Object.fromEntries(entries))
  }

  const title = coreTitle(query.title)
  const artist = firstArtist(query.artist)
  // A gravação ao vivo costuma estar cadastrada com isso no nome ("Evidências - Ao Vivo").
  const version = /\b(ao vivo|live|en vivo|acustic[oa]|acoustic|unplugged|remix)\b/.exec(normalize([query.title, query.videoTitle].filter(Boolean).join(' ')))?.[1]

  if (artist) {
    if (version) add({ track_name: `${title} ${version}`, artist_name: artist })
    add({ track_name: title, artist_name: artist })
  }
  if (query.videoTitle) {
    const parsed = parseVideoTitle(query.videoTitle, query.channel ?? '')
    add({ track_name: coreTitle(parsed.title), artist_name: firstArtist(parsed.artist) })
  }
  // Só o começo do nome: o que vem depois do primeiro separador pode ser enfeite que o app não conhece.
  if (artist) add({ track_name: titleHead(title), artist_name: artist })
  if (query.typed) add({ q: searchText(query.typed) })
  // A busca livre olha nome, artista e álbum de uma vez: serve também ao vídeo que veio como "Música - Artista".
  add({ q: searchText(`${artist} ${title}`) })
  if (artist) add({ q: searchText(title) })
  return steps
}

/**
 * Procura a letra em degraus e para no primeiro que traz uma letra que o app aplicaria com
 * confiança. `seed` são registros já conhecidos (os que a tela de busca achou): entram na disputa.
 */
export async function searchLyrics(query: LyricsQuery, outerSignal?: AbortSignal, seed: LrclibRecord[] = []): Promise<LyricsMatch[]> {
  const seen = new Map<number, LrclibRecord>(seed.map((record) => [record.id, record]))
  const started = Date.now()
  let answered = false
  let failures = 0
  let failure: unknown = null

  for (const params of query.title.trim() ? searchSteps(query) : []) {
    if (answered && Date.now() - started > SEARCH_BUDGET_MS) break
    try {
      for (const record of await searchOnce(params, outerSignal)) seen.set(record.id, record)
      answered = true
      failures = 0
    } catch (err) {
      if (outerSignal?.aborted || !(err instanceof LrclibError)) throw err
      // Um degrau que falha não derruba a busca; dois seguidos, o banco está fora do ar.
      failure = err
      if (++failures >= 2) break
      continue
    }
    const ranked = rankRecords([...seen.values()], query)
    if (pickAutomatic(ranked, query)?.confident) return ranked
  }

  if (!answered && failure && seen.size === 0) throw failure
  return rankRecords([...seen.values()], query)
}

/** Busca com as palavras que a pessoa escolheu, sem degraus: é a saída quando a busca automática não acha. */
export async function searchLyricsByText(text: string, duration: number, signal?: AbortSignal): Promise<LyricsMatch[]> {
  const words = searchText(text)
  if (!words) return []
  return rankRecords(await searchOnce({ q: words }, signal), { title: text, artist: '', duration })
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

export interface AvailableLyrics {
  kind: LyricsAvailability
  /** As letras que servem a este vídeo, da melhor para a pior. São as que seguem com o download. */
  matches: LyricsMatch[]
}

/** O que a busca de letras precisa saber de um vídeo. */
export interface VideoLike {
  id: string
  title: string
  channel?: string
  duration: number
  track?: string
  artist?: string
}

/** O que se sabe de um vídeo, na forma que a busca de letras usa. */
export function videoQuery(video: Omit<VideoLike, 'id'>, typed?: string): LyricsQuery {
  const parsed = parseVideoTitle(video.title, video.channel ?? '')
  return {
    title: video.track?.trim() || parsed.title,
    artist: video.artist?.trim() || parsed.artist,
    duration: video.duration,
    videoTitle: video.title,
    ...(video.channel ? { channel: video.channel } : {}),
    ...(typed ? { typed } : {}),
  }
}

/** O que se sabe de uma música da biblioteca. `typed` é o que a pessoa digitou para chegar a ela. */
export function songQuery(song: Pick<Song, 'title' | 'artist' | 'duration' | 'source'>, typed?: string): LyricsQuery {
  const { source } = song
  const origin = source.type === 'youtube' ? source.title : source.name.replace(/\.[a-z0-9]{2,5}$/i, '')
  // Quem renomeou a música para outra coisa sabe o que quer: o título antigo deixa de contar.
  const own = tokens(coreTitle(song.title))
  const from = origin && tokens(origin).some((word) => own.includes(word)) ? origin : undefined
  return {
    title: song.title,
    artist: song.artist,
    duration: song.duration,
    ...(from ? { videoTitle: from } : {}),
    ...(source.type === 'youtube' && source.channel ? { channel: source.channel } : {}),
    ...(typed ? { typed } : {}),
  }
}

const KEPT_PER_VIDEO = 8

function availabilityOf(ranked: LyricsMatch[], query: LyricsQuery): AvailableLyrics | null {
  const fits = ranked.filter((match) => match.names.title >= NAME_SURE && artistOk(match.names))
  if (fits.length === 0) return null
  const kind = fits.some((match) => match.durationDelta <= 2 && isConfidentMatch(match, query)) ? 'exata' : fits.some((match) => match.synced) ? 'outra' : 'texto'
  return { kind, matches: fits.slice(0, KEPT_PER_VIDEO) }
}

/**
 * Para a tela de busca: que vídeos têm letra, de que tipo, e quais são essas letras.
 *
 * Duração igual (até 2 s) à de uma letra sincronizada é um bom sinal de que a sincronia vai
 * encaixar sem ajuste. Letra sincronizada de outra duração tende a sair do tempo. Letra só em
 * texto precisa da sincronia pelo áudio. Vídeo fora do mapa não tem letra conhecida.
 *
 * Um pedido só serve a lista inteira. A regra de quem casa com quem é a mesma da importação
 * (`nameEvidence`), e as letras achadas aqui seguem com o download: o que esta tela mostra é o
 * que a música recebe.
 */
export async function lyricsAvailability(typed: string, videos: VideoLike[], signal?: AbortSignal): Promise<Map<string, AvailableLyrics>> {
  let records = await searchOnce({ q: searchText(typed) }, signal)
  // O texto digitado pode ter uma palavra que o banco não conhece: tenta pelo primeiro vídeo, em degraus.
  if (records.length === 0 && videos.length > 0) records = (await searchLyrics(videoQuery(videos[0]), signal)).map((match) => match.record)

  const found = new Map<string, AvailableLyrics>()
  for (const video of videos) {
    const query = { ...videoQuery(video), artistHint: typed }
    const available = availabilityOf(rankRecords(records, query), query)
    if (available) found.set(video.id, available)
  }
  return found
}

/** O mesmo para um vídeo só (link colado): aí vale a busca completa, em degraus. */
export async function lyricsForVideo(video: VideoLike, signal?: AbortSignal): Promise<Map<string, AvailableLyrics>> {
  const query = videoQuery(video)
  const available = availabilityOf(await searchLyrics(query, signal), query)
  return new Map(available ? [[video.id, available]] : [])
}

/** Letra só de texto cujo nome bate com o da música: serve quando a sincronia vai sair do áudio. */
export function isPlausiblePlain(match: LyricsMatch): boolean {
  return !match.synced && !!match.record.plainLyrics && match.names.title >= NAME_SURE && artistOk(match.names)
}

/**
 * Sincronizada, com o nome da música, duração próxima e último verso cabendo na gravação.
 * Quando se conhece o artista e ele não é o do registro, é quase sempre outra música de mesmo nome.
 */
export function isConfidentMatch(match: LyricsMatch, query: LyricsQuery): boolean {
  if (!match.synced || match.names.title < NAME_SURE || !artistOk(match.names)) return false
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

  // Nome parecido, artista diferente e duração diferente: é outra música. Melhor ficar sem letra.
  const fallback = synced.find((m) => resemblesSong(m) && (m.tail === null || m.tail >= 0) && (artistOk(m.names) || (query.duration > 0 && m.durationDelta <= 2)))
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
