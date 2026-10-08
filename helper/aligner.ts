import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { BIN_DIR, npmCommand } from './binary.ts'
import { HelperError, killTree } from './ytdlp.ts'
import type { AlignOutcome, LineInput } from '../src/lib/align/ctc.ts'

/**
 * Sincronia da letra pelo áudio.
 *
 * Um modelo acústico (MMS, da Meta, treinado em mais de mil idiomas) ouve a voz já separada e
 * diz em que instante cada letra do texto é cantada. Com isso a letra deixa de depender da
 * sincronia feita por outra pessoa para outra gravação: pausa a mais no vídeo, entrada
 * atrasada e nota segurada passam a ser acompanhadas.
 *
 * O modelo roda no onnxruntime, num processo à parte (helper/align-worker.ts), para não
 * travar o servidor do app. Uma música de 3 a 4 minutos leva perto de 40 segundos.
 *
 * Licença do modelo: CC BY-NC 4.0, ou seja, só uso não comercial.
 */

const RUNTIME_PACKAGE = 'onnxruntime-node@1.30.0'
const MODEL_REPO = 'https://huggingface.co/onnx-community/mms-300m-1130-forced-aligner-ONNX/resolve/main'
/** Pesos em 4 bits: 241 MB em vez de 1,2 GB, com a mesma precisão nas medições feitas aqui. */
const MODEL_REMOTE = 'onnx/model_q4.onnx'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WORKER = path.join(HERE, 'align-worker.ts')
export const ALIGNER_DIR = path.join(BIN_DIR, 'aligner')
const MODEL_FILE = path.join(ALIGNER_DIR, 'model.onnx')
const VOCAB_FILE = path.join(ALIGNER_DIR, 'vocab.json')
const RUNTIME_DIR = path.join(ALIGNER_DIR, 'node_modules', 'onnxruntime-node')

export function alignerInstalled(): boolean {
  return existsSync(MODEL_FILE) && existsSync(VOCAB_FILE) && existsSync(path.join(RUNTIME_DIR, 'package.json'))
}

function run(bin: string, args: string[], options: { cwd?: string; shell?: boolean; onChild?: (child: ChildProcess) => void } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: options.cwd, shell: options.shell ?? false, windowsHide: true })
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
  // Grava com outro nome e troca no fim: um download interrompido não deixa um modelo pela metade.
  const partial = `${target}.parte`
  await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(partial))
  await rename(partial, target)
}

/** O pacote do onnxruntime traz os binários de todos os sistemas (quase 300 MB). Ficam só os deste. */
async function pruneRuntime(): Promise<void> {
  const bin = path.join(RUNTIME_DIR, 'bin')
  if (!existsSync(bin)) return
  for (const napi of await readdir(bin)) {
    const napiDir = path.join(bin, napi)
    for (const platform of await readdir(napiDir)) {
      const platformDir = path.join(napiDir, platform)
      if (platform !== process.platform) {
        await rm(platformDir, { recursive: true, force: true })
        continue
      }
      for (const arch of await readdir(platformDir)) {
        if (arch !== process.arch) await rm(path.join(platformDir, arch), { recursive: true, force: true })
      }
    }
  }
}

/** Baixa o motor (onnxruntime, pelo npm) e o modelo. Cerca de 300 MB no total. */
export async function installAligner(onStage?: (stage: string) => void): Promise<void> {
  await mkdir(ALIGNER_DIR, { recursive: true })

  onStage?.('Baixando o motor')
  // Um package.json próprio faz o npm instalar aqui dentro, e não na pasta do projeto.
  await writeFile(path.join(ALIGNER_DIR, 'package.json'), JSON.stringify({ name: 'gogo-aligner', private: true }))
  // --ignore-scripts: o script de instalação do pacote só serve para baixar suporte a placas NVIDIA no Linux.
  const npm = npmCommand()
  await run(npm.command, [...npm.args, 'install', RUNTIME_PACKAGE, '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock', '--loglevel=error'], { cwd: ALIGNER_DIR, shell: npm.shell })
  await pruneRuntime()

  onStage?.('Baixando o modelo')
  await download(`${MODEL_REPO}/vocab.json`, VOCAB_FILE)
  await download(`${MODEL_REPO}/${MODEL_REMOTE}`, MODEL_FILE)

  if (!alignerInstalled()) throw new HelperError(502, 'A instalação da sincronia pelo áudio não ficou completa.')
}

export type AlignStage = 'convertendo' | 'ouvindo' | 'encaixando'

export interface AlignHandle {
  done: Promise<AlignOutcome>
  cancel: () => void
}

/**
 * Sincroniza `lines` com a voz gravada em `audio` (qualquer formato que o ffmpeg leia).
 * `dir` é uma pasta temporária só deste pedido.
 */
export function align(options: {
  audio: string
  dir: string
  ffmpeg: string
  lines: LineInput[]
  onStage: (stage: AlignStage, progress?: number) => void
}): AlignHandle {
  const { audio, dir, ffmpeg, lines, onStage } = options
  let current: ChildProcess | null = null
  let cancelled = false
  const track = (child: ChildProcess) => {
    current = child
    if (cancelled) killTree(child)
  }

  const work = async (): Promise<AlignOutcome> => {
    if (!alignerInstalled()) throw new HelperError(503, 'A sincronia pelo áudio não está instalada.')

    onStage('convertendo')
    // O modelo ouve em 16 kHz, um canal.
    const voice = path.join(dir, 'voice.f32')
    await run(ffmpeg, ['-y', '-loglevel', 'error', '-i', audio, '-vn', '-ac', '1', '-ar', '16000', '-f', 'f32le', voice], { onChild: track })

    const jobFile = path.join(dir, 'job.json')
    const output = path.join(dir, 'result.json')
    await writeFile(jobFile, JSON.stringify({ runtime: ALIGNER_DIR, model: MODEL_FILE, vocab: VOCAB_FILE, voice, output, lines }))

    onStage('ouvindo', 0)
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [WORKER, jobFile], { windowsHide: true })
      track(child)
      let errors = ''
      let pending = ''
      child.stdout.on('data', (chunk: Buffer) => {
        pending += chunk.toString('utf8')
        const parts = pending.split('\n')
        pending = parts.pop() ?? ''
        for (const line of parts) {
          try {
            const event = JSON.parse(line) as { stage?: AlignStage; progress?: number }
            if (event.stage) onStage(event.stage, event.progress)
          } catch {
            // Linha que não é do protocolo (aviso de alguma biblioteca): ignora.
          }
        }
      })
      child.stderr.on('data', (chunk: Buffer) => (errors += chunk.toString('utf8')))
      child.on('error', () => reject(new HelperError(500, 'Não foi possível iniciar a sincronia pelo áudio.')))
      child.on('close', (code) => {
        if (code === 0) return resolve()
        const reason = errors.trim().split(/\r?\n/).filter((line) => !/ExperimentalWarning|trace-warnings/.test(line)).slice(-2).join(' ')
        reject(new HelperError(502, reason || 'A sincronia pelo áudio falhou.'))
      })
    })

    return JSON.parse(await readFile(output, 'utf8')) as AlignOutcome
  }

  return {
    done: work().catch((err: unknown) => {
      throw cancelled ? new HelperError(499, 'Sincronia cancelada.') : err
    }),
    cancel: () => {
      cancelled = true
      if (current) killTree(current)
    },
  }
}
