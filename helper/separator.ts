import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { createWriteStream, existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { BIN_DIR } from './binary.ts'
import { HelperError, killTree } from './ytdlp.ts'

/**
 * Separação de voz e instrumental.
 *
 * Usa o sherpa-onnx (binário pronto) com o modelo Spleeter de 2 faixas. Uma música de
 * 3 a 4 minutos leva de 6 a 8 segundos. O que sai daqui serve para três coisas no app:
 * tocar só o instrumental, tirar o guia de notas só da voz, e conferir a letra pelo áudio.
 */

const ENGINE_VERSION = 'v1.13.8'
const RELEASES = 'https://github.com/k2-fsa/sherpa-onnx/releases/download'

const ENGINE_ASSET: Partial<Record<NodeJS.Platform, string>> = {
  win32: `sherpa-onnx-${ENGINE_VERSION}-win-x64-shared-MT-Release-no-tts.tar.bz2`,
  linux: `sherpa-onnx-${ENGINE_VERSION}-linux-x64-shared-no-tts.tar.bz2`,
  darwin: `sherpa-onnx-${ENGINE_VERSION}-osx-universal2-shared-no-tts.tar.bz2`,
}
const MODEL_ASSET = 'sherpa-onnx-spleeter-2stems-fp16.tar.bz2'

const IS_WINDOWS = process.platform === 'win32'
export const SEPARATOR_DIR = path.join(BIN_DIR, 'separator')
const EXE = path.join(SEPARATOR_DIR, IS_WINDOWS ? 'sherpa-onnx-offline-source-separation.exe' : 'sherpa-onnx-offline-source-separation')
const VOCALS_MODEL = path.join(SEPARATOR_DIR, 'vocals.fp16.onnx')
const ACCOMPANIMENT_MODEL = path.join(SEPARATOR_DIR, 'accompaniment.fp16.onnx')

export function separatorInstalled(): boolean {
  return existsSync(EXE) && existsSync(VOCALS_MODEL) && existsSync(ACCOMPANIMENT_MODEL)
}

function run(bin: string, args: string[], options: { cwd?: string; onChild?: (child: ChildProcess) => void } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: options.cwd, windowsHide: true })
    options.onChild?.(child)
    let output = ''
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')))
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')))
    child.on('error', () => reject(new HelperError(500, `Não foi possível executar ${path.basename(bin)}.`)))
    child.on('close', (code) => (code === 0 ? resolve(output) : reject(new HelperError(502, output.trim().split(/\r?\n/).slice(-3).join(' ') || `${path.basename(bin)} falhou.`))))
  })
}

async function download(url: string, target: string): Promise<void> {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok || !res.body) throw new HelperError(502, `Download falhou (HTTP ${res.status}): ${url}`)
  await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(target))
}

/** Procura arquivos pelo nome em qualquer nível de uma pasta. */
async function findFiles(dir: string, wanted: (name: string) => boolean): Promise<string[]> {
  const found: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) found.push(...(await findFiles(full, wanted)))
    else if (wanted(entry.name)) found.push(full)
  }
  return found
}

/**
 * Baixa o motor e o modelo (cerca de 60 MB) e guarda só o necessário em helper/bin/separator.
 * Os pacotes vêm com dezenas de executáveis; ficam três arquivos do motor e dois do modelo.
 */
