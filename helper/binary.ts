import { execFile } from 'node:child_process'
import { createWriteStream, existsSync } from 'node:fs'
import { chmod, mkdir, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const IS_WINDOWS = process.platform === 'win32'

export const BIN_DIR = path.join(HERE, 'bin')
export const LOCAL_YTDLP = path.join(BIN_DIR, IS_WINDOWS ? 'yt-dlp.exe' : 'yt-dlp')

const RELEASE_ASSET = IS_WINDOWS ? 'yt-dlp.exe' : process.platform === 'darwin' ? 'yt-dlp_macos' : 'yt-dlp'
const RELEASE_URL = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${RELEASE_ASSET}`

export interface ToolInfo {
  path: string
  version: string
  /** De onde veio o executável: pasta do projeto, PATH do sistema ou variável de ambiente. */
  source: 'projeto' | 'sistema' | 'env'
}

async function firstLine(bin: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(bin, args, { timeout: 20_000, windowsHide: true })
    return stdout.split(/\r?\n/)[0]?.trim() || null
  } catch {
    return null
  }
}

/** Ordem de preferência: YTDLP_PATH, depois helper/bin, depois o que estiver no PATH. */
export async function findYtDlp(): Promise<ToolInfo | null> {
  const candidates: Array<[string, ToolInfo['source']]> = []
  if (process.env.YTDLP_PATH) candidates.push([process.env.YTDLP_PATH, 'env'])
  if (existsSync(LOCAL_YTDLP)) candidates.push([LOCAL_YTDLP, 'projeto'])
  candidates.push(['yt-dlp', 'sistema'])

  for (const [bin, source] of candidates) {
    const version = await firstLine(bin, ['--version'])
    if (version) return { path: bin, version, source }
  }
  return null
}

export async function findFfmpeg(): Promise<ToolInfo | null> {
  const bin = process.env.FFMPEG_PATH || 'ffmpeg'
  const line = await firstLine(bin, ['-version'])
  if (!line) return null
  const match = /ffmpeg version (\S+)/.exec(line)
  return { path: bin, version: match ? match[1] : line, source: process.env.FFMPEG_PATH ? 'env' : 'sistema' }
}

/**
 * Baixa a versão mais recente do yt-dlp para helper/bin.
 * O binário novo só substitui o atual depois de responder a `--version`.
 */
export async function updateYtDlp(): Promise<ToolInfo> {
  await mkdir(BIN_DIR, { recursive: true })
  const staged = path.join(BIN_DIR, IS_WINDOWS ? 'yt-dlp.new.exe' : 'yt-dlp.new')

  const res = await fetch(RELEASE_URL, { redirect: 'follow' })
  if (!res.ok || !res.body) throw new Error(`Não foi possível baixar o yt-dlp (HTTP ${res.status}).`)

  try {
    await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(staged))
    if (!IS_WINDOWS) await chmod(staged, 0o755)

    const version = await firstLine(staged, ['--version'])
    if (!version) throw new Error('O yt-dlp baixado não executou. O arquivo anterior foi mantido.')

    await rm(LOCAL_YTDLP, { force: true })
    await rename(staged, LOCAL_YTDLP)
    return { path: LOCAL_YTDLP, version, source: 'projeto' }
  } catch (err) {
    await rm(staged, { force: true })
    throw err
  }
}
