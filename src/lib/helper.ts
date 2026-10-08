import type { AlignOutcome, LineInput } from './align/ctc'

/**
 * Cliente do ajudante: o programa deste computador que baixa do YouTube, separa a voz, mede a
 * letra no áudio e abre a sala. Ele pode estar em dois lugares:
 *   - no próprio servidor do app, quando o app é aberto pela pasta do projeto (helper/plugin.ts);
 *   - instalado à parte, numa porta fixa desta máquina, para o app publicado (helper/server.ts).
 */
const PATH = '/api/helper'
/** Porta do ajudante instalado à parte. */
export const HELPER_PORT = 5175
/** Para testes, e para quem trocou a porta: o endereço do ajudante instalado, como http://localhost:5197. */
const OVERRIDE_KEY = 'gogo:ajudante'
const ABSENT = 'O ajudante não está ativo neste computador.'

/** ok = no ar e atende este endereço. sem-permissao = no ar, mas este endereço não foi autorizado nele. */
export type HelperPresence = 'ok' | 'sem-permissao' | 'ausente'

const isLoopback = () => typeof location !== 'undefined' && ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)

function override(): string | null {
  try {
    const value = localStorage.getItem(OVERRIDE_KEY)
    return value && /^http:\/\/(localhost|127\.0\.0\.1)(:\d{2,5})?$/.test(value) ? value : null
  } catch {
    return null
  }
}

/** true quando o app não veio do servidor que traz o ajudante embutido: é o app publicado. */
export function isPublishedApp(): boolean {
  return !isLoopback() || override() !== null
}

/** O endereço que o ajudante instalado precisa autorizar para atender este app. */
export function appOrigin(): string {
  return typeof location === 'undefined' ? '' : location.origin
}

interface Located {
  /** '' = o próprio servidor do app. */
  base: string
  presence: HelperPresence
}

let located: Promise<Located> | null = null

/** Pergunta a um endereço se há um ajudante ali e se ele atende esta página. null = não há. */
async function ask(base: string): Promise<HelperPresence | null> {
  try {
    const res = await fetch(`${base}${PATH}/hello`)
    if (!res.ok || !res.headers.get('content-type')?.includes('json')) return null
    const body = (await res.json()) as { app?: unknown; allowed?: unknown }
    if (body.app !== 'gogo-ajudante') return null
    return body.allowed === true ? 'ok' : 'sem-permissao'
  } catch {
    return null
  }
}

/**
 * Procura o ajudante uma vez e guarda a resposta. Sem prazo de propósito: no app publicado o
 * navegador pode estar perguntando ao usuário se o site pode acessar a rede local, e o pedido
 * fica esperando a resposta dele. Ajudante que não existe falha na hora, sem precisar de prazo.
 */
function locate(): Promise<Located> {
  located ??= (async () => {
    // Aberto neste computador pelo servidor do app: o ajudante, se houver, é o próprio servidor.
    if (isLoopback() && (await ask('')) === 'ok') return { base: '', presence: 'ok' as const }
    const installed = override() ?? `http://localhost:${HELPER_PORT}`
    return { base: installed, presence: (await ask(installed)) ?? ('ausente' as const) }
  })()
  return located
}

/** Onde está o ajudante, visto desta página. */
export async function helperPresence(): Promise<HelperPresence> {
  return (await locate()).presence
}

/** Esquece o que se sabia do ajudante: a próxima chamada procura de novo (depois de instalar ou iniciar). */
export function forgetHelper(): void {
  located = null
  statusCache = null
}

/** Endereço de uma rota do ajudante. Falha quando ele não está no ar ou não atende este app. */
export async function helperUrl(path: string): Promise<string> {
  const { base, presence } = await locate()
  if (presence !== 'ok') throw new HelperError(ABSENT)
  return `${base}${PATH}${path}`
}

