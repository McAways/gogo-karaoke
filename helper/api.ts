import { createReadStream, createWriteStream, existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rename, rm, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { decideAccess, helloAccess } from './access.ts'
import { findFfmpeg, findYtDlp, installFfmpeg, updateYtDlp } from './binary.ts'
import type { ToolInfo } from './binary.ts'
import { align, alignerInstalled, installAligner } from './aligner.ts'
import { acceptHost, partyInfo, startParty, stopParty } from './party.ts'
import { installSeparator, separate, separatorInstalled } from './separator.ts'
import { allowedSites } from './sites.ts'
import { spotifyTracks } from './spotify.ts'
import { HelperError, download, info, search } from './ytdlp.ts'
import type { DownloadHandle, MediaKind } from './ytdlp.ts'

/**
 * Ajudante local do karaoke: a única parte do sistema que não roda no navegador. Existe porque
 * o navegador não consegue baixar mídia do YouTube, separar a voz nem medir a letra no áudio.
 *
 * Aqui ficam as rotas. Quem as põe no ar é um dos dois:
 *   - helper/plugin.ts, dentro do servidor do Vite (o app aberto pela pasta do projeto);
 *   - helper/server.ts, um servidor só dele (o ajudante instalado, para o app publicado).
 */

/** Cada jeito de rodar tem a sua pasta temporária: os dois podem estar no ar na mesma máquina. */
export type HelperRole = 'app' | 'ajudante'

const TEMP_BASE = path.join(os.tmpdir(), 'gogo-karaoke')
let TEMP_ROOT = path.join(TEMP_BASE, 'app')
const FILE_TTL_MS = 30 * 60_000
const IMAGE_HOSTS = /(^|\.)(ytimg\.com|ggpht\.com|googleusercontent\.com)$/i

/** Chamado uma vez ao subir: limpa o que sobrou da última vez, sem tocar na pasta do outro papel. */
export async function prepare(role: HelperRole): Promise<void> {
  TEMP_ROOT = path.join(TEMP_BASE, role)
  const other: HelperRole = role === 'app' ? 'ajudante' : 'app'
  for (const name of await readdir(TEMP_BASE).catch(() => [])) {
    if (name !== other) await rm(path.join(TEMP_BASE, name), { recursive: true, force: true })
  }
  await mkdir(TEMP_ROOT, { recursive: true })
}

/** Uma pasta nova para um trabalho. Cria a raiz se ela ainda não existir (pedido que chega logo ao subir). */
async function tempDir(prefix: string): Promise<string> {
  await mkdir(TEMP_ROOT, { recursive: true })
  return mkdtemp(path.join(TEMP_ROOT, prefix))
}

/** Fecha o que o ajudante abriu na rede (a sala), senão a porta dela ficaria presa. */
export async function shutdown(): Promise<void> {
  await stopParty()
}

/** O host da sala conversa por WebSocket. Quem chama já conferiu o caminho; aqui se confere quem pede. */
export function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
  if (!decideAccess(req.headers, allowedSites()).trusted) return void socket.destroy()
  acceptHost(req, socket, head)
}

interface ReadyFile {
  dir: string
  file: string
  mime: string
  size: number
  timer: NodeJS.Timeout
}

const readyFiles = new Map<string, ReadyFile>()

interface Tools {
  ytDlp: ToolInfo | null
  ffmpeg: ToolInfo | null
}

let toolsPromise: Promise<Tools> | null = null

function getTools(refresh = false): Promise<Tools> {
  if (!toolsPromise || refresh) {
    toolsPromise = Promise.all([findYtDlp(), findFfmpeg()]).then(([ytDlp, ffmpeg]) => ({ ytDlp, ffmpeg }))
  }
  return toolsPromise
}

async function requireYtDlp(): Promise<{ bin: string; ffmpeg: string | null }> {
  const tools = await getTools()
  if (!tools.ytDlp) throw new HelperError(503, 'O yt-dlp não foi encontrado. Rode "npm run ytdlp:update" na pasta do projeto.')
  return { bin: tools.ytDlp.path, ffmpeg: tools.ffmpeg?.path ?? null }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(body))
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > 64_000) throw new HelperError(413, 'Requisição grande demais.')
    chunks.push(chunk as Buffer)
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    throw new HelperError(400, 'JSON inválido.')
  }
}

