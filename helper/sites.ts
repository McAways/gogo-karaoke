import { readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { normalizeSite } from './access.ts'
import { BIN_DIR } from './binary.ts'

/**
 * Endereços, além do próprio, que podem usar o ajudante deste computador: o do app publicado.
 * A lista começa vazia e só muda por comando dado aqui na máquina (`permitir`), nunca por um
 * clique num site. Fica em helper/bin, que não vai para o git nem para a publicação.
 */
const SITES_FILE = path.join(BIN_DIR, 'sites.json')

let cache: { at: number; sites: string[] } | null = null

/** Os endereços guardados no arquivo, já conferidos. */
export function savedSites(): string[] {
  try {
    const data = JSON.parse(readFileSync(SITES_FILE, 'utf8')) as { sites?: unknown }
    const list = Array.isArray(data.sites) ? data.sites : []
    return [...new Set(list.flatMap((site) => (typeof site === 'string' ? (normalizeSite(site) ?? []) : [])))]
  } catch {
    return []
  }
}

/**
 * Os endereços autorizados agora. O arquivo é relido a cada dois segundos, então `permitir`
 * vale sem reiniciar o ajudante. GOGO_SITES acrescenta endereços só para esta execução (testes).
 */
export function allowedSites(): string[] {
  if (!cache || Date.now() - cache.at > 2000) {
    const extra = (process.env.GOGO_SITES ?? '').split(',').flatMap((site) => normalizeSite(site) ?? [])
    cache = { at: Date.now(), sites: [...new Set([...savedSites(), ...extra])] }
  }
  return cache.sites
}

async function save(sites: string[]): Promise<void> {
  await mkdir(BIN_DIR, { recursive: true })
  await writeFile(SITES_FILE, `${JSON.stringify({ sites }, null, 2)}\n`)
  cache = null
}

/** Autoriza um endereço. Aceita "meu-app.vercel.app" sem o https na frente. Devolve como ficou guardado. */
export async function allowSite(raw: string): Promise<string> {
  const text = raw.trim()
  const site = normalizeSite(text) ?? (/^[a-z][a-z0-9+.-]*:/i.test(text) ? null : normalizeSite(`https://${text}`))
  if (!site) throw new Error(`"${raw}" não serve: o endereço precisa começar com https://, como https://meu-gogo.vercel.app.`)
  const sites = savedSites()
  if (!sites.includes(site)) await save([...sites, site])
  return site
}

/** Tira um endereço da lista. false quando ele não estava nela. */
export async function forgetSite(raw: string): Promise<boolean> {
  const site = normalizeSite(raw.trim()) ?? normalizeSite(`https://${raw.trim()}`)
  const sites = savedSites()
  if (!site || !sites.includes(site)) return false
  await save(sites.filter((entry) => entry !== site))
  return true
}
