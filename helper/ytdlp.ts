import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'

export class HelperError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export type MediaKind = 'audio' | 'video'

export interface VideoSummary {
  id: string
  url: string
  title: string
  channel: string
  duration: number
  thumbnail: string
  /** Preenchidos quando o YouTube expõe os metadados de faixa. */
  track?: string
  artist?: string
  album?: string
}

export interface DownloadProgress {
  /** 1 para o primeiro arquivo, 2 para o segundo (vídeo baixa imagem e som separados). */
  part: number
  downloaded: number
  total: number | null
  speed: number | null
  eta: number | null
  /** 1 na primeira vez. Acima disso, o download falhou e está sendo refeito. */
  attempt: number
}

export interface DownloadedFile {
  file: string
  size: number
  ext: string
  mime: string
  info: VideoSummary
}

const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
  'www.youtube-nocookie.com',
])

/** Só aceita links do YouTube: o ajudante não é um buscador genérico de URLs. */
export function assertYoutubeUrl(raw: string): string {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new HelperError(400, 'Esse link não é válido.')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new HelperError(400, 'Esse link não é válido.')
  if (!YOUTUBE_HOSTS.has(url.hostname.toLowerCase())) throw new HelperError(400, 'Por enquanto só links do YouTube são aceitos.')
  return url.toString()
}

const MIME_BY_EXT: Record<string, string> = {
  m4a: 'audio/mp4',
  mp4: 'video/mp4',
  webm: 'video/webm',
  weba: 'audio/webm',
  opus: 'audio/ogg',
  ogg: 'audio/ogg',
  mp3: 'audio/mpeg',
  mkv: 'video/x-matroska',
}

function baseArgs(): string[] {
  return [
    // O yt-dlp precisa de um runtime JS para o YouTube e só habilita o deno por padrão.
    '--js-runtimes', `node:${process.execPath}`,
    '--no-playlist',
    '--no-warnings',
    '--encoding', 'utf-8',
  ]
}

function childEnv(): NodeJS.ProcessEnv {
  return { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }
}

export function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.pid === undefined) return
  if (process.platform === 'win32') {
    // child.kill() no Windows deixaria o ffmpeg filho do yt-dlp rodando.
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
  } else {
    child.kill('SIGTERM')
  }
}

function friendlyError(stderr: string): string {
  const line = stderr.split(/\r?\n/).reverse().find((l) => l.startsWith('ERROR:')) ?? stderr.trim().split(/\r?\n/).pop() ?? ''
  const detail = line.replace(/^ERROR:\s*/, '').replace(/^\[[^\]]+\]\s*[\w-]+:\s*/, '')

  if (/HTTP Error 403|Forbidden/i.test(detail)) return 'O YouTube recusou o download (403). Atualize o downloader em Ajustes e tente de novo.'
  // Baixando muitas músicas seguidas, o YouTube passa a recusar por um tempo.
  if (/HTTP Error 429|Too Many Requests|try again later|rate.?limit/i.test(detail)) return 'O YouTube está limitando os downloads agora. Espere alguns minutos e tente de novo.'
  if (/getaddrinfo|timed out|Temporary failure|Unable to download webpage/i.test(detail)) return 'Sem conexão com o YouTube. Confira a internet e tente de novo.'
  // O YouTube desconfiou deste endereço de internet (muitos pedidos seguidos) e passou a pedir login para tudo. Passa sozinho.
  if (/not a bot/i.test(detail)) return 'O YouTube está pedindo login para tudo porque recebeu muitos pedidos deste endereço de internet. Costuma passar sozinho em algumas horas; até lá nenhum vídeo baixa.'
  if (/confirm your age|age.restricted|inappropriate for some users/i.test(detail)) return 'Esse vídeo tem restrição de idade: o YouTube só o libera para quem está logado, e aqui não há login.'
  if (/Sign in to confirm|login required|members.only|Join this channel/i.test(detail)) return 'Esse vídeo exige login no YouTube e não pode ser baixado aqui.'
  if (/unavailable|Private video|removed|not available/i.test(detail)) return 'Esse vídeo não está disponível no YouTube.'
  return detail ? `O downloader falhou: ${detail}` : 'O downloader falhou sem dar detalhes.'
}