/** Atende um pedido. `req.url` já vem sem o prefixo /api/helper. */
export function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  handle(req, res).catch((err: unknown) => {
    if (res.headersSent) return void res.end()
    const status = err instanceof HelperError ? err.status : 500
    const message = err instanceof Error ? err.message : 'Erro inesperado no ajudante.'
    sendJson(res, status, { error: message })
  })
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const route = `${req.method} ${url.pathname}`
  const sites = allowedSites()

  // Qualquer página pode perguntar se há um ajudante aqui e se ele confia nela. É tudo o que ela fica sabendo.
  if (url.pathname === '/hello') {
    const hello = helloAccess(req.headers, sites)
    if (!hello) throw new HelperError(403, 'Origem não permitida.')
    for (const [name, value] of Object.entries(hello.cors)) res.setHeader(name, value)
    if (req.method === 'OPTIONS') return void res.writeHead(204).end()
    if (req.method === 'GET') return sendJson(res, 200, { app: 'gogo-ajudante', allowed: hello.allowed })
  }

  const access = decideAccess(req.headers, sites)
  if (!access.trusted) throw new HelperError(403, 'Origem não permitida.')
  // Pedido de um endereço autorizado: o navegador só entrega a resposta à página com estes cabeçalhos.
  for (const [name, value] of Object.entries(access.cors)) res.setHeader(name, value)
  // A consulta que o navegador faz antes de um pedido vindo de outro endereço: bastam os cabeçalhos.
  if (req.method === 'OPTIONS') return void res.writeHead(204).end()

  if (route === 'GET /status') return sendJson(res, 200, await status())

  if (route === 'POST /update') {
    await updateYtDlp()
    await getTools(true)
    return sendJson(res, 200, await status())
  }

  if (route === 'GET /search') {
    const { bin } = await requireYtDlp()
    return sendJson(res, 200, { results: await search(bin, url.searchParams.get('q') ?? '') })
  }

  if (route === 'GET /info') {
    const { bin } = await requireYtDlp()
    return sendJson(res, 200, await info(bin, url.searchParams.get('url') ?? ''))
  }

  if (route === 'POST /download') return startDownload(req, res)

  if (route === 'GET /spotify/link') return sendJson(res, 200, await spotifyTracks(url.searchParams.get('url') ?? ''))

  if (route === 'POST /ffmpeg/install') {
    await installFfmpegOnce()
    await getTools(true)
    return sendJson(res, 200, await status())
  }

  if (route === 'POST /separator/install') {
    await installSeparatorOnce()
    return sendJson(res, 200, await status())
  }

  if (route === 'POST /separate') return startSeparation(req, res, url.searchParams.get('ext') ?? '')

  if (route === 'POST /aligner/install') {
    await installAlignerOnce()
    return sendJson(res, 200, await status())
  }

  if (route === 'POST /align') return startAlignment(req, res, url.searchParams.get('ext') ?? '')

  if (route === 'GET /party/info') return sendJson(res, 200, partyInfo())
  if (route === 'POST /party/start') return sendJson(res, 200, await startParty())
  if (route === 'POST /party/stop') return sendJson(res, 200, await stopParty())

  if (route === 'GET /image') return proxyImage(url.searchParams.get('url') ?? '', res)

  if (url.pathname.startsWith('/file/')) {
    const id = url.pathname.slice('/file/'.length)
    if (req.method === 'GET') return serveFile(id, res)
    if (req.method === 'DELETE') {
      await discard(id)
      return sendJson(res, 200, { ok: true })
    }
  }

  throw new HelperError(404, 'Rota desconhecida.')
}

/**
 * A marca do pacote instalado (quem monta o pacote grava em pacote.json). O app a compara com a
 * do pacote que ele oferece para baixar e avisa quando há um mais novo. 'projeto' = rodando da
 * pasta do projeto, onde não há pacote para atualizar.
 */
