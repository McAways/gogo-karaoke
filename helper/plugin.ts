import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'
import type { Plugin } from 'vite'
import { handleRequest, handleUpgrade, prepare, shutdown } from './api.ts'

const PREFIX = '/api/helper'

/**
 * O ajudante embutido no servidor do Vite (dev e preview): quem abre o app pela pasta do
 * projeto não precisa subir um segundo processo. As rotas ficam em helper/api.ts; o mesmo
 * ajudante roda sozinho, para o app publicado, por helper/server.ts.
 */
export function helperPlugin(): Plugin {
  return {
    name: 'gogo-helper',
    configureServer(server) {
      void prepare('app')
      server.middlewares.use(PREFIX, handleRequest)
      attachParty(server.httpServer as Server | null)
    },
    configurePreviewServer(server) {
      void prepare('app')
      server.middlewares.use(PREFIX, handleRequest)
      attachParty(server.httpServer as Server | null)
    },
  }
}

/**
 * O host da sala conversa por WebSocket neste mesmo servidor. O Vite usa WebSocket
 * para o recarregamento automático, então só o nosso caminho é atendido aqui.
 */
function attachParty(httpServer: Server | null): void {
  if (!httpServer) return
  httpServer.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (new URL(req.url ?? '/', 'http://localhost').pathname !== `${PREFIX}/party`) return
    handleUpgrade(req, socket, head)
  })
  // Reiniciar ou fechar o servidor do app fecha a sala junto, senão a porta dela ficaria presa.
  httpServer.on('close', () => void shutdown())
}