function run(bin: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env: childEnv(), windowsHide: true })
    const out: Buffer[] = []
    let err = ''
    const timer = setTimeout(() => {
      killTree(child)
      reject(new HelperError(504, 'O YouTube demorou demais para responder.'))
    }, timeoutMs)

    child.stdout.on('data', (chunk: Buffer) => out.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString('utf8')))
    child.on('error', () => {
      clearTimeout(timer)
      reject(new HelperError(500, 'Não foi possível executar o yt-dlp.'))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(Buffer.concat(out).toString('utf8'))
      else reject(new HelperError(502, friendlyError(err)))
    })
  })
}

interface RawEntry {
  id?: string
  title?: string
  channel?: string
  uploader?: string
  duration?: number
  thumbnail?: string
  thumbnails?: Array<{ url?: string; width?: number }>
  track?: string
  artist?: string
  artists?: string[]
  album?: string
  ie_key?: string
  live_status?: string
}

function summarize(entry: RawEntry): VideoSummary | null {
  if (!entry.id || !entry.title || typeof entry.duration !== 'number') return null
  if (entry.live_status === 'is_live' || entry.live_status === 'is_upcoming') return null
  return {
    id: entry.id,
    url: `https://www.youtube.com/watch?v=${entry.id}`,
    title: entry.title,
    channel: entry.channel ?? entry.uploader ?? '',
    duration: entry.duration,
    // mqdefault existe para todo vídeo e já vem em 16:9, sem as faixas pretas do hqdefault.
    thumbnail: `https://i.ytimg.com/vi/${entry.id}/mqdefault.jpg`,
    track: entry.track || undefined,
    artist: entry.artist || entry.artists?.join(', ') || undefined,
    album: entry.album || undefined,
  }
}

export async function search(bin: string, query: string): Promise<VideoSummary[]> {
  const q = query.trim().slice(0, 200)
  if (!q) return []
  const out = await run(bin, [...baseArgs(), '--flat-playlist', '--dump-single-json', '--', `ytsearch12:${q}`], 45_000)
  const data = JSON.parse(out) as { entries?: RawEntry[] }
  return (data.entries ?? []).map(summarize).filter((v): v is VideoSummary => v !== null)
}

export async function info(bin: string, url: string): Promise<VideoSummary> {
  const out = await run(bin, [...baseArgs(), '--dump-single-json', '--', assertYoutubeUrl(url)], 45_000)
  const summary = summarize(JSON.parse(out) as RawEntry)
  if (!summary) throw new HelperError(422, 'Esse link não aponta para um vídeo com duração definida.')
  return summary
}

function formatFor(kind: MediaKind, hasFfmpeg: boolean): string {
  // audio_channels<=2 evita a faixa 5.1 que o YouTube oferece em alguns vídeos.
  const stereo = '[audio_channels<=2]'
  if (kind === 'audio') return `ba[ext=m4a]${stereo}/ba[acodec^=mp4a]${stereo}/ba${stereo}/ba/b`
  // Sem ffmpeg não dá para juntar imagem e som: cai no arquivo único (360p).
  if (!hasFfmpeg) return 'b[height<=720][ext=mp4]/b[ext=mp4]/b'
  return `bv*[height<=720][vcodec^=avc1]+ba[ext=m4a]${stereo}/b[height<=720][ext=mp4]/b[height<=720]/b`
}

const PROGRESS_TEMPLATE =
  'download:GOGO|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s|%(info.format_id)s'

