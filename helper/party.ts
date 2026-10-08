import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createServer } from 'node:https'
import type { Server } from 'node:https'
import os from 'node:os'
import path from 'node:path'
import type { Duplex } from 'node:stream'
import { fileURLToPath } from 'node:url'
import * as selfsigned from 'selfsigned'
import { WebSocketServer } from 'ws'
import type { WebSocket } from 'ws'
import { BIN_DIR } from './binary.ts'
import { HelperError } from './ytdlp.ts'

/**
 * Sala compartilhada: cada convidado entra pelo celular, na mesma rede, e o celular
 * vira o sensor de tom daquela pessoa. O som da música continua saindo só do host.
 *
 * São duas portas de entrada, de propósito:
 *
 * - o HOST fala por WebSocket com o próprio servidor do Vite (http://localhost:5173),
 *   para não mudar de origem e perder a biblioteca guardada no navegador;
 * - os CONVIDADOS entram por um servidor HTTPS separado (porta 5174), porque navegador
 *   de celular só libera o microfone em página segura. Esse servidor entrega apenas a
 *   página do convidado e o WebSocket: o app e o downloader não ficam expostos na rede.
 *
 * Este módulo só repassa mensagens e garante que não haja dois convidados com o mesmo nome.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const GUEST_DIR = path.join(HERE, 'guest')
const FONT_FILE = path.join(HERE, '..', 'node_modules', '@fontsource-variable', 'mona-sans', 'files', 'mona-sans-latin-wdth-normal.woff2')
const CERT_FILE = path.join(BIN_DIR, 'party-cert.json')

export const PARTY_PORT = Number(process.env.GOGO_PARTY_PORT) || 5174
const MAX_GUESTS = 12
const MAX_NAME = 20
const OPEN = 1
/** Código de fechamento do WebSocket do host quando outra aba do app assume a sala. */
const TAKEN_OVER = 4001

const STATIC: Record<string, { file: string; type: string }> = {
  '/': { file: path.join(GUEST_DIR, 'index.html'), type: 'text/html; charset=utf-8' },
  '/guest.js': { file: path.join(GUEST_DIR, 'guest.js'), type: 'text/javascript; charset=utf-8' },
  '/guest.css': { file: path.join(GUEST_DIR, 'guest.css'), type: 'text/css; charset=utf-8' },
  '/fonte.woff2': { file: FONT_FILE, type: 'font/woff2' },
}

interface Guest {
  name: string
  /** Identificador que o navegador do convidado guarda: permite voltar com o mesmo nome se a conexão cair. */
  id: string
  link: Link
}

/**
 * Canal com um convidado. O normal é WebSocket. Há celulares que recusam WebSocket com
 * certificado feito em casa mesmo depois de a pessoa aceitar o aviso da página; para eles
 * o mesmo canal é montado com requisições comuns (ver `openEventStream` e `receiveMessage`).
 */
interface Link {
  readonly alive: boolean
  send(text: string): void
  close(): void
}

/** Chave = nome sem acento, caixa nem espaços repetidos. "Ana", "ana " e "ANA" são a mesma pessoa. */
const guests = new Map<string, Guest>()
const guestSockets = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 })
const hostSockets = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 })
let host: WebSocket | null = null
/** Chave do nome que o host usa no placar: nenhum convidado pode entrar com ele. */
let hostKey = ''
let lastState: string | null = null
let server: Server | null = null

