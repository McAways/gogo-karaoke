// Uso: npm run helper:pack [-- --site=https://meu-gogo.vercel.app]
//
// Monta em dist-helper/gogo-ajudante a pasta do ajudante para levar a outra máquina: o código
// dele, a lista do que instalar e os arquivos de dois cliques (instalar, iniciar, permitir).
// Com --site, a pasta já sai autorizando o endereço do app publicado.
//
// O que NÃO vai: helper/bin (os programas baixados, a lista de endereços desta máquina e o
// certificado da sala). Cada computador baixa os seus e guarda os seus.
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const OUT_ROOT = path.join(ROOT, 'dist-helper')
const OUT = path.join(OUT_ROOT, 'gogo-ajudante')
const site = process.argv.find((arg) => arg.startsWith('--site='))?.slice('--site='.length)

rmSync(OUT_ROOT, { recursive: true, force: true })
mkdirSync(path.join(OUT, 'helper'), { recursive: true })

// O código do ajudante, sem os testes, sem a pasta dos programas baixados e sem a peça que o
// encaixa no servidor de desenvolvimento do app (plugin.ts), que lá não existe.
for (const name of readdirSync(path.join(ROOT, 'helper'))) {
  if (name === 'bin' || name === 'plugin.ts' || name.endsWith('.test.ts')) continue
  cpSync(path.join(ROOT, 'helper', name), path.join(OUT, 'helper', name), { recursive: true })
}
// O único arquivo do app que o ajudante usa: o encaixe da letra no áudio.
mkdirSync(path.join(OUT, 'src', 'lib', 'align'), { recursive: true })
cpSync(path.join(ROOT, 'src', 'lib', 'align', 'ctc.ts'), path.join(OUT, 'src', 'lib', 'align', 'ctc.ts'))

const project = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { version: string; dependencies: Record<string, string> }
writeFileSync(
  path.join(OUT, 'package.json'),
  `${JSON.stringify(
    {
      name: 'gogo-ajudante',
      private: true,
      version: project.version,
      type: 'module',
      description: 'Ajudante do Gogo: baixa do YouTube, separa a voz, mede a letra no audio e abre a sala. So atende este computador.',
      engines: { node: '>=22.18' },
      scripts: { start: 'node helper/server.ts', permitir: 'node helper/server.ts permitir', sites: 'node helper/server.ts sites' },
      // Só o que o ajudante importa de fora.
      dependencies: { selfsigned: project.dependencies.selfsigned, ws: project.dependencies.ws },
    },
    null,
    2,
  )}\n`,
)

// Arquivos de dois cliques. O Windows quer fim de linha CRLF e, por segurança, só letras sem acento.
const cmd = (lines: string[]) => `${lines.join('\r\n')}\r\n`
const NODE_CHECK = [
  'where node >nul 2>nul',
  'if errorlevel 1 (',
  '  echo O Node.js nao esta instalado neste computador.',
  '  echo Instale a versao 22.18 ou mais nova: winget install OpenJS.NodeJS.LTS',
  '  echo ou baixe em https://nodejs.org . Depois abra este arquivo de novo.',
  '  pause',
  '  exit /b 1',
  ')',
  `node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=18)?0:1)"`,
  'if errorlevel 1 (',
  '  echo O Node deste computador e antigo. O ajudante precisa do 22.18 ou mais novo.',
  '  echo Atualize: winget install OpenJS.NodeJS.LTS',
  '  pause',
  '  exit /b 1',
  ')',
]
writeFileSync(path.join(OUT, 'instalar.cmd'), cmd(['@echo off', 'setlocal', 'cd /d "%~dp0"', 'title Gogo - instalar o ajudante', ...NODE_CHECK, 'node helper\\install.ts %*', 'echo.', 'pause']))
writeFileSync(
  path.join(OUT, 'iniciar.cmd'),
  cmd(['@echo off', 'setlocal', 'cd /d "%~dp0"', 'title Gogo - ajudante', ...NODE_CHECK, 'if not exist node_modules\\ws (', '  echo Falta instalar. Abra o arquivo "instalar" primeiro.', '  pause', '  exit /b 1', ')', 'node helper\\server.ts', 'if errorlevel 1 pause']),
)
writeFileSync(
  path.join(OUT, 'permitir.cmd'),
  cmd([
    '@echo off',
    'setlocal',
    'cd /d "%~dp0"',
    'title Gogo - autorizar endereco',
    'set "SITE=%~1"',
    'if "%SITE%"=="" set /p "SITE=Endereco do app publicado (ex.: https://meu-gogo.vercel.app): "',
    'node helper\\server.ts permitir "%SITE%"',
    'echo.',
    'pause',
  ]),
)

