// Uso: npm run helper:pack [-- --site=https://meu-gogo.vercel.app]
//
// Monta em dist-helper/gogo-ajudante a pasta do ajudante para levar a outra máquina (Windows ou
// macOS): o código dele, a lista do que instalar e os arquivos de dois cliques (instalar, iniciar,
// permitir).
//
// Sem --site, o zip também vai para public/gogo-ajudante.zip: é o que o app publicado oferece em
// "Baixar o ajudante". Ele precisa ser commitado junto com o código do ajudante (um teste avisa
// quando ficou para trás). O app anota o próprio endereço dentro do zip na hora do download.
// Com --site, a pasta já sai autorizando aquele endereço e fica só em dist-helper: é um pacote
// para levar em mãos, e não vai para public/.
//
// A máquina de destino não precisa ter nada instalado: o "instalar" baixa o Node (o mesmo deste
// computador, conferido pela soma publicada em nodejs.org) só para dentro da pasta, e o resto
// vem atrás (dependências, ffmpeg, downloader).
//
// O que NÃO vai: helper/bin (os programas baixados, a lista de endereços desta máquina e o
// certificado da sala). Cada computador baixa os seus e guarda os seus.
import { copyFileSync, cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { crc32, deflateRawSync } from 'node:zlib'
import { HELPER_DEPENDENCIES, SHARED_SOURCE, helperEntries, stampOf } from './helper-stamp.ts'

const ROOT = path.resolve(import.meta.dirname, '..')
const OUT_ROOT = path.join(ROOT, 'dist-helper')
const OUT = path.join(OUT_ROOT, 'gogo-ajudante')
const PUBLIC = path.join(ROOT, 'public')
const site = process.argv.find((arg) => arg.startsWith('--site='))?.slice('--site='.length)
const stamp = stampOf(ROOT)

// ---------- o Node que o instalador baixa quando a máquina não tem ----------

const NODE_VERSION = process.version
const NODE_FILES = {
  'win-x64': `node-${NODE_VERSION}-win-x64.zip`,
  'win-arm64': `node-${NODE_VERSION}-win-arm64.zip`,
  'darwin-arm64': `node-${NODE_VERSION}-darwin-arm64.tar.gz`,
  'darwin-x64': `node-${NODE_VERSION}-darwin-x64.tar.gz`,
  'linux-x64': `node-${NODE_VERSION}-linux-x64.tar.gz`,
  'linux-arm64': `node-${NODE_VERSION}-linux-arm64.tar.gz`,
}

/** A soma SHA-256 de cada arquivo, do jeito que nodejs.org publica. Vazio quando não deu para buscar. */
async function nodeSums(): Promise<Record<string, string>> {
  try {
    const res = await fetch(`https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt`, { signal: AbortSignal.timeout(20_000) })
    if (!res.ok) throw new Error(String(res.status))
    const sums: Record<string, string> = {}
    for (const line of (await res.text()).split(/\r?\n/)) {
      const [sum, name] = line.trim().split(/\s+/)
      if (/^[0-9a-f]{64}$/.test(sum ?? '') && name) sums[name] = sum
    }
    return sums
  } catch {
    return {}
  }
}

const sums = await nodeSums()
const sumOf = (key: keyof typeof NODE_FILES) => sums[NODE_FILES[key]] ?? ''
const verified = Object.values(NODE_FILES).every((name) => sums[name])

// ---------- a pasta ----------

rmSync(OUT_ROOT, { recursive: true, force: true })
mkdirSync(path.join(OUT, 'helper'), { recursive: true })
mkdirSync(path.join(OUT, 'suporte'), { recursive: true })

// O código do ajudante, sem os testes, sem a pasta dos programas baixados e sem a peça que o
// encaixa no servidor de desenvolvimento do app (plugin.ts), que lá não existe.
for (const name of helperEntries(ROOT)) cpSync(path.join(ROOT, 'helper', name), path.join(OUT, 'helper', name), { recursive: true })
// O único arquivo do app que o ajudante usa: o encaixe da letra no áudio.
mkdirSync(path.dirname(path.join(OUT, SHARED_SOURCE)), { recursive: true })
cpSync(path.join(ROOT, SHARED_SOURCE), path.join(OUT, SHARED_SOURCE))
// O git entrega estes arquivos com fim de linha de Windows ou de Unix, conforme a máquina. No
// pacote vão sempre com o de Unix, para o mesmo código gerar o mesmo zip em qualquer lugar.
const unixLines = (dir: string): void => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const target = path.join(dir, entry.name)
    if (entry.isDirectory()) unixLines(target)
    else if (/\.(ts|js|css|html|json)$/.test(entry.name)) writeFileSync(target, readFileSync(target, 'utf8').replace(/\r\n/g, '\n'))
  }
}
unixLines(path.join(OUT, 'helper'))
unixLines(path.join(OUT, 'src'))
// A marca deste pacote: o ajudante a informa ao app, que avisa quando há um mais novo para baixar.
writeFileSync(path.join(OUT, 'pacote.json'), `${JSON.stringify({ versao: stamp }, null, 2)}\n`)

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
      dependencies: Object.fromEntries(HELPER_DEPENDENCIES.map((name) => [name, project.dependencies[name]])),
    },
    null,
    2,
  )}\n`,
)

// ---------- Windows: arquivos .cmd (fim de linha CRLF, só letras sem acento) ----------

const cmd = (lines: string[]) => `${lines.join('\r\n')}\r\n`
const NODE_CHECK = `const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=18)?0:1)`

writeFileSync(
  path.join(OUT, 'suporte', 'node.cmd'),
  cmd([
    '@echo off',
    'rem Acha um Node que sirva (22.18 ou mais novo). Se a maquina nao tiver, baixa um so para esta',
    'rem pasta. Devolve NODE_EXE e poe a pasta dele na frente do PATH (o npm fica ao lado).',
    'rem Uso: call suporte\\node.cmd [baixar]',
    'set "NODE_EXE="',
    'set "GOGO_RUNTIME=%~dp0..\\runtime"',
    'if exist "%GOGO_RUNTIME%\\node.exe" set "NODE_EXE=%GOGO_RUNTIME%\\node.exe"',
    'if defined NODE_EXE goto :pronto',
    '',
    'where node >nul 2>nul',
    'if errorlevel 1 goto :sem_node',
    `node -e "${NODE_CHECK}" >nul 2>nul`,
    'if errorlevel 1 goto :sem_node',
    `for /f "delims=" %%n in ('where node') do if not defined NODE_EXE set "NODE_EXE=%%n"`,
    'if defined NODE_EXE goto :pronto',
    '',
    ':sem_node',
    'if /i "%~1"=="baixar" goto :baixar',
    'echo Falta instalar. Abra o arquivo "instalar" primeiro.',
    'exit /b 1',
    '',
    ':baixar',
    'set "GOGO_ARCH=x64"',
    'if /i "%PROCESSOR_ARCHITECTURE%"=="ARM64" set "GOGO_ARCH=arm64"',
    'if /i "%PROCESSOR_ARCHITEW6432%"=="ARM64" set "GOGO_ARCH=arm64"',
    `set "GOGO_NODE_FILE=node-${NODE_VERSION}-win-%GOGO_ARCH%.zip"`,
    `set "GOGO_NODE_SUM=${sumOf('win-x64')}"`,
    `if "%GOGO_ARCH%"=="arm64" set "GOGO_NODE_SUM=${sumOf('win-arm64')}"`,
    'echo Este computador nao tem o Node, ou tem um antigo.',
    `echo Baixando o Node ${NODE_VERSION} so para esta pasta, cerca de 35 MB...`,
    'if not exist "%GOGO_RUNTIME%" mkdir "%GOGO_RUNTIME%"',
    `curl.exe -L --fail --silent --show-error -o "%GOGO_RUNTIME%\\%GOGO_NODE_FILE%" "https://nodejs.org/dist/${NODE_VERSION}/%GOGO_NODE_FILE%"`,
    'if errorlevel 1 goto :falhou_baixar',
    'set "GOGO_GOT="',
    `for /f "skip=1 delims=" %%h in ('certutil -hashfile "%GOGO_RUNTIME%\\%GOGO_NODE_FILE%" SHA256') do if not defined GOGO_GOT set "GOGO_GOT=%%h"`,
    'if defined GOGO_GOT set "GOGO_GOT=%GOGO_GOT: =%"',
    'if "%GOGO_NODE_SUM%"=="" goto :abrir',
    'if /i "%GOGO_GOT%"=="%GOGO_NODE_SUM%" goto :abrir',
    'echo O arquivo do Node que chegou nao confere com o original. Foi apagado; tente de novo.',
    'del "%GOGO_RUNTIME%\\%GOGO_NODE_FILE%"',
    'exit /b 1',
    '',
    ':abrir',
    'tar.exe -xf "%GOGO_RUNTIME%\\%GOGO_NODE_FILE%" -C "%GOGO_RUNTIME%" --strip-components=1',
    'if errorlevel 1 goto :falhou_abrir',
    'del "%GOGO_RUNTIME%\\%GOGO_NODE_FILE%"',
    'if not exist "%GOGO_RUNTIME%\\node.exe" goto :falhou_abrir',
    'set "NODE_EXE=%GOGO_RUNTIME%\\node.exe"',
    'echo Node pronto.',
    'goto :pronto',
    '',
    ':falhou_baixar',
    'echo Nao deu para baixar o Node. Confira a internet e abra o instalador de novo.',
    'exit /b 1',
    '',
    ':falhou_abrir',
    'echo Nao deu para abrir o arquivo do Node que foi baixado.',
    'exit /b 1',
    '',
    ':pronto',
    'for %%d in ("%NODE_EXE%") do set "PATH=%%~dpd;%PATH%"',
    'exit /b 0',
  ]),
)

writeFileSync(
  path.join(OUT, 'instalar.cmd'),
  cmd(['@echo off', 'setlocal', 'cd /d "%~dp0"', 'title Gogo - instalar o ajudante', 'call "%~dp0suporte\\node.cmd" baixar', 'if errorlevel 1 goto :fim', '"%NODE_EXE%" helper\\install.ts %*', ':fim', 'echo.', 'pause']),
)
writeFileSync(
  path.join(OUT, 'iniciar.cmd'),
  cmd([
    '@echo off',
    'setlocal',
    'cd /d "%~dp0"',
    'title Gogo - ajudante',
    'call "%~dp0suporte\\node.cmd"',
    'if errorlevel 1 goto :erro',
    'if not exist node_modules\\ws goto :falta',
    '"%NODE_EXE%" helper\\server.ts',
    'if errorlevel 1 pause',
    'exit /b',
    ':falta',
    'echo Falta instalar. Abra o arquivo "instalar" primeiro.',
    ':erro',
    'pause',
    'exit /b 1',
  ]),
)
writeFileSync(
  path.join(OUT, 'permitir.cmd'),
  cmd([
    '@echo off',
    'setlocal',
    'cd /d "%~dp0"',
    'title Gogo - autorizar endereco',
    'call "%~dp0suporte\\node.cmd"',
    'if errorlevel 1 goto :fim',
    'set "SITE=%~1"',
    'if "%SITE%"=="" set /p "SITE=Endereco do app publicado (ex.: https://meu-gogo.vercel.app): "',
    '"%NODE_EXE%" helper\\server.ts permitir "%SITE%"',
    ':fim',
    'echo.',
    'pause',
  ]),
)

// ---------- macOS (e Linux): arquivos .command (fim de linha LF) ----------

const sh = (lines: string[]) => `${lines.join('\n')}\n`
const CLOSE = `printf 'Aperte Enter para fechar. '; read -r _`

writeFileSync(
  path.join(OUT, 'suporte', 'node.sh'),
  sh([
    '# Acha um Node que sirva (22.18 ou mais novo). Se a máquina não tiver, baixa um só para esta pasta.',
    '# Deixa NODE_EXE apontando para ele e põe a pasta dele na frente do PATH (o npm fica ao lado).',
    '# Uso, de dentro da pasta do ajudante:  . ./suporte/node.sh [baixar]',
    '',
    'GOGO_RUNTIME="$(pwd)/runtime"',
    `GOGO_NODE_VERSION="${NODE_VERSION}"`,
    '',
    'gogo_node_ok() {',
    `  "$1" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=18)?0:1)' >/dev/null 2>&1`,
    '}',
    '',
    'NODE_EXE=""',
    'if [ -x "$GOGO_RUNTIME/bin/node" ] && gogo_node_ok "$GOGO_RUNTIME/bin/node"; then',
    '  NODE_EXE="$GOGO_RUNTIME/bin/node"',
    'elif command -v node >/dev/null 2>&1 && gogo_node_ok "$(command -v node)"; then',
    '  NODE_EXE="$(command -v node)"',
    'fi',
    '',
    'if [ -z "$NODE_EXE" ]; then',
    '  if [ "$1" != "baixar" ]; then',
    `    echo 'Falta instalar. Abra o arquivo "instalar" primeiro.'`,
    '    return 1',
    '  fi',
    '  case "$(uname -s)-$(uname -m)" in',
    `    Darwin-arm64) GOGO_NODE_ARCH="darwin-arm64"; GOGO_NODE_SUM="${sumOf('darwin-arm64')}" ;;`,
    `    Darwin-x86_64) GOGO_NODE_ARCH="darwin-x64"; GOGO_NODE_SUM="${sumOf('darwin-x64')}" ;;`,
    `    Linux-x86_64) GOGO_NODE_ARCH="linux-x64"; GOGO_NODE_SUM="${sumOf('linux-x64')}" ;;`,
    `    Linux-aarch64 | Linux-arm64) GOGO_NODE_ARCH="linux-arm64"; GOGO_NODE_SUM="${sumOf('linux-arm64')}" ;;`,
    '    *)',
    '      echo "Não há um Node pronto para este sistema ($(uname -s) $(uname -m)). Instale o Node 22.18 ou mais novo e abra o instalador de novo."',
    '      return 1',
    '      ;;',
    '  esac',
    '  GOGO_NODE_FILE="node-$GOGO_NODE_VERSION-$GOGO_NODE_ARCH.tar.gz"',
    '  echo "Este computador não tem o Node, ou tem um antigo."',
    '  echo "Baixando o Node $GOGO_NODE_VERSION só para esta pasta, cerca de 45 MB..."',
    '  mkdir -p "$GOGO_RUNTIME" || return 1',
    '  if ! curl -L --fail --silent --show-error -o "$GOGO_RUNTIME/$GOGO_NODE_FILE" "https://nodejs.org/dist/$GOGO_NODE_VERSION/$GOGO_NODE_FILE"; then',
    '    echo "Não deu para baixar o Node. Confira a internet e abra o instalador de novo."',
    '    return 1',
    '  fi',
    '  if [ -n "$GOGO_NODE_SUM" ]; then',
    '    if command -v shasum >/dev/null 2>&1; then',
    `      GOGO_GOT=$(shasum -a 256 "$GOGO_RUNTIME/$GOGO_NODE_FILE" | cut -d' ' -f1)`,
    '    else',
    `      GOGO_GOT=$(sha256sum "$GOGO_RUNTIME/$GOGO_NODE_FILE" | cut -d' ' -f1)`,
    '    fi',
    '    if [ "$GOGO_GOT" != "$GOGO_NODE_SUM" ]; then',
    '      echo "O arquivo do Node que chegou não confere com o original. Foi apagado; tente de novo."',
    '      rm -f "$GOGO_RUNTIME/$GOGO_NODE_FILE"',
    '      return 1',
    '    fi',
    '  fi',
    '  if ! tar -xzf "$GOGO_RUNTIME/$GOGO_NODE_FILE" -C "$GOGO_RUNTIME" --strip-components=1; then',
    '    echo "Não deu para abrir o arquivo do Node que foi baixado."',
    '    return 1',
    '  fi',
    '  rm -f "$GOGO_RUNTIME/$GOGO_NODE_FILE"',
    '  NODE_EXE="$GOGO_RUNTIME/bin/node"',
    '  if ! gogo_node_ok "$NODE_EXE"; then',
    '    echo "O Node baixado não executou neste computador."',
    '    return 1',
    '  fi',
    '  echo "Node pronto."',
    'fi',
    '',
    'PATH="$(dirname "$NODE_EXE"):$PATH"',
    'export PATH',
  ]),
)