export function nameKey(name: string): string {
  return name
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

function send(socket: WebSocket, message: Record<string, unknown>): void {
  if (socket.readyState === OPEN) socket.send(JSON.stringify(message))
}

function tell(link: Link, message: Record<string, unknown>): void {
  link.send(JSON.stringify(message))
}

function guestNames(): string[] {
  return [...guests.values()].map((g) => g.name)
}

function announceGuests(): void {
  if (host) send(host, { t: 'guests', names: guestNames() })
}

function parse(raw: unknown): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(String(raw))
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** Liga um canal recém-aberto à sala. Devolve o que fazer com cada mensagem e com o fechamento. */
function attachGuest(link: Link): { receive: (raw: unknown) => void; closed: () => void } {
  let key: string | null = null

  const receive = (raw: unknown): void => {
    const message = parse(raw)
    if (!message) return

    if (message.t === 'ping') return tell(link, { t: 'pong', c: message.c, s: Date.now() })

    if (message.t === 'join') {
      const name = String(message.name ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME)
      const id = String(message.id ?? '').slice(0, 64)
      const wanted = nameKey(name)
      if (!wanted) return tell(link, { t: 'refused', reason: 'nome-invalido' })
      if (!host) return tell(link, { t: 'refused', reason: 'sem-host' })
      if (wanted === hostKey) return tell(link, { t: 'refused', reason: 'nome-em-uso' })

      const taken = guests.get(wanted)
      // O mesmo aparelho voltando (conexão caiu, tela bloqueou) retoma o próprio nome.
      const sameDevice = taken !== undefined && (taken.link === link || (id !== '' && taken.id === id) || !taken.link.alive)
      if (taken && !sameDevice) return tell(link, { t: 'refused', reason: 'nome-em-uso' })
      if (!taken && guests.size >= MAX_GUESTS) return tell(link, { t: 'refused', reason: 'sala-cheia' })

      if (taken && taken.link !== link) taken.link.close()
      if (key && key !== wanted) guests.delete(key)
      key = wanted
      guests.set(wanted, { name, id, link })
      tell(link, { t: 'joined', name })
      if (lastState) link.send(lastState)
      return announceGuests()
    }

    if (message.t === 'pitch' && key && host && Array.isArray(message.s)) {
      send(host, { t: 'pitch', name: guests.get(key)?.name, s: message.s.slice(0, 64) })
    }
  }

  const closed = (): void => {
    if (key && guests.get(key)?.link === link) {
      guests.delete(key)
      announceGuests()
    }
  }

  return { receive, closed }
}

guestSockets.on('connection', (socket: WebSocket) => {
  const link: Link = {
    get alive() {
      return socket.readyState === OPEN
    },
    send(text) {
      if (socket.readyState === OPEN) socket.send(text)
    },
    close() {
      socket.close()
    },
  }
  const guest = attachGuest(link)
  socket.on('message', (raw) => guest.receive(raw))
  socket.on('close', guest.closed)
})

/** Canais abertos por requisições comuns. A chave é o identificador que o celular sorteia a cada conexão. */
const httpLinks = new Map<string, { link: Link; receive: (raw: unknown) => void }>()
const LINK_ID = /^[\w-]{8,64}$/

/** Servidor para convidado, como fluxo de eventos (SSE): cada mensagem vai numa linha `data:`. */
function openEventStream(res: ServerResponse, id: string): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store' })
  res.write(':ok\n\n')
  let alive = true
  const link: Link = {
    get alive() {
      return alive
    },
    send(text) {
      if (alive) res.write(`data: ${text}\n\n`)
    },
    close() {
      if (!alive) return
      alive = false
      res.end()
    },
  }
  const guest = attachGuest(link)
  httpLinks.get(id)?.link.close()
  httpLinks.set(id, { link, receive: guest.receive })
  // Uma linha de comentário de tempos em tempos impede que a conexão parada seja cortada no caminho.
  const heartbeat = setInterval(() => {
    if (alive) res.write(':\n\n')
  }, 20_000)
  res.on('close', () => {
    alive = false
    clearInterval(heartbeat)
    if (httpLinks.get(id)?.link === link) httpLinks.delete(id)
    guest.closed()
  })
}

