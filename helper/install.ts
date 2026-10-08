// Prepara este computador para rodar o ajudante. Aberto pelo arquivo "instalar", que antes disto
// já garantiu um Node (o da máquina ou um baixado só para a pasta do ajudante).
//
// Uso: node helper/install.ts [--site=<endereço>] [--inicio=sim|nao] [--sem-perguntas]
//
// Só usa o que vem com o Node: roda antes de as dependências existirem.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline/promises'
import { findFfmpeg, findYtDlp, installFfmpeg, npmCommand, updateYtDlp } from './binary.ts'
import { allowSite, savedSites } from './sites.ts'

const ROOT = path.resolve(import.meta.dirname, '..')
const IS_WINDOWS = process.platform === 'win32'
const args = process.argv.slice(2)
const option = (name: string) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
const quiet = args.includes('--sem-perguntas') || !process.stdin.isTTY

const say = (text = '') => console.log(text)
const step = (text: string) => say(`\n== ${text}`)

async function ask(question: string): Promise<string> {
  if (quiet) return ''
  const prompt = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return (await prompt.question(question)).trim()
  } finally {
    prompt.close()
  }
}

const yes = (answer: string) => /^s(im)?$/i.test(answer)

function run(command: string, commandArgs: string[], shell: boolean): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, commandArgs, { cwd: ROOT, stdio: 'inherit', shell })
    child.on('error', () => resolve(1))
    child.on('close', (code) => resolve(code ?? 1))
  })
}

/** A pasta em que o Windows procura o que abrir quando o usuário entra. */
function startupDir(): string | null {
  if (process.env.GOGO_STARTUP_DIR) return process.env.GOGO_STARTUP_DIR
  if (!IS_WINDOWS) return null
  const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming')
  return path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup')
}

const STARTUP_FILE = 'Gogo ajudante.cmd'

let problems = 0

// ---------- 1. Node ----------
step('Node')
const [major, minor] = process.versions.node.split('.').map(Number)
if (major < 22 || (major === 22 && minor < 18)) {
  say(`Este instalador foi aberto com o Node ${process.versions.node}. O ajudante precisa do 22.18 ou mais novo.`)
  say('Abra o arquivo "instalar" da pasta do ajudante: ele baixa um Node que serve, só para a pasta.')
  process.exit(1)
}
const ownNode = path.resolve(process.execPath).startsWith(path.join(ROOT, 'runtime'))
say(`Node ${process.versions.node}: ${ownNode ? 'baixado para a pasta do ajudante (não mexe no resto do computador).' : 'o deste computador serve.'}`)

// ---------- 2. Dependências ----------
step('Dependências do ajudante')
if (existsSync(path.join(ROOT, 'node_modules', 'ws')) && existsSync(path.join(ROOT, 'node_modules', 'selfsigned'))) {
  say('Já instaladas.')
} else {
  say('Baixando (precisa de internet)...')
  const npm = npmCommand()
  if ((await run(npm.command, [...npm.args, 'install', '--omit=dev', '--no-audit', '--no-fund'], npm.shell)) !== 0) {
    say('Não deu para baixar as dependências. Confira a internet e abra o instalador de novo.')
    process.exit(1)
  }
}

// ---------- 3. ffmpeg ----------
step('ffmpeg')
let ffmpeg = await findFfmpeg()
if (!ffmpeg) {
  say('Este computador não tem o ffmpeg. Baixando um para a pasta do ajudante (cerca de 80 MB)...')
  try {
    ffmpeg = await installFfmpeg()
  } catch (err) {
    problems++
    say(`Não deu para baixar agora (${err instanceof Error ? err.message : 'erro desconhecido'}).`)
    say('Sem ele não dá para baixar vídeo, separar a voz nem sincronizar a letra pelo áudio (áudio simples baixa). O app oferece instalar depois, em Ajustes.')
  }
}
if (ffmpeg) say(`ffmpeg ${ffmpeg.version}: ${ffmpeg.source === 'projeto' ? 'pronto, na pasta do ajudante.' : 'o deste computador serve.'}`)

// ---------- 4. Downloader ----------
step('Downloader (yt-dlp)')
let ytDlp = await findYtDlp()
// Um yt-dlp instalado no sistema costuma estar velho, e o YouTube recusa versões antigas: o
// ajudante usa o seu próprio, que o app sabe atualizar.
if (!ytDlp || ytDlp.source === 'sistema') {
  say(`${ytDlp ? `Há um yt-dlp no sistema (${ytDlp.version}), mas o ajudante usa o seu próprio. ` : ''}Baixando para a pasta do ajudante (cerca de 18 MB)...`)
  try {
    ytDlp = await updateYtDlp()
  } catch (err) {
    if (!ytDlp) problems++
    say(`Não deu para baixar agora (${err instanceof Error ? err.message : 'erro desconhecido'}). O próprio app oferece instalar ou atualizar depois, em Ajustes.`)
  }
}
if (ytDlp) say(`yt-dlp ${ytDlp.version}: pronto.`)

// ---------- 5. Endereço do app publicado ----------
step('Endereço do app publicado')
say('O ajudante só atende os endereços autorizados aqui. Nenhum site entra na lista sozinho.')
const wanted = option('site') ?? (savedSites().length === 0 ? await ask('Endereço do seu app publicado (ex.: https://meu-gogo.vercel.app). Enter para deixar para depois: ') : '')
if (wanted) {
  try {
    say(`Autorizado: ${await allowSite(wanted)}`)
  } catch (err) {
    problems++
    say(err instanceof Error ? err.message : 'Endereço inválido.')
  }
}
const sites = savedSites()
say(sites.length > 0 ? `Autorizados: ${sites.join(', ')}` : 'Nenhum endereço autorizado ainda. Depois, abra o arquivo "permitir" e informe o endereço.')

// ---------- 6. Subir com o Windows ----------
const startup = startupDir()
if (startup) {
  step('Subir junto com o Windows')
  const target = path.join(startup, STARTUP_FILE)
  const choice = option('inicio') ?? (existsSync(target) ? 'manter' : yes(await ask('Subir o ajudante sozinho quando você entrar no Windows? (s/N) ')) ? 'sim' : 'nao')
  if (choice === 'sim') {
    await mkdir(startup, { recursive: true })
    // Abre minimizado: a janela fica na barra de tarefas enquanto o ajudante estiver no ar.
    await writeFile(target, `@echo off\r\nstart "Gogo ajudante" /min cmd /c ""${path.join(ROOT, 'iniciar.cmd')}""\r\n`)
    say(`Feito. Para desfazer, apague "${STARTUP_FILE}" em ${startup}`)
  } else if (choice === 'nao' && existsSync(target) && option('inicio') === 'nao') {
    await rm(target, { force: true })
    say('O ajudante não sobe mais sozinho.')
  } else if (choice === 'manter') {
    say('Já está configurado para subir sozinho.')
  } else {
    say('Certo: abra o arquivo "iniciar" quando for usar.')
  }
}

// ---------- Fim ----------
step(problems === 0 ? 'Pronto' : 'Instalado, com pendências (veja acima)')
say('Para usar: abra o arquivo "iniciar" e deixe a janela aberta. Depois abra o app publicado no navegador.')
say('Na primeira vez o navegador pergunta se o site pode acessar a rede local: permita. É assim que ele fala com o ajudante.')
say('A separação de voz e a sincronia pelo áudio são instaladas de dentro do app, em Ajustes, quando você quiser.')