function num(raw: string | undefined): number | null {
  if (!raw || raw === 'NA') return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

/** Quantas vezes cada download é tentado antes de o erro chegar ao usuário. */
export const DOWNLOAD_TRIES = 3
/** Espera antes da segunda tentativa; antes da terceira, o dobro. */
const RETRY_WAIT_MS = 2000

export interface DownloadHandle {
  done: Promise<DownloadedFile>
  cancel: () => void
}

export function download(options: {
  bin: string
  ffmpeg: string | null
  url: string
  kind: MediaKind
  dir: string
  onProgress: (progress: DownloadProgress) => void
}): DownloadHandle {
  const { bin, ffmpeg, kind, dir, onProgress } = options
  const url = assertYoutubeUrl(options.url)

  const args = [
    ...baseArgs(),
    '-f', formatFor(kind, ffmpeg !== null),
    '--newline',
    '--progress',
    '--progress-template', PROGRESS_TEMPLATE,
    '--write-info-json',
    '-o', path.join(dir, 'media.%(ext)s'),
  ]
  if (kind === 'video' && ffmpeg) args.push('--merge-output-format', 'mp4')
  if (ffmpeg && ffmpeg !== 'ffmpeg') args.push('--ffmpeg-location', ffmpeg)
  args.push('--', url)

  let child: ChildProcess | null = null
  let cancelled = false

  const attempt = (tries: number): Promise<DownloadedFile> => new Promise<DownloadedFile>((resolve, reject) => {
    const running = spawn(bin, args, { env: childEnv(), windowsHide: true })
    child = running
    let pending = ''
    let err = ''
    let part = 0
    let lastFormat = ''

    running.stdout.on('data', (chunk: Buffer) => {
      pending += chunk.toString('utf8')
      const lines = pending.split(/[\r\n]+/)
      pending = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.startsWith('GOGO|')) continue
        const [, downloaded, total, estimate, speed, eta, format] = line.split('|')
        if (format !== lastFormat) {
          lastFormat = format
          part += 1
        }
        onProgress({ part, downloaded: num(downloaded) ?? 0, total: num(total) ?? num(estimate), speed: num(speed), eta: num(eta), attempt: tries })
      }
    })
    running.stderr.on('data', (chunk: Buffer) => (err += chunk.toString('utf8')))
    running.on('error', () => reject(new HelperError(500, 'Não foi possível executar o yt-dlp.')))
    running.on('close', (code) => {
      if (cancelled) return reject(new HelperError(499, 'Download cancelado.'))
      if (code !== 0) return reject(new HelperError(502, friendlyError(err)))
      collect(dir).then(resolve, reject)
    })
  })

  // Todo download é tentado até três vezes antes de o erro chegar ao usuário. Vale para qualquer
  // falha: o YouTube recusa com 403 e aceita instantes depois, a rede oscila, e quando ele limita o
  // ritmo (baixando várias músicas seguidas) responde "Video unavailable, try again later", a mesma
  // frase de um vídeo que saiu do ar. Não dá para separar as duas pela mensagem, então todas
  // repetem. Só não repete o que não é falha do download: cancelamento e o yt-dlp que não abre.
  const done = (async (): Promise<DownloadedFile> => {
    for (let tries = 1; ; tries++) {
      try {
        return await attempt(tries)
      } catch (err) {
        const cannotRun = err instanceof HelperError && err.status === 500
        if (cancelled || cannotRun || tries >= DOWNLOAD_TRIES) throw err
        // Avisa já que vem outra tentativa: a próxima pode falhar antes de baixar o primeiro byte.
        onProgress({ part: 1, downloaded: 0, total: null, speed: null, eta: null, attempt: tries + 1 })
        await new Promise((resolve) => setTimeout(resolve, RETRY_WAIT_MS * tries))
        if (cancelled) throw new HelperError(499, 'Download cancelado.')
      }
    }
  })()

  return {
    done,
    cancel: () => {
      cancelled = true
      if (child) killTree(child)
    },
  }
}

/** Lê a pasta do job em vez de confiar no stdout: nomes de arquivo podem ter acentos. */
async function collect(dir: string): Promise<DownloadedFile> {
  const names = await readdir(dir)
  const media = names.find((n) => n.startsWith('media.') && !n.endsWith('.json') && !n.endsWith('.part') && !n.endsWith('.ytdl'))
  const infoName = names.find((n) => n.endsWith('.info.json'))
  if (!media || !infoName) throw new HelperError(502, 'O download terminou, mas o arquivo não apareceu.')

  const file = path.join(dir, media)
  const ext = path.extname(media).slice(1).toLowerCase()
  const raw = JSON.parse(await readFile(path.join(dir, infoName), 'utf8')) as RawEntry
  const summary = summarize(raw)
  if (!summary) throw new HelperError(502, 'O YouTube não informou os dados desse vídeo.')
  if (raw.thumbnail) summary.thumbnail = raw.thumbnail

  const { size } = await stat(file)
  let mime = MIME_BY_EXT[ext] ?? 'application/octet-stream'
  // .webm serve para os dois; abaixo de ~320 kbps é a faixa de áudio (opus) sozinha.
  if (ext === 'webm' && summary.duration > 0 && size / summary.duration < 40_000) mime = 'audio/webm'
  return { file, size, ext, mime, info: summary }
}
