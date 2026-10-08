// Processo à parte que faz a sincronia da letra pelo áudio (ver helper/aligner.ts).
//   node align-worker.ts <pedido.json>
// Anda devagar e usa todos os núcleos: por isso fica fora do processo do servidor do app.
// Avisa do andamento pela saída padrão, uma linha de JSON por vez.
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { alignLines } from '../src/lib/align/ctc.ts'
import type { LineInput, Vocab } from '../src/lib/align/ctc.ts'

interface Job {
  /** Pasta onde o onnxruntime foi instalado. */
  runtime: string
  model: string
  vocab: string
  /** Voz em 16 kHz, um canal, amostras float de 32 bits. */
  voice: string
  output: string
  lines: LineInput[]
}

interface Tensor {
  data: Float32Array
  dims: number[]
}
interface Session {
  inputNames: string[]
  outputNames: string[]
  run(feeds: Record<string, unknown>): Promise<Record<string, Tensor>>
}
interface Runtime {
  InferenceSession: { create(file: string, options: Record<string, unknown>): Promise<Session> }
  Tensor: new (type: 'float32', data: Float32Array, dims: number[]) => unknown
}

const RATE = 16_000
/** O modelo dá uma resposta a cada 320 amostras: 50 por segundo. */
const HOP = 320
const FRAME_SECONDS = HOP / RATE
/** Cada janela leva 20 s úteis e 2 s de contexto de cada lado, para as bordas não saírem piores. */
const CORE = 20 * RATE
const CONTEXT = 2 * RATE

const say = (event: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(event)}\n`)

const job = JSON.parse(readFileSync(process.argv[2], 'utf8')) as Job
const ort = createRequire(path.join(job.runtime, 'package.json'))('onnxruntime-node') as Runtime
const vocab = JSON.parse(readFileSync(job.vocab, 'utf8')) as Vocab
const blank = vocab['<blank>'] ?? 0
const classes = Object.keys(vocab).length

const bytes = readFileSync(job.voice)
const voice = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 2).slice()
const frames = Math.floor(voice.length / HOP)

// Onde há voz, pelo volume: serve para esticar a palavra enquanto a nota é segurada.
const level = new Float32Array(frames)
for (let f = 0; f < frames; f++) {
  let energy = 0
  for (let i = f * HOP; i < (f + 1) * HOP; i++) energy += voice[i] * voice[i]
  level[f] = 10 * Math.log10(energy / HOP + 1e-12)
}
const loud = [...level].sort((a, b) => a - b)[Math.floor(frames * 0.95)] ?? -60
const voiced = new Uint8Array(frames)
for (let f = 0; f < frames; f++) voiced[f] = level[f] > Math.max(loud - 28, -55) ? 1 : 0

// O modelo espera o som com média zero e variância um.
let sum = 0
for (let i = 0; i < voice.length; i++) sum += voice[i]
const mean = sum / Math.max(1, voice.length)
let spread = 0
for (let i = 0; i < voice.length; i++) spread += (voice[i] - mean) ** 2
const scale = 1 / Math.sqrt(spread / Math.max(1, voice.length) + 1e-7)
for (let i = 0; i < voice.length; i++) voice[i] = (voice[i] - mean) * scale

// Metade dos processadores lógicos: mais do que os núcleos de verdade deixa mais lento.
const threads = Math.max(2, Math.min(8, Math.floor(os.availableParallelism() / 2)))
const session = await ort.InferenceSession.create(job.model, { intraOpNumThreads: threads, graphOptimizationLevel: 'all' })

// Começa tudo como silêncio certo: o que o modelo não chegar a ouvir (a ponta final) fica assim.
const logProbs = new Float32Array(frames * classes).fill(-20)
for (let f = 0; f < frames; f++) logProbs[f * classes + blank] = 0
for (let start = 0; start < voice.length; start += CORE) {
  const from = Math.max(0, start - CONTEXT)
  const to = Math.min(voice.length, start + CORE + CONTEXT)
  // Menos de meio segundo não rende um quadro confiável: o resto fica como silêncio.
  if (to - from < RATE / 2) break
  const input = new ort.Tensor('float32', voice.subarray(from, to), [1, to - from])
  const output = (await session.run({ [session.inputNames[0]]: input }))[session.outputNames[0]]
  const data = output.data
  const got = output.dims[1]
  const width = output.dims[2]
  const first = Math.floor((start - from) / HOP)
  const last = Math.min(got, first + CORE / HOP)
  for (let f = first; f < last; f++) {
    const global = start / HOP + (f - first)
    if (global >= frames) break
    // log-softmax: transforma a saída crua em log de probabilidade.
    let max = -Infinity
    for (let c = 0; c < width; c++) max = Math.max(max, data[f * width + c])
    let total = 0
    for (let c = 0; c < width; c++) total += Math.exp(data[f * width + c] - max)
    const norm = max + Math.log(total)
    for (let c = 0; c < classes; c++) logProbs[global * classes + c] = data[f * width + c] - norm
  }
  say({ stage: 'ouvindo', progress: Math.min(1, (start + CORE) / voice.length) })
}

say({ stage: 'encaixando' })
const result = alignLines(logProbs, frames, classes, vocab, blank, job.lines, { frameSeconds: FRAME_SECONDS, voiced })
if (!result) {
  process.stderr.write('A letra tem mais texto do que cabe no áudio.\n')
  process.exit(2)
}
writeFileSync(job.output, JSON.stringify(result))
