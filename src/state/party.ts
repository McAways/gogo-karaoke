import { create } from 'zustand'
import { helperSocketUrl, helperUrl } from '@/lib/helper'
import { nameKey } from '@/lib/scoring/room'
import { useSettings } from './settings'

/**
 * Sala compartilhada, do lado do host. O servidor fica no ajudante (helper/party.ts);
 * aqui o app abre e fecha a sala, acompanha quem entrou e recebe o tom de cada convidado.
 */

export interface PartyInfo {
  running: boolean
  port: number
  /** Endereços que os convidados abrem no celular, um por placa de rede do host. */
  urls: string[]
  guests: string[]
}

/** Recebe as leituras de tom de um convidado. O conteúdo vem da rede e ainda não foi conferido. */
type PitchListener = (name: string, samples: unknown[]) => void

/** Mesmo limite do servidor da sala. */
export const MAX_NAME = 20
/** Código com que o servidor fecha a conexão do host quando outra aba assume a sala. */
const TAKEN_OVER = 4001

interface PartyStore {
  status: 'fechada' | 'abrindo' | 'aberta'
  /** true enquanto a conexão com o servidor da sala está de pé. */
  online: boolean
  error: string | null
  urls: string[]
  guests: string[]
  open: () => Promise<void>
  close: () => Promise<void>
  /** Ao abrir o app: se a sala já estava aberta no ajudante (página recarregada), reconecta. */
  resume: () => Promise<void>
  /** Manda uma mensagem para todos os convidados. */
  broadcast: (message: Record<string, unknown>) => void
  /** O palco se registra aqui para receber as leituras enquanto a música toca. */
  listen: (listener: PitchListener | null) => void
  /** Troca o nome do host no placar. Devolve o motivo quando o nome não pode ser usado. */
  rename: (name: string) => string | null
}

/**
 * Marca, nesta aba, que a sala estava aberta. Quando o servidor do app reinicia, a sala fecha
 * e a página recarrega junto: com a marca, o app reabre a sala em vez de deixar os convidados na mão.
 */
const REOPEN_KEY = 'gogo:sala-aberta'

function remember(open: boolean): void {
  try {
    if (open) sessionStorage.setItem(REOPEN_KEY, '1')
    else sessionStorage.removeItem(REOPEN_KEY)
  } catch {
    // Sem armazenamento (navegação privada restrita): a sala só não reabre sozinha.
  }
}

function wasOpen(): boolean {
  try {
    return sessionStorage.getItem(REOPEN_KEY) === '1'
  } catch {
    return false
  }
}

let socket: WebSocket | null = null
let pitchListener: PitchListener | null = null
let retry = 0

async function call(path: string, method: 'GET' | 'POST'): Promise<PartyInfo> {
  let res: Response
  try {
    res = await fetch(await helperUrl(`/party/${path}`), { method })
  } catch {
    throw new Error('O ajudante não está ativo neste computador.')
  }
  const body = (await res.json().catch(() => null)) as (PartyInfo & { error?: string }) | null
  if (!res.ok || !body) throw new Error(body?.error ?? 'O ajudante não respondeu.')
  return body
}

function send(message: Record<string, unknown>): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
}

export const useParty = create<PartyStore>()((set, get) => {
  const connect = () => {
    socket?.close()
    socket = null
    helperSocketUrl('/party').then(attach, () => {
      if (get().status === 'aberta') retry = window.setTimeout(reconnect, 3000)
    })
  }

  const attach = (url: string) => {
    // Enquanto o endereço do ajudante era procurado, a sala pode ter sido fechada ou outra conexão aberta.
    if (get().status !== 'aberta' || socket) return
    const next = new WebSocket(url)
    socket = next

    next.addEventListener('open', () => {
      if (socket !== next) return
      // O servidor guarda o nome do host para nenhum convidado entrar com o mesmo.
      send({ t: 'host', name: useSettings.getState().hostName })
      set({ online: true })
    })

    next.addEventListener('message', (event) => {
      let message: { t?: string; names?: unknown; name?: unknown; s?: unknown }
      try {
        message = JSON.parse(String(event.data)) as typeof message
      } catch {
        return
      }
      if (message.t === 'guests' && Array.isArray(message.names)) set({ guests: message.names.filter((name): name is string => typeof name === 'string') })
      else if (message.t === 'pitch' && typeof message.name === 'string' && Array.isArray(message.s)) pitchListener?.(message.name, message.s)
    })

    next.addEventListener('close', (event) => {
      if (socket !== next) return
      socket = null
      if (event.code === TAKEN_OVER) {
        // Outra aba do app assumiu a sala: esta para de tentar, senão as duas ficariam se derrubando.
        remember(false)
        return set({ status: 'fechada', online: false, guests: [], urls: [], error: 'A sala passou a ser comandada por outra aba do app.' })
      }
      set({ online: false })
      // A conexão caiu com a sala ainda aberta (o servidor do app reiniciou): tenta voltar.
      if (get().status === 'aberta') retry = window.setTimeout(reconnect, 1500)
    })
  }

  // O servidor do app pode ter reiniciado, e a sala fecha junto com ele: reabre antes de reconectar.
  const reconnect = () => {
    if (get().status !== 'aberta') return
    call('start', 'POST').then(
      (info) => {
        if (get().status !== 'aberta') return
        set({ urls: info.urls, guests: info.guests })
        connect()
      },
      () => {
        if (get().status === 'aberta') retry = window.setTimeout(reconnect, 3000)
      },
    )
  }

  return {
    status: 'fechada',
    online: false,
    error: null,
    urls: [],
    guests: [],

    async open() {
      set({ status: 'abrindo', error: null })
      try {
        const info = await call('start', 'POST')
        set({ status: 'aberta', urls: info.urls, guests: info.guests })
        remember(true)
        connect()
      } catch (err) {
        set({ status: 'fechada', error: err instanceof Error ? err.message : 'Não foi possível abrir a sala.' })
      }
    },

    async close() {
      window.clearTimeout(retry)
      remember(false)
      set({ status: 'fechada', online: false, guests: [], urls: [] })
      socket?.close()
      socket = null
      await call('stop', 'POST').catch(() => null)
    },

    async resume() {
      const info = await call('info', 'GET').catch(() => null)
      if (!info || get().status !== 'fechada') return
      if (info.running) {
        set({ status: 'aberta', urls: info.urls, guests: info.guests })
        remember(true)
        return connect()
      }
      // A sala estava aberta nesta aba e o servidor do app reiniciou: reabre.
      if (wasOpen()) await get().open()
    },

    broadcast: send,

    listen(listener) {
      pitchListener = listener
    },

    rename(name) {
      const clean = name.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME)
      if (!clean) return 'Escreva um nome.'
      const key = nameKey(clean)
      if (get().guests.some((guest) => nameKey(guest) === key)) return 'Já tem alguém na sala com esse nome.'
      useSettings.getState().update({ hostName: clean })
      send({ t: 'host', name: clean })
      return null
    },
  }
})