const BUILD = ((): string | null => {
  const root = path.resolve(import.meta.dirname, '..')
  try {
    const { versao } = JSON.parse(readFileSync(path.join(root, 'pacote.json'), 'utf8')) as { versao?: unknown }
    if (typeof versao === 'string') return versao
  } catch {
    // Sem o arquivo: é a pasta do projeto, ou um pacote de antes de a marca existir.
  }
  return existsSync(path.join(root, 'vite.config.ts')) ? 'projeto' : null
})()

async function status() {
  const tools = await getTools()
  return {
    ok: true,
    build: BUILD,
    ytDlp: tools.ytDlp && { version: tools.ytDlp.version, source: tools.ytDlp.source },
    ffmpeg: tools.ffmpeg && { version: tools.ffmpeg.version },
    separator: { installed: separatorInstalled() },
    aligner: { installed: alignerInstalled() },
  }
}

let installingFfmpeg: Promise<unknown> | null = null

/** Baixa o ffmpeg próprio do ajudante, para a máquina que não tem um. Dois cliques não baixam duas vezes. */
function installFfmpegOnce(): Promise<unknown> {
  installingFfmpeg ??= installFfmpeg()
    .catch((err: unknown) => {
      throw new HelperError(502, err instanceof Error ? err.message : 'Não foi possível instalar o ffmpeg.')
    })
    .finally(() => {
      installingFfmpeg = null
    })
  return installingFfmpeg
}

let installingAligner: Promise<void> | null = null

function installAlignerOnce(): Promise<void> {
  installingAligner ??= installAligner().finally(() => {
    installingAligner = null
  })
  return installingAligner
}

let installing: Promise<void> | null = null

/** Dois cliques em "instalar" não podem baixar o pacote duas vezes ao mesmo tempo. */
function installSeparatorOnce(): Promise<void> {
  installing ??= installSeparator().finally(() => {
    installing = null
  })
  return installing
}

/** Registra um arquivo pronto para ser buscado uma única vez pelo navegador. */
async function publish(file: string, mime: string): Promise<{ fileId: string; size: number }> {
  // Cada arquivo em sua própria pasta: buscar um não pode apagar o outro.
  const dir = await tempDir('out-')
  const target = path.join(dir, path.basename(file))
  await rename(file, target)
  const { size } = await stat(target)
  const fileId = randomUUID()
  const timer = setTimeout(() => void discard(fileId), FILE_TTL_MS)
  timer.unref()
  readyFiles.set(fileId, { dir, file: target, mime, size, timer })
  return { fileId, size }
}

const SAFE_EXTENSION = /^[a-z0-9]{2,5}$/

/**
 * Recebe o arquivo da música no corpo da requisição e devolve, em NDJSON, o andamento
 * e os ids das duas faixas (instrumental e voz).
 */