export async function installSeparator(onStage?: (stage: string) => void): Promise<void> {
  const engine = ENGINE_ASSET[process.platform]
  if (!engine) throw new HelperError(501, 'A separação de voz não tem binário pronto para este sistema.')

  const work = await mkdtemp(path.join(os.tmpdir(), 'gogo-separator-'))
  try {
    await mkdir(SEPARATOR_DIR, { recursive: true })

    onStage?.('Baixando o motor de separação')
    await download(`${RELEASES}/${ENGINE_VERSION}/${engine}`, path.join(work, 'engine.tar.bz2'))
    onStage?.('Baixando o modelo')
    await download(`${RELEASES}/source-separation-models/${MODEL_ASSET}`, path.join(work, 'model.tar.bz2'))

    onStage?.('Instalando')
    // `tar` existe no Windows 10 em diante, no macOS e no Linux, e lê .tar.bz2 nos três.
    await mkdir(path.join(work, 'engine'))
    await mkdir(path.join(work, 'model'))
    await run('tar', ['-xjf', 'engine.tar.bz2', '-C', 'engine'], { cwd: work })
    await run('tar', ['-xjf', 'model.tar.bz2', '-C', 'model'], { cwd: work })

    const binDir = path.dirname((await findFiles(path.join(work, 'engine'), (n) => n === path.basename(EXE)))[0] ?? '')
    if (!binDir || binDir === '.') throw new HelperError(502, 'O pacote do motor veio sem o executável de separação.')

    // O executável e as bibliotecas dinâmicas de que ele depende.
    const runtime = (await readdir(binDir)).filter((n) => n === path.basename(EXE) || /onnxruntime.*\.(dll|so[.\d]*|dylib)$/i.test(n))
    for (const name of runtime) await copyFile(path.join(binDir, name), path.join(SEPARATOR_DIR, name))
    if (!IS_WINDOWS) {
      const libDir = path.join(path.dirname(binDir), 'lib')
      if (existsSync(libDir)) {
        for (const name of (await readdir(libDir)).filter((n) => /\.(so[.\d]*|dylib)$/i.test(n))) await copyFile(path.join(libDir, name), path.join(SEPARATOR_DIR, name))
      }
    }

    const models = await findFiles(path.join(work, 'model'), (n) => n === path.basename(VOCALS_MODEL) || n === path.basename(ACCOMPANIMENT_MODEL))
    if (models.length !== 2) throw new HelperError(502, 'O pacote do modelo veio incompleto.')
    for (const file of models) await copyFile(file, path.join(SEPARATOR_DIR, path.basename(file)))

    if (!separatorInstalled()) throw new HelperError(502, 'A instalação do separador não ficou completa.')
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

export type SeparationStage = 'convertendo' | 'separando' | 'codificando'

export interface Stems {
  instrumental: string
  vocals: string
}

export interface SeparationHandle {
  done: Promise<Stems>
  cancel: () => void
}

/**
 * Separa `input` (qualquer áudio ou vídeo que o ffmpeg leia) em instrumental e voz,
 * gravando dois arquivos .m4a em `dir`.
 */
export function separate(options: { input: string; dir: string; ffmpeg: string; onStage: (stage: SeparationStage) => void }): SeparationHandle {
  const { input, dir, ffmpeg, onStage } = options
  let current: ChildProcess | null = null
  let cancelled = false
  const track = (child: ChildProcess) => {
    current = child
    if (cancelled) killTree(child)
  }

  const wav = path.join(dir, 'mix.wav')
  const vocalsWav = path.join(dir, 'vocals.wav')
  const instrumentalWav = path.join(dir, 'instrumental.wav')
  const stems: Stems = { instrumental: path.join(dir, 'instrumental.m4a'), vocals: path.join(dir, 'vocals.m4a') }

  const work = async (): Promise<Stems> => {
    if (!separatorInstalled()) throw new HelperError(503, 'O separador de voz não está instalado.')

    onStage('convertendo')
    // O modelo foi treinado em 44,1 kHz estéreo.
    await run(ffmpeg, ['-y', '-loglevel', 'error', '-i', input, '-vn', '-ac', '2', '-ar', '44100', '-c:a', 'pcm_s16le', wav], { onChild: track })

    onStage('separando')
    const threads = String(Math.max(1, Math.min(6, os.availableParallelism() - 1)))
    await run(
      EXE,
      [`--num-threads=${threads}`, `--spleeter-vocals=${VOCALS_MODEL}`, `--spleeter-accompaniment=${ACCOMPANIMENT_MODEL}`, `--input-wav=${wav}`, `--output-vocals-wav=${vocalsWav}`, `--output-accompaniment-wav=${instrumentalWav}`],
      { cwd: SEPARATOR_DIR, onChild: track },
    )

    onStage('codificando')
    await run(ffmpeg, ['-y', '-loglevel', 'error', '-i', instrumentalWav, '-c:a', 'aac', '-b:a', '192k', stems.instrumental], { onChild: track })
    await run(ffmpeg, ['-y', '-loglevel', 'error', '-i', vocalsWav, '-c:a', 'aac', '-b:a', '128k', stems.vocals], { onChild: track })

    await Promise.all([rm(wav, { force: true }), rm(vocalsWav, { force: true }), rm(instrumentalWav, { force: true })])
    return stems
  }

  return {
    done: work().catch((err: unknown) => {
      throw cancelled ? new HelperError(499, 'Separação cancelada.') : err
    }),
    cancel: () => {
      cancelled = true
      if (current) killTree(current)
    },
  }
}

export async function fileSize(file: string): Promise<number> {
  return (await stat(file)).size
}