/** O mesmo, para WebSocket (o canal do host da sala). */
export async function helperSocketUrl(path: string): Promise<string> {
  const url = await helperUrl(path)
  if (url.startsWith('http')) return url.replace(/^http/, 'ws')
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${url}`
}

export interface HelperStatus {
  ok: boolean
  ytDlp: { version: string; source: 'projeto' | 'sistema' | 'env' } | null
  ffmpeg: { version: string } | null
  separator?: { installed: boolean }
  aligner?: { installed: boolean }
}

export interface VideoSummary {
  id: string
  url: string
  title: string
  channel: string
  duration: number
  thumbnail: string
  track?: string
  artist?: string
  album?: string
}

/** Quantas vezes o ajudante tenta cada download (o mesmo número de helper/ytdlp.ts). */
export const DOWNLOAD_TRIES = 3

export interface DownloadProgress {
  part: number
  downloaded: number
  total: number | null
  speed: number | null
  eta: number | null
  /** 1 na primeira vez. Acima disso, o download falhou e está sendo refeito. */
  attempt?: number
}

export interface DownloadResult {
  fileId: string
  size: number
  mime: string
  ext: string
  info: VideoSummary
}

export class HelperError extends Error {}

async function json<T>(res: Response): Promise<T> {
  let body: unknown = null
  try {
    body = await res.json()
  } catch {
    // Resposta sem JSON: tratada abaixo como ajudante ausente.
  }
  if (!res.ok) {
    const message = body && typeof body === 'object' && 'error' in body ? String((body as { error: unknown }).error) : null
    throw new HelperError(message ?? 'O ajudante não respondeu.')
  }
  if (body === null) throw new HelperError(ABSENT)
  return body as T
}

async function call(path: string, init?: RequestInit): Promise<Response> {
  const url = await helperUrl(path)
  try {
    return await fetch(url, init)
  } catch (err) {
    if (init?.signal?.aborted) throw err
    // O ajudante pode ter sido fechado: da próxima vez, procura de novo.
    located = null
    throw new HelperError(ABSENT)
  }
}

/** null quando não há ajudante atendendo este app (o app publicado, numa máquina sem o ajudante instalado). */
export async function helperStatus(): Promise<HelperStatus | null> {
  try {
    const res = await call('/status')
    if (!res.headers.get('content-type')?.includes('json')) return null
    return await json<HelperStatus>(res)
  } catch {
    return null
  }
}

export async function updateDownloader(): Promise<HelperStatus> {
  return json<HelperStatus>(await call('/update', { method: 'POST' }))
}

/** Baixa um ffmpeg próprio do ajudante (cerca de 80 MB), para a máquina que não tem um. */
export async function installFfmpeg(): Promise<HelperStatus> {
  return json<HelperStatus>(await call('/ffmpeg/install', { method: 'POST' }))
}

/** Baixa o motor de separação de voz e o modelo (cerca de 60 MB) para helper/bin/separator. */
export async function installSeparator(): Promise<HelperStatus> {
  return json<HelperStatus>(await call('/separator/install', { method: 'POST' }))
}

export type SeparationStage = 'convertendo' | 'separando' | 'codificando'

export interface SeparatedFile {
  fileId: string
  size: number
}

/**
 * Manda a música para o ajudante separar em instrumental e voz.
 * As duas faixas ficam prontas para `fetchDownloaded`.
 */
export async function separateMedia(
  file: Blob,
  extension: string,
  onStage: (stage: SeparationStage) => void,
  signal?: AbortSignal,
): Promise<{ instrumental: SeparatedFile; vocals: SeparatedFile }> {
  const res = await call(`/separate?ext=${encodeURIComponent(extension)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: file,
    signal,
  })
  if (!res.ok || !res.body) await json<never>(res)

  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader()
  let pending = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    pending += value
    const lines = pending.split('\n')
    pending = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      const event = JSON.parse(line) as { type: string; stage?: SeparationStage; message?: string; instrumental?: SeparatedFile; vocals?: SeparatedFile }
      if (event.type === 'stage' && event.stage) onStage(event.stage)
      else if (event.type === 'error') throw new HelperError(event.message ?? 'A separação falhou.')
      else if (event.type === 'done' && event.instrumental && event.vocals) return { instrumental: event.instrumental, vocals: event.vocals }
    }
  }
  throw new HelperError('A separação foi interrompida.')
}

/** Baixa o motor e o modelo da sincronia pelo áudio (cerca de 300 MB) para helper/bin/aligner. */
export async function installAligner(): Promise<HelperStatus> {
  return json<HelperStatus>(await call('/aligner/install', { method: 'POST' }))
}

export type AlignStage = 'convertendo' | 'ouvindo' | 'encaixando'

/**
 * Manda a letra e a faixa de voz para o ajudante dizer em que instante cada palavra é cantada.
 * `progress` vai de 0 a 1 durante a etapa "ouvindo", que é a demorada.
 */
