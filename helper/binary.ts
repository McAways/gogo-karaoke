import { execFile } from 'node:child_process'
import { createWriteStream, existsSync } from 'node:fs'
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises'
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

/**
 * Como chamar o npm que acompanha o Node em uso. Não depende do PATH: no ajudante instalado, o
 * Node pode existir só dentro da pasta dele (baixado pelo arquivo "instalar").
 */
export function npmCommand(): { command: string; args: string[]; shell: boolean } {
  const dir = path.dirname(process.execPath)
  // Ao lado do executável no Windows; em ../lib no macOS e no Linux.
  const cli = [path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'), path.join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')].find((file) => existsSync(file))
  if (cli) return { command: process.execPath, args: [cli], shell: false }
  // Node instalado de outro jeito (um gerenciador de versões, por exemplo): vale o npm do PATH.
  return { command: 'npm', args: [], shell: IS_WINDOWS }
}

/** Binário pronto do ffmpeg para Windows, macOS e Linux, distribuído pelo npm. */
const FFMPEG_PACKAGE = 'ffmpeg-static@5.3.0'
const FFMPEG_DIR = path.join(BIN_DIR, 'ffmpeg')
const LOCAL_FFMPEG = path.join(FFMPEG_DIR, 'node_modules', 'ffmpeg-static', IS_WINDOWS ? 'ffmpeg.exe' : 'ffmpeg')

/** Ordem de preferência: FFMPEG_PATH, depois o ffmpeg do sistema, depois a cópia baixada para helper/bin. */
export async function findFfmpeg(): Promise<ToolInfo | null> {
  const candidates: Array<[string, ToolInfo['source']]> = []
  if (process.env.FFMPEG_PATH) candidates.push([process.env.FFMPEG_PATH, 'env'])
  candidates.push(['ffmpeg', 'sistema'])
  if (existsSync(LOCAL_FFMPEG)) candidates.push([LOCAL_FFMPEG, 'projeto'])

  for (const [bin, source] of candidates) {
    const line = await firstLine(bin, ['-version'])
    if (!line) continue
    const match = /ffmpeg version (\S+)/.exec(line)
    return { path: bin, version: match ? match[1] : line, source }
  }
  return null
}

/**
 * Baixa um ffmpeg próprio para helper/bin/ffmpeg (cerca de 80 MB), para a máquina que não tem um.
 * O pacote do npm escolhe o binário certo para o sistema e o processador.
 */
export async function installFfmpeg(): Promise<ToolInfo> {
  await mkdir(FFMPEG_DIR, { recursive: true })
  // Um package.json próprio faz o npm instalar aqui dentro, e não na pasta de cima.
  await writeFile(path.join(FFMPEG_DIR, 'package.json'), JSON.stringify({ name: 'gogo-ffmpeg', private: true }))
  const npm = npmCommand()
  try {
    await execFileAsync(npm.command, [...npm.args, 'install', FFMPEG_PACKAGE, '--no-audit', '--no-fund', '--no-package-lock', '--loglevel=error'], {
      cwd: FFMPEG_DIR,
      shell: npm.shell,
      timeout: 15 * 60_000,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    })
  } catch {
    throw new Error('Não foi possível baixar o ffmpeg. Confira a internet e tente de novo.')
  }
  const line = existsSync(LOCAL_FFMPEG) ? await firstLine(LOCAL_FFMPEG, ['-version']) : null
  if (!line) throw new Error('O ffmpeg foi baixado, mas não executou neste computador.')
  const match = /ffmpeg version (\S+)/.exec(line)
  return { path: LOCAL_FFMPEG, version: match ? match[1] : line, source: 'projeto' }
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