/** Convidado para servidor: uma mensagem por requisição. */
async function receiveMessage(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
  const entry = httpLinks.get(id)
  if (!entry) {
    // O fluxo de eventos deste celular caiu: 410 avisa a página para abrir outro.
    res.statusCode = 410
    return void res.end()
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > 32 * 1024) {
      res.statusCode = 413
      return void res.end()
    }
    chunks.push(chunk as Buffer)
  }
  entry.receive(Buffer.concat(chunks).toString('utf8'))
  res.statusCode = 204
  res.end()
}

/** Só a própria página do convidado conversa com a sala: outro site aberto no celular não entra. */
function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (!origin) return true
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

hostSockets.on('connection', (socket: WebSocket) => {
  // Uma sala, um host: abrir o app em outra aba assume o controle. O código avisa a aba
  // antiga de que não é para reconectar, senão as duas ficariam se derrubando.
  if (host && host !== socket) host.close(TAKEN_OVER, 'outra-aba')
  host = socket
  send(socket, { t: 'guests', names: guestNames() })
  // Quem ficou vendo "o host saiu" (página recarregada) volta a esperar a próxima música.
  for (const guest of guests.values()) tell(guest.link, { t: 'state', phase: 'aguardando' })

  socket.on('message', (raw) => {
    const message = parse(raw)
    if (!message) return
    if (message.t === 'host') return void (hostKey = nameKey(String(message.name ?? '')))
    // Reescrito daqui: garante uma linha só, que é o que o fluxo de eventos exige.
    const text = JSON.stringify(message)
    if (message.t === 'state') lastState = text
    if (message.t === 'state' || message.t === 'tick' || message.t === 'scores') {
      for (const guest of guests.values()) guest.link.send(text)
    }
  })

  socket.on('close', () => {
    if (host !== socket) return
    host = null
    hostKey = ''
    lastState = null
    for (const guest of guests.values()) tell(guest.link, { t: 'state', phase: 'sem-host' })
  })
})

/** Liga o WebSocket do host ao servidor do Vite. Chamado pelo plugin no evento `upgrade`. */
export function acceptHost(req: IncomingMessage, socket: Duplex, head: Buffer): void {
  hostSockets.handleUpgrade(req, socket, head, (ws) => hostSockets.emit('connection', ws, req))
}

/** Placas de rede de máquinas virtuais e contêineres: existem só dentro deste computador. */
const VIRTUAL_ADAPTER = /vethernet|wsl|hyper-v|virtualbox|vmware|docker|loopback|bluetooth/i

/** Todos os endereços IPv4 deste computador, para o certificado. */
function allAddresses(): Array<{ adapter: string; ip: string }> {
  const found: Array<{ adapter: string; ip: string }> = []
  for (const [adapter, list] of Object.entries(os.networkInterfaces())) {
    for (const address of list ?? []) {
      if (address.family === 'IPv4' && !address.internal && !address.address.startsWith('169.254.')) found.push({ adapter, ip: address.address })
    }
  }
  return found
}

/** Endereços em que um celular consegue chegar, o mais provável primeiro. */
function lanAddresses(): string[] {
  const all = allAddresses()
  const real = all.filter(({ adapter }) => !VIRTUAL_ADAPTER.test(adapter))
  // Redes domésticas primeiro: é onde os celulares costumam estar.
  const rank = (ip: string) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : 2)
  return (real.length > 0 ? real : all).map(({ ip }) => ip).sort((a, b) => rank(a) - rank(b))
}

