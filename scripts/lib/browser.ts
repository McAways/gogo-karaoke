// Apoio aos scripts que abrem o app num navegador de verdade (Edge instalado no Windows).
import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright-core'
import type { BrowserContext, Page } from 'playwright-core'
import { encodeWav, renderSong, renderVoice } from '../../src/lib/audio/synth.ts'
import type { SynthNote } from '../../src/lib/audio/synth.ts'

export const BASE_URL = process.env.GOGO_URL ?? 'http://localhost:5173'
export const WORK_DIR = path.resolve(import.meta.dirname, '..', '.e2e')
export const SHOTS_DIR = path.join(WORK_DIR, 'shots')
export const MEDIA_DIR = path.join(WORK_DIR, 'media')

export interface TestSong {
  /** Arquivo de música (voz + acompanhamento), estéreo. */
  songPath: string
  /** Letra em LRC, uma linha a cada quatro notas. */
  lrc: string
  melody: SynthNote[]
  duration: number
}

const LYRIC_LINES = [
  'Quando a noite cai na cidade',
  'Eu procuro a tua voz',
  'Cada rua guarda um segredo',
  'Que ficou entre nós dois',
  'Canta alto que eu respondo',
  'Deixa o medo para trás',
]

/** Gera a música de teste: melodia conhecida, para a pontuação ter gabarito. */
export function writeTestSong(): TestSong {
  mkdirSync(MEDIA_DIR, { recursive: true })
  const pitches = [57, 60, 62, 64, 64, 62, 60, 57, 55, 57, 60, 62, 64, 65, 64, 62, 60, 62, 64, 60, 57, 59, 60, 57]
  const song = renderSong({ melody: pitches, noteSeconds: 0.55, start: 1.5 })
  const duration = song.left.length / song.sampleRate

  const lrc = LYRIC_LINES.map((text, i) => {
    const first = song.melody[i * 4]
    const m = Math.floor(first.start / 60)
    const s = (first.start - m * 60).toFixed(2).padStart(5, '0')
    return `[${String(m).padStart(2, '0')}:${s}]${text}`
  }).join('\n')

  const songPath = path.join(MEDIA_DIR, 'Banda Imaginária - Rua da Voz.wav')
  writeFileSync(songPath, encodeWav([song.left, song.right], song.sampleRate))
  return { songPath, lrc, melody: song.melody, duration }
}

/**
 * Gera o áudio que o navegador vai entregar como "microfone".
 * O Chromium repete o arquivo em laço, então ele tem a duração exata da música.
 */
export function writeMicTrack(name: string, melody: SynthNote[], duration: number, transpose = 0): string {
  mkdirSync(MEDIA_DIR, { recursive: true })
  const sampleRate = 48_000
  const audio = new Float32Array(Math.floor(duration * sampleRate))
  renderVoice(audio, sampleRate, melody.map((n) => ({ ...n, midi: n.midi + transpose })), 0.5)
  const file = path.join(MEDIA_DIR, name)
  writeFileSync(file, encodeWav([audio], sampleRate))
  return file
}

export interface LaunchOptions {
  profile: string
  micFile?: string
  width?: number
  height?: number
  theme?: 'dark' | 'light'
  fresh?: boolean
  /** Aceita certificado autoassinado: é como o convidado da sala entra, por HTTPS na rede local. */
  ignoreHTTPSErrors?: boolean
}

export async function launch(options: LaunchOptions): Promise<{ context: BrowserContext; page: Page }> {
  const userDataDir = path.join(WORK_DIR, 'profiles', options.profile)
  if (options.fresh !== false) rmSync(userDataDir, { recursive: true, force: true })
  mkdirSync(userDataDir, { recursive: true })
  mkdirSync(SHOTS_DIR, { recursive: true })

  // --mute-audio: a música de teste toca de verdade, mas sem sair pelas caixas da máquina.
  const args = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--mute-audio']
  if (options.micFile) args.push(`--use-file-for-fake-audio-capture=${options.micFile}`)

  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'msedge',
    headless: true,
    args,
    viewport: { width: options.width ?? 1440, height: options.height ?? 900 },
    colorScheme: options.theme ?? 'dark',
    permissions: ['microphone'],
    ignoreHTTPSErrors: options.ignoreHTTPSErrors ?? false,
  })
  const page = context.pages()[0] ?? (await context.newPage())
  page.on('pageerror', (err) => console.log(`  [erro na página] ${err.message}`))
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log(`  [console] ${msg.text()}`)
  })
  return { context, page }
}

export async function shot(page: Page, name: string, fullPage = false): Promise<string> {
  const file = path.join(SHOTS_DIR, `${name}.png`)
  await page.screenshot({ path: file, fullPage })
  return file
}

/**
 * Monta um vídeo de teste (imagem de barras + o áudio da música de teste) com o ffmpeg.
 * Devolve null quando o ffmpeg não está instalado.
 */
export function writeTestVideo(song: TestSong): string | null {
  const file = path.join(MEDIA_DIR, 'Banda Imaginária - Clipe da Rua.mp4')
  const result = spawnSync(
    process.env.FFMPEG_PATH || 'ffmpeg',
    ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25', '-i', song.songPath, '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', file],
    { encoding: 'utf8' },
  )
  return result.status === 0 ? file : null
}