async function startSeparation(req: IncomingMessage, res: ServerResponse, extension: string): Promise<void> {
  if (!SAFE_EXTENSION.test(extension)) throw new HelperError(400, 'Extensão de arquivo inválida.')
  if (!separatorInstalled()) throw new HelperError(503, 'O separador de voz não está instalado.')
  const tools = await getTools()
  if (!tools.ffmpeg) throw new HelperError(503, 'A separação de voz precisa do ffmpeg instalado.')

  const dir = await tempDir('sep-')
  const input = path.join(dir, `input.${extension}`)
  try {
    await pipeline(req, createWriteStream(input))
  } catch {
    await rm(dir, { recursive: true, force: true })
    throw new HelperError(400, 'O envio do arquivo foi interrompido.')
  }

  res.statusCode = 200
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Accel-Buffering', 'no')
  const emit = (event: Record<string, unknown>) => {
    if (!res.writableEnded) res.write(`${JSON.stringify(event)}\n`)
  }

  let settled = false
  const job = separate({ input, dir, ffmpeg: tools.ffmpeg.path, onStage: (stage) => emit({ type: 'stage', stage }) })
  res.on('close', () => {
    if (!settled) job.cancel()
  })

  try {
    const stems = await job.done
    const instrumental = await publish(stems.instrumental, 'audio/mp4')
    const vocals = await publish(stems.vocals, 'audio/mp4')
    settled = true
    emit({ type: 'done', instrumental, vocals })
  } catch (err) {
    settled = true
    emit({ type: 'error', message: err instanceof Error ? err.message : 'A separação falhou.' })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
  res.end()
}

/**
 * Lê um corpo em duas partes: 4 bytes com o tamanho do cabeçalho, o cabeçalho em JSON e,
 * colado nele, o arquivo. O arquivo vai direto para o disco, sem passar inteiro pela memória.
 */
async function receiveFramed(req: IncomingMessage, target: string): Promise<Record<string, unknown>> {
  const out = createWriteStream(target)
  let pending: Buffer[] = []
  let have = 0
  let need = -1
  let header: Record<string, unknown> | null = null
  try {
    for await (const chunk of req) {
      const data = chunk as Buffer
      if (header) {
        if (!out.write(data)) await new Promise((resolve) => out.once('drain', resolve))
        continue
      }
      pending.push(data)
      have += data.length
      if (need < 0 && have >= 4) {
        need = Buffer.concat(pending).readUInt32LE(0)
        if (need > 4_000_000) throw new HelperError(413, 'Letra grande demais.')
      }
      if (need >= 0 && have >= 4 + need) {
        const all = Buffer.concat(pending)
        const parsed: unknown = JSON.parse(all.subarray(4, 4 + need).toString('utf8'))
        if (!parsed || typeof parsed !== 'object') throw new HelperError(400, 'Pedido inválido.')
        header = parsed as Record<string, unknown>
        pending = []
        if (all.length > 4 + need) out.write(all.subarray(4 + need))
      }
    }
  } catch (err) {
    out.destroy()
    throw err instanceof HelperError ? err : new HelperError(400, 'O envio do arquivo foi interrompido.')
  }
  await new Promise<void>((resolve, reject) => {
    out.on('error', reject)
    out.end(resolve)
  })
  if (!header) throw new HelperError(400, 'Pedido incompleto.')
  return header
}

/**
 * Recebe a letra e a faixa de voz e devolve, em NDJSON, o andamento e o tempo de cada
 * linha e de cada palavra.
 */
async function startAlignment(req: IncomingMessage, res: ServerResponse, extension: string): Promise<void> {
  if (!SAFE_EXTENSION.test(extension)) throw new HelperError(400, 'Extensão de arquivo inválida.')
  if (!alignerInstalled()) throw new HelperError(503, 'A sincronia pelo áudio não está instalada.')
  const tools = await getTools()
  if (!tools.ffmpeg) throw new HelperError(503, 'A sincronia pelo áudio precisa do ffmpeg instalado.')

  const dir = await tempDir('align-')
  const input = path.join(dir, `input.${extension}`)
  let lines: Array<{ words: string[]; reference: number | null }>
  try {
    const header = await receiveFramed(req, input)
    const raw = Array.isArray(header.lines) ? header.lines : []
    lines = raw.slice(0, 2000).map((line) => {
      const entry = (line ?? {}) as { words?: unknown; reference?: unknown }
      const words = Array.isArray(entry.words) ? entry.words.slice(0, 200).map((word) => String(word).slice(0, 80)) : []
      return { words, reference: typeof entry.reference === 'number' && Number.isFinite(entry.reference) ? entry.reference : null }
    })
    if (lines.length === 0) throw new HelperError(400, 'A letra veio vazia.')
  } catch (err) {
    await rm(dir, { recursive: true, force: true })
    throw err
  }

  res.statusCode = 200
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Accel-Buffering', 'no')
  const emit = (event: Record<string, unknown>) => {
    if (!res.writableEnded) res.write(`${JSON.stringify(event)}\n`)
  }

  let settled = false
  const job = align({ audio: input, dir, ffmpeg: tools.ffmpeg.path, lines, onStage: (stage, progress) => emit({ type: 'stage', stage, progress }) })
  res.on('close', () => {
    if (!settled) job.cancel()
  })

  try {
    const result = await job.done
    settled = true
    emit({ type: 'done', result })
  } catch (err) {
    settled = true
    emit({ type: 'error', message: err instanceof Error ? err.message : 'A sincronia pelo áudio falhou.' })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
  res.end()
}

async function discard(id: string): Promise<void> {
  const entry = readyFiles.get(id)
  if (!entry) return
  clearTimeout(entry.timer)
  readyFiles.delete(id)
  await rm(entry.dir, { recursive: true, force: true })
}

/** Resposta em NDJSON: uma linha por evento, para o front mostrar o progresso ao vivo. */
async function startDownload(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req)
  const kind: MediaKind = body.kind === 'video' ? 'video' : 'audio'
  const target = typeof body.url === 'string' ? body.url : ''
  const { bin, ffmpeg } = await requireYtDlp()

  const dir = await tempDir('job-')
  let settled = false
  let lastSent = 0
  let lastAttempt = 1

  const emit = (event: Record<string, unknown>) => {
    if (!res.writableEnded) res.write(`${JSON.stringify(event)}\n`)
  }

  let job: DownloadHandle
  try {
    job = download({
      bin,
      ffmpeg,
      url: target,
      kind,
      dir,
      onProgress: (progress) => {
        const now = Date.now()
        // O aviso de nova tentativa passa sempre; o andamento, no máximo a cada 150 ms.
        if (progress.attempt === lastAttempt && now - lastSent < 150) return
        lastAttempt = progress.attempt
        lastSent = now
        emit({ type: 'progress', ...progress })
      },
    })
  } catch (err) {
    await rm(dir, { recursive: true, force: true })
    throw err
  }

  res.statusCode = 200
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Accel-Buffering', 'no')
  emit({ type: 'start', kind })

  res.on('close', () => {
    if (settled) return
    job.cancel()
  })

  try {
    const result = await job.done
    settled = true
    const fileId = randomUUID()
    const timer = setTimeout(() => void discard(fileId), FILE_TTL_MS)
    timer.unref()
    readyFiles.set(fileId, { dir, file: result.file, mime: result.mime, size: result.size, timer })
    emit({ type: 'done', fileId, size: result.size, mime: result.mime, ext: result.ext, info: result.info })
  } catch (err) {
    settled = true
    await rm(dir, { recursive: true, force: true })
    emit({ type: 'error', message: err instanceof Error ? err.message : 'O download falhou.' })
  }
  res.end()
}

function serveFile(id: string, res: ServerResponse): void {
  const entry = readyFiles.get(id)
  if (!entry) throw new HelperError(404, 'Esse arquivo já expirou. Baixe a música de novo.')

  res.statusCode = 200
  res.setHeader('Content-Type', entry.mime)
  res.setHeader('Content-Length', String(entry.size))
  res.setHeader('Cache-Control', 'no-store')

  const stream = createReadStream(entry.file)
  stream.on('error', () => res.destroy())
  // O arquivo é de uso único: o navegador guarda a cópia dele no OPFS.
  res.on('close', () => {
    stream.destroy()
    void discard(id)
  })
  stream.pipe(res)
}

async function proxyImage(raw: string, res: ServerResponse): Promise<void> {
  let target: URL
  try {
    target = new URL(raw)
  } catch {
    throw new HelperError(400, 'Endereço de imagem inválido.')
  }
  if (target.protocol !== 'https:' || !IMAGE_HOSTS.test(target.hostname)) throw new HelperError(400, 'Host de imagem não permitido.')

  const upstream = await fetch(target, { signal: AbortSignal.timeout(15_000) })
  const type = upstream.headers.get('content-type') ?? ''
  if (!upstream.ok || !upstream.body || !type.startsWith('image/')) throw new HelperError(502, 'A capa não pôde ser carregada.')

  res.statusCode = 200
  res.setHeader('Content-Type', type)
  res.setHeader('Cache-Control', 'private, max-age=86400')
  Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]).pipe(res)
}