writeFileSync(
  path.join(OUT, 'instalar.command'),
  sh(['#!/bin/sh', '# Dois cliques no Finder abrem este arquivo no Terminal.', 'cd "$(dirname "$0")" || exit 1', 'if . ./suporte/node.sh baixar; then', '  "$NODE_EXE" helper/install.ts "$@"', 'fi', 'echo', CLOSE]),
)
writeFileSync(
  path.join(OUT, 'iniciar.command'),
  sh([
    '#!/bin/sh',
    '# Dois cliques no Finder abrem este arquivo no Terminal. Deixe a janela aberta enquanto usa o app.',
    'cd "$(dirname "$0")" || exit 1',
    'if ! . ./suporte/node.sh; then',
    `  ${CLOSE}`,
    '  exit 1',
    'fi',
    'if [ ! -d node_modules/ws ]; then',
    `  echo 'Falta instalar. Abra o arquivo "instalar" primeiro.'`,
    `  ${CLOSE}`,
    '  exit 1',
    'fi',
    '"$NODE_EXE" helper/server.ts',
    'status=$?',
    'if [ "$status" -ne 0 ]; then',
    `  ${CLOSE}`,
    'fi',
    'exit "$status"',
  ]),
)
writeFileSync(
  path.join(OUT, 'permitir.command'),
  sh([
    '#!/bin/sh',
    'cd "$(dirname "$0")" || exit 1',
    'if . ./suporte/node.sh; then',
    '  SITE="$1"',
    '  if [ -z "$SITE" ]; then',
    `    printf 'Endereço do app publicado (ex.: https://meu-gogo.vercel.app): '`,
    '    read -r SITE',
    '  fi',
    '  "$NODE_EXE" helper/server.ts permitir "$SITE"',
    'fi',
    'echo',
    CLOSE,
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
    '  Windows: abra o arquivo "instalar".',
    '  Mac: abra o arquivo "instalar.command". Se o macOS disser que não pode abrir, clique nele',
    '       com o botão direito e escolha Abrir. Se disser que não tem permissão, abra o',
    '       Terminal nesta pasta e rode:  sh instalar.command',
    '',
    '  O instalador baixa sozinho o que a máquina não tiver: o Node (só para dentro desta pasta,',
    '  sem mexer no resto do computador), as dependências, o ffmpeg e o downloader. Depois',
    '  autoriza o endereço do seu app publicado, que é o único site que vai poder usar o ajudante.',
    '  Se você baixou este pacote pelo próprio app, o endereço já veio anotado (no arquivo',
    '  "endereco-do-app.txt") e o instalador não pergunta nada. Senão, ele pergunta.',
    '  Precisa de internet. Não precisa de senha de administrador.',
    '',
    'Para atualizar',
    '  Feche a janela do ajudante, extraia o pacote novo por cima desta pasta e abra "instalar"',
    '  de novo. O que já foi baixado e os endereços autorizados continuam.',
    '',
    'Para usar',
    '  Abra o arquivo "iniciar" (no Mac, "iniciar.command") e deixe a janela aberta. Depois abra',
    '  o app no Chrome ou no Edge. Na primeira vez o navegador pergunta se o site pode acessar a',
    '  rede local: permita.',
    '',
    'Para autorizar outro endereço (se o endereço do app mudar)',
    '  Abra o arquivo "permitir" (no Mac, "permitir.command") e informe o endereço.',
    '',
    'Para desinstalar',
    '  Apague esta pasta: tudo o que foi baixado está dentro dela. No Windows, se o ajudante',
    '  sobe com o sistema, apague também "Gogo ajudante.cmd" na pasta Inicializar (Win+R,',
    '  shell:startup).',
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

// ---------- o zip ----------

const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? files(path.join(dir, entry.name)) : [path.join(dir, entry.name)]))

/**
 * Grava um zip marcando quais arquivos são executáveis. O zip feito pelo Windows não guarda essa
 * permissão, e sem ela o macOS se recusa a abrir um .command com dois cliques.
 */
function writeZip(target: string, list: string[], base: string, executable: (name: string) => boolean): void {
  // Data fixa (1º de janeiro de 2026): o mesmo código gera sempre o mesmo zip, byte a byte, e o
  // arquivo commitado em public/ só muda quando o ajudante muda.
  const time = 0
  const date = ((2026 - 1980) << 9) | (1 << 5) | 1
  const body: Buffer[] = []
  const index: Buffer[] = []
  let offset = 0

  for (const file of list) {
    const name = Buffer.from(path.relative(base, file).split(path.sep).join('/'), 'utf8')
    const data = readFileSync(file)
    const packed = deflateRawSync(data)
    const sum = crc32(data)
    // Arquivo comum com a permissão no estilo do Unix: 755 para o que se executa, 644 para o resto.
    const mode = 0o100000 | (executable(name.toString('utf8')) ? 0o755 : 0o644)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6) // nomes em UTF-8
    local.writeUInt16LE(8, 8) // deflate
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(sum, 14)
    local.writeUInt32LE(packed.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    body.push(local, name, packed)

    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE((3 << 8) | 20, 4) // "feito no Unix": é o que faz a permissão valer
    entry.writeUInt16LE(20, 6)
    entry.writeUInt16LE(0x0800, 8)
    entry.writeUInt16LE(8, 10)
    entry.writeUInt16LE(time, 12)
    entry.writeUInt16LE(date, 14)
    entry.writeUInt32LE(sum, 16)
    entry.writeUInt32LE(packed.length, 20)
    entry.writeUInt32LE(data.length, 24)
    entry.writeUInt16LE(name.length, 28)
    entry.writeUInt32LE((mode << 16) >>> 0, 38)
    entry.writeUInt32LE(offset, 42)
    index.push(entry, name)

    offset += local.length + name.length + packed.length
  }

  const indexSize = index.reduce((sum, part) => sum + part.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(list.length, 8)
  end.writeUInt16LE(list.length, 10)
  end.writeUInt32LE(indexSize, 12)
  end.writeUInt32LE(offset, 16)
  writeFileSync(target, Buffer.concat([...body, ...index, end]))
}

// Em ordem fixa, pela mesma razão da data fixa.
const all = files(OUT).sort()
const bytes = all.reduce((sum, file) => sum + statSync(file).size, 0)
const zip = path.join(OUT_ROOT, 'gogo-ajudante.zip')
writeZip(zip, all, OUT_ROOT, (name) => name.endsWith('.command') || name.endsWith('.sh'))

console.log(`Pasta do ajudante pronta: ${OUT}`)
console.log(`  ${all.length} arquivos, ${Math.round(bytes / 1024)} KB, versão ${stamp}${site ? `, já autorizando ${site}` : ''}`)
console.log(`  também em um arquivo só: ${zip}`)

// O zip que o app publicado oferece para baixar. Só o pacote sem endereço (cada site anota o seu
// na hora do download) e só com as somas do Node: o que vai a público tem de conferir o que baixa.
if (site) {
  console.log('  este pacote já autoriza um endereço, então NÃO foi para public/ (o que vai para lá é o gerado sem --site)')
} else if (!verified) {
  console.log('  AVISO: sem as somas do Node, o zip NÃO foi copiado para public/. Gere de novo com internet.')
} else {
  const published = path.join(PUBLIC, 'gogo-ajudante.zip')
  copyFileSync(zip, published)
  writeFileSync(path.join(PUBLIC, 'gogo-ajudante.json'), `${JSON.stringify({ versao: stamp, bytes: statSync(published).size, node: NODE_VERSION }, null, 2)}\n`)
  console.log(`  e em public/gogo-ajudante.zip, para o app publicado oferecer em "Baixar o ajudante": commite os dois arquivos de public/`)
}
console.log(`  para Windows (instalar.cmd) e macOS (instalar.command); para o Mac, leve o zip: ele guarda a permissão de executar`)
console.log(
  verified
    ? `  se a máquina não tiver o Node, o instalador baixa o ${NODE_VERSION} de nodejs.org e confere a soma`
    : `  AVISO: não deu para buscar as somas do Node ${NODE_VERSION} em nodejs.org agora. O instalador vai baixá-lo sem conferir a soma. Gere de novo com internet para incluir a conferência.`,
)
console.log('Leve para a outra máquina e abra o arquivo "instalar".')
