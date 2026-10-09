// O que do projeto entra no pacote do ajudante, e a marca de versão tirada desses arquivos.
//
// Quem monta o pacote (pack-helper.ts) grava a marca dentro dele e ao lado do zip publicado em
// public/. O ajudante instalado informa a sua, e o app compara as duas para avisar quando há um
// mais novo para baixar. Um teste (helper/package.test.ts) confere se o zip de public/ foi
// gerado com o código de agora.
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

/** O que de helper/ vai no pacote: tudo, menos os programas baixados, o encaixe no servidor de desenvolvimento e os testes. */
export function helperEntries(root: string): string[] {
  return readdirSync(path.join(root, 'helper'))
    .filter((name) => name !== 'bin' && name !== 'plugin.ts' && !name.endsWith('.test.ts'))
    .sort()
}

/** O único arquivo do app que o ajudante usa: o encaixe da letra no áudio. */
export const SHARED_SOURCE = 'src/lib/align/ctc.ts'

/** Dependências do projeto que o ajudante importa: vão para o package.json do pacote. */
export const HELPER_DEPENDENCIES = ['selfsigned', 'ws'] as const

function filesIn(root: string, relative: string): string[] {
  const entries = readdirSync(path.join(root, relative), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))
  return entries.flatMap((entry) => (entry.isDirectory() ? filesIn(root, `${relative}/${entry.name}`) : [`${relative}/${entry.name}`]))
}

/** Todo arquivo do projeto de que o pacote depende, com barras normais e em ordem fixa. */
export function packageSources(root: string): string[] {
  const helper = helperEntries(root).flatMap((name) => (statSync(path.join(root, 'helper', name)).isDirectory() ? filesIn(root, `helper/${name}`) : [`helper/${name}`]))
  // Os dois scripts entram porque escrevem os arquivos de instalar, iniciar e permitir.
  return [...helper, SHARED_SOURCE, 'scripts/pack-helper.ts', 'scripts/helper-stamp.ts']
}

/** Doze dígitos que mudam quando qualquer coisa do pacote muda. */
export function stampOf(root: string): string {
  const hash = createHash('sha256')
  for (const file of packageSources(root)) {
    // O git entrega o mesmo arquivo com fim de linha diferente em cada sistema: a marca não pode depender disso.
    hash.update(`${file}\n${readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n')}\n`)
  }
  const project = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string; dependencies: Record<string, string> }
  hash.update(JSON.stringify([project.version, ...HELPER_DEPENDENCIES.map((name) => project.dependencies[name])]))
  return hash.digest('hex').slice(0, 12)
}
