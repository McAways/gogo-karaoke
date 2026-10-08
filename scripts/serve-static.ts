// Uso: npm run build && node scripts/serve-static.ts [porta]
//
// Serve a pasta dist como um hospedeiro de site estático faria (o Vercel, por exemplo): só
// arquivos, com as rotas do app caindo no index.html, e nada em /api/. É a forma de ver, sem
// publicar, como o app se comporta longe do servidor que traz o ajudante embutido.
//
// Com o ajudante instalado no ar (node helper/server.ts) e este endereço autorizado nele
// (node helper/server.ts permitir http://localhost:<porta>), o app daqui usa aquele ajudante.
import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..', 'dist')
const PORT = Number(process.argv[2] ?? 4173)
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
}

if (!existsSync(path.join(ROOT, 'index.html'))) {
  console.error('A pasta dist não existe. Rode "npm run build" antes.')
  process.exit(1)
}

createServer((req, res) => {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost')
  if (pathname.startsWith('/api/')) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    return void res.end('Nada aqui.')
  }
  let file = path.join(ROOT, decodeURIComponent(pathname))
  // Fora da pasta, inexistente ou uma rota do app: quem responde é o index.html.
  if (!file.startsWith(ROOT) || !existsSync(file) || statSync(file).isDirectory()) file = path.join(ROOT, 'index.html')
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' })
  createReadStream(file).pipe(res)
}).listen(PORT, '127.0.0.1', () => console.log(`Versão publicada (simulada) em http://localhost:${PORT}`))
