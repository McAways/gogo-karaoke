// O ajudante rodando sozinho, para o app publicado. Só atende este computador.
//
// Uso: node helper/server.ts                       sobe o ajudante
//      node helper/server.ts permitir <endereço>   autoriza o endereço do app publicado
//      node helper/server.ts esquecer <endereço>   tira um endereço da lista
//      node helper/server.ts sites                 mostra os endereços autorizados
//
// GOGO_HELPER_PORT troca a porta (5175). GOGO_PARTY_PORT troca a da sala (5174).
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { handleRequest, handleUpgrade, prepare, shutdown } from './api.ts'
import { findFfmpeg, findYtDlp } from './binary.ts'
import { allowSite, allowedSites, forgetSite, savedSites } from './sites.ts'

const PORT = Number(process.env.GOGO_HELPER_PORT ?? 5175)
const PREFIX = '/api/helper'

const [command, ...rest] = process.argv.slice(2)

if (command === 'permitir' || command === 'esquecer' || command === 'sites') {
  try {
    if (command === 'permitir') {
      if (rest.length === 0) throw new Error('Diga o endereço do app publicado. Exemplo: permitir https://meu-gogo.vercel.app')
      for (const raw of rest) console.log(`Autorizado: ${await allowSite(raw)}`)
    } else if (command === 'esquecer') {
      for (const raw of rest) console.log((await forgetSite(raw)) ? `Retirado: ${raw}` : `Não estava na lista: ${raw}`)
    }
    const sites = savedSites()
    console.log(sites.length > 0 ? `Endereços que podem usar o ajudante deste computador:\n${sites.map((site) => `  ${site}`).join('\n')}` : 'Nenhum endereço autorizado ainda.')
  } catch (err) {
    console.error(err instanceof Error ? err.message : err)
    process.exitCode = 1
  }
} else if (command) {
  console.error(`Não conheço "${command}". Use: permitir <endereço>, esquecer <endereço>, sites, ou nada para subir o ajudante.`)
  process.exitCode = 1
} else {
  await run()
}

function onRequest(req: IncomingMessage, res: ServerResponse): void {
  const url = req.url ?? '/'
  if (url === PREFIX || url.startsWith(`${PREFIX}/`) || url.startsWith(`${PREFIX}?`)) {
    req.url = url.slice(PREFIX.length) || '/'
    return handleRequest(req, res)
  }
  res.statusCode = url === '/' ? 200 : 404
  res.setHeader('Content-Type', 'text/plain; charset=utf-8')
  res.end(url === '/' ? 'Ajudante do Gogó no ar. Esta página não faz nada: abra o app.\n' : 'Nada aqui.\n')
}

function onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
  if (new URL(req.url ?? '/', 'http://localhost').pathname !== `${PREFIX}/party`) return void socket.destroy()
  handleUpgrade(req, socket, head)
}

/** Sobe num endereço. Devolve null quando o endereço não existe na máquina (IPv6 desligado). */
function listen(host: string): Promise<Server | null> {
  return new Promise((resolve, reject) => {
    const server = createServer(onRequest)
    server.on('upgrade', onUpgrade)
    server.once('error', (err: NodeJS.ErrnoException) => (err.code === 'EADDRNOTAVAIL' || err.code === 'EAFNOSUPPORT' ? resolve(null) : reject(err)))
    server.listen(PORT, host, () => resolve(server))
  })
}

async function alreadyRunning(): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}${PREFIX}/hello`, { signal: AbortSignal.timeout(3000) })
    return ((await res.json()) as { app?: string }).app === 'gogo-ajudante'
  } catch {
    return false
  }
}

async function run(): Promise<void> {
  await prepare('ajudante')

  let servers: Server[]
  try {
    // Só o próprio computador: nem a rede de casa alcança o ajudante. O navegador pode procurar
    // "localhost" pelos dois caminhos (IPv4 e IPv6), então ele atende nos dois.
    servers = (await Promise.all([listen('127.0.0.1'), listen('::1')])).filter((server): server is Server => server !== null)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      if (await alreadyRunning()) return console.log(`O ajudante já está no ar na porta ${PORT}. Nada a fazer.`)
      console.error(`A porta ${PORT} está em uso por outro programa. Feche-o, ou defina GOGO_HELPER_PORT com outra porta.`)
    } else {
      console.error(err instanceof Error ? err.message : err)
    }
    process.exitCode = 1
    return
  }

  const [ytDlp, ffmpeg] = await Promise.all([findYtDlp(), findFfmpeg()])
  const sites = allowedSites()
  console.log(`Ajudante do Gogó no ar em http://localhost:${PORT} (só este computador).`)
  console.log(`  downloader (yt-dlp): ${ytDlp ? ytDlp.version : 'ainda não instalado; o app oferece instalar'}`)
  console.log(`  ffmpeg: ${ffmpeg ? ffmpeg.version : 'NÃO ENCONTRADO. Sem ele não dá para baixar vídeo, separar a voz nem sincronizar pelo áudio'}`)
  console.log(sites.length > 0 ? `  endereços autorizados: ${sites.join(', ')}` : '  nenhum endereço autorizado: rode "permitir https://endereço-do-seu-app" para o app publicado poder usar este ajudante')
  console.log('Deixe esta janela aberta enquanto usa o app. Ctrl+C encerra.')

  let closing = false
  const close = () => {
    if (closing) return
    closing = true
    void shutdown().finally(() => {
      for (const server of servers) {
        server.close()
        server.closeAllConnections()
      }
      process.exit(0)
    })
  }
  process.on('SIGINT', close)
  process.on('SIGTERM', close)
}