writeFileSync(
  path.join(OUT, 'LEIA-ME.txt'),
  [
    'Ajudante do Gogó',
    '================',
    '',
    'É o programa que faz, neste computador, o que o navegador não consegue: baixar do YouTube,',
    'separar a voz, medir a letra no áudio e abrir a sala para os celulares. O app publicado',
    '(o endereço que você abre no navegador) conversa com ele. Ele só atende este computador.',
    '',
    'Para instalar',
    '  1. Tenha o Node 22.18 ou mais novo (winget install OpenJS.NodeJS.LTS).',
    '  2. Abra o arquivo "instalar". Ele baixa o que falta, confere o ffmpeg e pergunta o',
    '     endereço do seu app publicado, que é o único site que vai poder usar o ajudante.',
    '',
    'Para usar',
    '  Abra o arquivo "iniciar" e deixe a janela aberta. Depois abra o app no navegador.',
    '  Na primeira vez o navegador pergunta se o site pode acessar a rede local: permita.',
    '',
    'Para autorizar outro endereço (se o endereço do app mudar)',
    '  Abra o arquivo "permitir" e informe o endereço.',
    '',
    'Para desinstalar',
    '  Apague esta pasta. Se o ajudante sobe com o Windows, apague também "Gogo ajudante.cmd"',
    '  na pasta Inicializar (Win+R, shell:startup).',
    '',
    'As músicas não ficam aqui: ficam guardadas no navegador, no endereço do app.',
    '',
  ].join('\r\n'),
)

if (site) {
  // Mesma regra do ajudante: só https (ou a própria máquina, para testes).
  let origin: string | null = null
  try {
    const url = new URL(site)
    if (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) origin = url.origin
  } catch {
    // Trata abaixo.
  }
  if (!origin) {
    console.error(`"${site}" não serve: o endereço precisa começar com https://, como https://meu-gogo.vercel.app.`)
    process.exit(1)
  }
  mkdirSync(path.join(OUT, 'helper', 'bin'), { recursive: true })
  writeFileSync(path.join(OUT, 'helper', 'bin', 'sites.json'), `${JSON.stringify({ sites: [origin] }, null, 2)}\n`)
}

const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? files(path.join(dir, entry.name)) : [path.join(dir, entry.name)]))
const all = files(OUT)
const bytes = all.reduce((sum, file) => sum + statSync(file).size, 0)

// Um arquivo só é mais fácil de levar. O tar que vem com o Windows 10 e 11 sabe fazer zip; o de
// outros terminais (Git Bash) não, por isso o caminho completo.
const zip = path.join(OUT_ROOT, 'gogo-ajudante.zip')
const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar'
const zipped = spawnSync(tar, ['-a', '-c', '-f', zip, '-C', OUT_ROOT, 'gogo-ajudante'], { encoding: 'utf8' }).status === 0 && statSync(zip).size > 0

console.log(`Pasta do ajudante pronta: ${OUT}`)
console.log(`  ${all.length} arquivos, ${Math.round(bytes / 1024)} KB${site ? `, já autorizando ${site}` : ''}`)
if (zipped) console.log(`  também em um arquivo só: ${zip}`)
console.log('Leve a pasta (ou o zip) para a outra máquina e abra o arquivo "instalar".')