export async function alignToAudio(
  voice: Blob,
  extension: string,
  lines: LineInput[],
  onStage: (stage: AlignStage, progress?: number) => void,
  signal?: AbortSignal,
): Promise<AlignOutcome> {
  // Corpo em duas partes: tamanho do cabeçalho, cabeçalho em JSON e o arquivo de áudio.
  const header = new TextEncoder().encode(JSON.stringify({ lines }))
  const size = new Uint8Array(4)
  new DataView(size.buffer).setUint32(0, header.length, true)
  const res = await call(`/align?ext=${encodeURIComponent(extension)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: new Blob([size, header, voice]),
    signal,
  })
  if (!res.ok || !res.body) await json<never>(res)

  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader()
  let pending = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    pending += value
    const parts = pending.split('\n')
    pending = parts.pop() ?? ''
    for (const line of parts) {
      if (!line.trim()) continue
      const event = JSON.parse(line) as { type: string; stage?: AlignStage; progress?: number; message?: string; result?: AlignOutcome }
      if (event.type === 'stage' && event.stage) onStage(event.stage, event.progress)
      else if (event.type === 'error') throw new HelperError(event.message ?? 'A sincronia pelo áudio falhou.')
      else if (event.type === 'done' && event.result) return event.result
    }
  }
  throw new HelperError('A sincronia pelo áudio foi interrompida.')
}

let statusCache: { at: number; value: Promise<HelperStatus | null> } | null = null

/** Estado do ajudante com cache curto, para quem só precisa saber o que está disponível. */
export function helperStatusCached(): Promise<HelperStatus | null> {
  if (!statusCache || Date.now() - statusCache.at > 15_000) statusCache = { at: Date.now(), value: helperStatus() }
  return statusCache.value
}

export function forgetHelperStatus(): void {
  statusCache = null
}

export async function searchVideos(query: string, signal?: AbortSignal): Promise<VideoSummary[]> {
  const res = await call(`/search?q=${encodeURIComponent(query)}`, { signal })
  return (await json<{ results: VideoSummary[] }>(res)).results
}

export async function videoInfo(url: string, signal?: AbortSignal): Promise<VideoSummary> {
  return json<VideoSummary>(await call(`/info?url=${encodeURIComponent(url)}`, { signal }))
}

export interface SpotifyList {
  kind: 'playlist' | 'album' | 'track'
  id: string
  /** Nome da playlist, do álbum ou da música. */
  name: string
  /** Dono da playlist, ou artista do álbum ou da música. */
  owner: string
  tracks: Array<{ title: string; artist: string; duration: number }>
  /** true quando a página do Spotify só mostrou as 100 primeiras faixas. */
  truncated: boolean
}

/** Nome e faixas de um link do Spotify: playlist pública, álbum ou uma música só. */
export async function spotifyLink(link: string, signal?: AbortSignal): Promise<SpotifyList> {
  return json<SpotifyList>(await call(`/spotify/link?url=${encodeURIComponent(link)}`, { signal }))
}

export function isYoutubeUrl(text: string): boolean {
  return /^https?:\/\/(www\.|m\.|music\.)?(youtube\.com|youtu\.be)\//i.test(text.trim())
}

/** Baixa no ajudante e avisa o progresso. O arquivo fica pronto para `fetchDownloaded`. */
export async function downloadVideo(
  url: string,
  kind: 'audio' | 'video',
  onProgress: (progress: DownloadProgress) => void,
  signal?: AbortSignal,
): Promise<DownloadResult> {
  const res = await call('/download', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, kind }),
    signal,
  })
  if (!res.ok || !res.body) await json<never>(res)

  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader()
  let pending = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    pending += value
    const lines = pending.split('\n')
    pending = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      const event = JSON.parse(line) as { type: string; message?: string } & Partial<DownloadProgress> & Partial<DownloadResult>
      if (event.type === 'progress') onProgress(event as DownloadProgress)
      else if (event.type === 'error') throw new HelperError(event.message ?? 'O download falhou.')
      else if (event.type === 'done') return event as DownloadResult
    }
  }
  throw new HelperError('O download foi interrompido.')
}

export async function fetchDownloaded(fileId: string, signal?: AbortSignal): Promise<ReadableStream<Uint8Array>> {
  const res = await call(`/file/${fileId}`, { signal })
  if (!res.ok || !res.body) await json<never>(res)
  return res.body!
}

export async function fetchImage(url: string): Promise<Blob | null> {
  try {
    const res = await call(`/image?url=${encodeURIComponent(url)}`)
    return res.ok ? await res.blob() : null
  } catch {
    return null
  }
}
