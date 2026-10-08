/**
 * Quem pode falar com o ajudante.
 *
 * O ajudante executa programas na máquina (o downloader, o ffmpeg, o separador), então só
 * atende dois tipos de pedido:
 *   - o da própria página, quando o app é aberto pelo servidor em que o ajudante está embutido;
 *   - o de um endereço que o dono do computador autorizou (o app publicado).
 *
 * Qualquer outro site aberto no navegador que tente chamar `localhost` é recusado, e também
 * um nome de domínio qualquer apontado para esta máquina (DNS rebinding).
 *
 * Este arquivo só decide; não lê disco nem rede, para poder ser testado sozinho.
 */

type Header = string | string[] | undefined

export interface RequestHeaders {
  host?: Header
  origin?: Header
  'sec-fetch-site'?: Header
  'access-control-request-private-network'?: Header
  [name: string]: Header
}

export interface Access {
  trusted: boolean
  /** Cabeçalhos que o navegador exige para entregar a resposta a uma página de outro endereço. */
  cors: Record<string, string>
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])
const DENIED: Access = { trusted: false, cors: {} }

const one = (value: Header): string => (Array.isArray(value) ? (value[0] ?? '') : (value ?? ''))

function isLocalHost(hostHeader: string): boolean {
  return LOCAL_HOSTS.has(hostHeader.replace(/:\d+$/, '').toLowerCase())
}

/**
 * O endereço de um site do jeito que o navegador o apresenta (esquema, nome e porta), ou null
 * quando não pode ser autorizado. Só https: num endereço http, qualquer um no caminho poderia
 * trocar a página e, com ela, mandar no ajudante. A exceção é a própria máquina.
 */
export function normalizeSite(raw: string): string | null {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return null
  }
  const local = LOCAL_HOSTS.has(url.hostname.toLowerCase())
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return null
  return url.origin
}

function corsFor(origin: string, headers: RequestHeaders, methods: string): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin,
    Vary: 'Origin',
    'Access-Control-Allow-Methods': methods,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '600',
    // Navegadores que consultam antes de deixar um site público falar com a rede local.
    ...(one(headers['access-control-request-private-network']) === 'true' ? { 'Access-Control-Allow-Private-Network': 'true' } : {}),
  }
}

/** Decide se um pedido pode ser atendido. `sites` são os endereços autorizados, já normalizados. */
export function decideAccess(headers: RequestHeaders, sites: readonly string[]): Access {
  const host = one(headers.host)
  if (!isLocalHost(host)) return DENIED

  const origin = one(headers.origin)
  if (origin) {
    let parsed: URL
    try {
      parsed = new URL(origin)
    } catch {
      return DENIED
    }
    // A própria página do servidor em que o ajudante está.
    if (parsed.host === host) return { trusted: true, cors: {} }
    const site = normalizeSite(origin)
    if (site && sites.includes(site)) return { trusted: true, cors: corsFor(origin, headers, 'GET, POST, DELETE, OPTIONS') }
    return DENIED
  }

  // Sem "Origin": um pedido simples da própria página, o endereço digitado na barra, ou um
  // programa da máquina. O navegador diz de onde partiu; se foi de outro site, não passa.
  const from = one(headers['sec-fetch-site'])
  if (from && from !== 'same-origin' && from !== 'none') return DENIED
  return { trusted: true, cors: {} }
}

/**
 * A única pergunta que qualquer página pode fazer: "há um ajudante aqui, e ele confia em mim?".
 * Serve para o app publicado explicar o que falta. null quando nem isso deve ser respondido.
 */
export function helloAccess(headers: RequestHeaders, sites: readonly string[]): { allowed: boolean; cors: Record<string, string> } | null {
  if (!isLocalHost(one(headers.host))) return null
  const origin = one(headers.origin)
  return { allowed: decideAccess(headers, sites).trusted, cors: origin ? corsFor(origin, headers, 'GET, OPTIONS') : {} }
}