async function certificate(): Promise<{ key: string; cert: string }> {
  if (existsSync(CERT_FILE)) {
    try {
      return JSON.parse(await readFile(CERT_FILE, 'utf8')) as { key: string; cert: string }
    } catch {
      // Arquivo corrompido: gera outro.
    }
  }
  // O pacote é CommonJS: conforme quem carrega, `generate` vem direto ou dentro de `default`.
  const generate = selfsigned.generate ?? (selfsigned as unknown as { default: typeof selfsigned }).default.generate
  // Tipo 2 = nome de domínio, tipo 7 = endereço IP.
  const altNames: Array<{ type: 2; value: string } | { type: 7; ip: string }> = [
    { type: 2, value: 'localhost' },
    { type: 7, ip: '127.0.0.1' },
    ...allAddresses().map(({ ip }) => ({ type: 7 as const, ip })),
  ]
  const pems = await generate([{ name: 'commonName', value: 'Gogo Karaoke (rede local)' }], {
    // Dez anos: é um certificado de uso doméstico, e trocá-lo obriga todo celular a aceitar o aviso de novo.
    notAfterDate: new Date(Date.now() + 3650 * 24 * 60 * 60 * 1000),
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [{ name: 'subjectAltName', altNames }],
  })
  const pair = { key: pems.private, cert: pems.cert }
  await mkdir(BIN_DIR, { recursive: true })
  await writeFile(CERT_FILE, JSON.stringify(pair))
  return pair
}

function serveGuestPage(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', 'https://sala')
  const pathname = url.pathname

  if (pathname === '/eventos' || pathname === '/mensagem') {
    const id = url.searchParams.get('c') ?? ''
    if (!LINK_ID.test(id) || !sameOrigin(req)) {
      res.statusCode = 400
      return void res.end()
    }
    if (pathname === '/eventos' && req.method === 'GET') return openEventStream(res, id)
    if (pathname === '/mensagem' && req.method === 'POST') return void receiveMessage(req, res, id).catch(() => res.destroy())
    res.statusCode = 405
    return void res.end()
  }

  const entry = STATIC[pathname]
  if (!entry || req.method !== 'GET') {
    res.statusCode = 404
    return void res.end('Nada aqui.')
  }
  readFile(entry.file).then(
    (body) => {
      res.statusCode = 200
      res.setHeader('Content-Type', entry.type)
      res.setHeader('Cache-Control', 'no-store')
      res.setHeader('X-Content-Type-Options', 'nosniff')
      res.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self' wss:; img-src 'self' data:")
      res.end(body)
    },
    () => {
      res.statusCode = 500
      res.end('Arquivo da sala não encontrado.')
    },
  )
}

export interface PartyInfo {
  running: boolean
  port: number
  /** Endereços para os convidados abrirem, um por placa de rede. */
  urls: string[]
  guests: string[]
}

export function partyInfo(): PartyInfo {
  return { running: server !== null, port: PARTY_PORT, urls: lanAddresses().map((ip) => `https://${ip}:${PARTY_PORT}`), guests: guestNames() }
}

export async function startParty(): Promise<PartyInfo> {
  if (server) return partyInfo()
  const { key, cert } = await certificate()
  const next = createServer({ key, cert }, serveGuestPage)
  next.on('upgrade', (req, socket, head) => {
    if (new URL(req.url ?? '/', 'https://sala').pathname !== '/ws' || !sameOrigin(req)) return void socket.destroy()
    guestSockets.handleUpgrade(req, socket, head, (ws) => guestSockets.emit('connection', ws, req))
  })

  await new Promise<void>((resolve, reject) => {
    next.once('error', (err: NodeJS.ErrnoException) =>
      reject(new HelperError(500, err.code === 'EADDRINUSE' ? `A porta ${PARTY_PORT} já está em uso por outro programa.` : 'Não foi possível abrir a sala na rede.')),
    )
    next.listen(PARTY_PORT, '0.0.0.0', resolve)
  })
  server = next
  return partyInfo()
}

export async function stopParty(): Promise<PartyInfo> {
  for (const guest of guests.values()) guest.link.close()
  guests.clear()
  for (const { link } of httpLinks.values()) link.close()
  httpLinks.clear()
  lastState = null
  const current = server
  server = null
  if (current) {
    await new Promise<void>((resolve) => {
      current.close(() => resolve())
      current.closeAllConnections()
    })
  }
  return partyInfo()
}
