const NOISE =
  /\b(official|oficial|video|v[ií]deo|videoclipe|clipe|clip|lyrics?|letra|legendado|tradu[cç][aã]o|[aá]udio|audio|hd|hq|4k|8k|visualizer|visualizador|remaster(?:ed|izado)?|mv|m\/v|karaok[eê]|full album|dvd|pseudo|explicit|vevo)\b/i

function stripNoise(text: string): string {
  return (
    text
      // Colchetes e chaves em título de vídeo são sempre etiqueta ("[H.Q.]", "[4K]", "[Clipe]").
      .replace(/[[{][^\]}]*[\]}]/g, ' ')
      // Parênteses só saem quando o conteúdo é ruído: "(Official Video)" sai, "(Sittin' On)" fica.
      .replace(/\([^)]*\)/g, (group) => (NOISE.test(group.replace(/\./g, '')) ? ' ' : group))
      .replace(/#[\p{L}\d_]+/gu, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim()
  )
}

function cleanChannel(channel: string): string {
  return channel
    .replace(/\s*-\s*Topic$/i, '')
    .replace(/VEVO$/i, '')
    .replace(/\b(official|oficial)\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/** Compara textos sem acento, pontuação nem caixa. */
export function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/&/g, ' e ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

/** Tira artista e título de um título de vídeo ("Artista - Música (Clipe Oficial)"). */
export function parseVideoTitle(rawTitle: string, rawChannel = ''): { artist: string; title: string } {
  const channel = cleanChannel(rawChannel)
  let title = stripNoise(rawTitle)
    .replace(/\s*[|/]{1,2}\s*(?:official|oficial|clipe|lyric|video|vídeo|audio|áudio).*$/i, '')
    .trim()

  const quoted = /^(.+?)\s+["“](.+?)["”]\s*$/.exec(title)
  if (quoted) return { artist: quoted[1].trim(), title: quoted[2].trim() }

  const parts = title
    .split(/\s+[-–—|]\s+|\s*[–—]\s*/)
    .map((p) => p.trim())
    .filter(Boolean)

  if (parts.length >= 2) {
    const [first, second] = parts
    // Alguns canais publicam "Música - Artista": o nome do canal desempata.
    const channelKey = normalize(channel)
    if (channelKey && normalize(second).includes(channelKey) && !normalize(first).includes(channelKey)) {
      return { artist: second, title: first }
    }
    return { artist: first, title: parts.slice(1).join(' - ') }
  }

  title = title.replace(/^["“](.+)["”]$/, '$1')
  return { artist: channel, title: title || rawTitle.trim() }
}

/** Tira artista e título de um nome de arquivo ("Artista - Música.mp3"). */
export function parseFileName(name: string): { artist: string; title: string } {
  const base = name
    .replace(/\.[a-z0-9]{2,5}$/i, '')
    .replace(/_/g, ' ')
    .replace(/^\d{1,3}[.\-\s]+(?=\S)/, '')
  return parseVideoTitle(base)
}

/** Palavras de título de vídeo que não dizem nada sobre a música (já sem acento e em minúsculas). */
const FILLER = new Set([
  'official', 'oficial', 'video', 'videoclipe', 'clipe', 'clip', 'lyric', 'lyrics', 'letra', 'legendado', 'legenda', 'traducao',
  'audio', 'hd', 'hq', '4k', '8k', 'visualizer', 'visualizador', 'mv', 'dvd', 'vevo', 'topic', 'karaoke', 'playback',
  'feat', 'ft', 'featuring', 'part', 'participacao', 'especial',
])

/** Palavras que marcam outra gravação da mesma música. */
const VERSION_WORDS = new Set(['ao', 'vivo', 'live', 'acustico', 'acustica', 'acoustic', 'unplugged', 'remix', 'rmx'])

/** O que costuma vir depois do nome numa faixa ("- Ao Vivo", "(Remastered 2011)", "- Radio Edit"). */
const DECORATION =
  /\b(ao vivo|live|en vivo|acustic[oa]|acoustic|unplugged|remix|rmx|remaster(?:ed|izado|izada)?|version|versao|edit|mix|mono|stereo|bonus|deluxe|edition|edicao|feat|ft|featuring|part|participacao|explicit|radio|single|original|trilha|soundtrack|karaoke|playback|instrumental|cover|sped up|slowed|nightcore|oficial|official|video|clipe|lyrics?|letra|audio|dvd|vol|volume|(?:19|20)\d\d)\b/

const VERSION_MARKS: Array<[mark: string, pattern: RegExp]> = [
  ['ao vivo', /\b(ao vivo|live|en vivo)\b/],
  ['acústico', /\b(acustic[oa]|acoustic|unplugged)\b/],
  ['remix', /\b(remix|rmx)\b/],
  ['outra velocidade', /\b(sped up|speed up|slowed|nightcore)\b/],
]

/** Palavras do texto, sem acento, pontuação nem caixa. */
export function tokens(text: string): string[] {
  return normalize(text).split(' ').filter(Boolean)
}

export function isFiller(token: string): boolean {
  return FILLER.has(token)
}

export function isVersionWord(token: string): boolean {
  return VERSION_WORDS.has(token)
}

/** Marcas de outra gravação presentes no texto: "ao vivo", "acústico", "remix". */
export function versionMarks(text: string): string[] {
  const plain = normalize(text)
  return VERSION_MARKS.filter(([, pattern]) => pattern.test(plain)).map(([mark]) => mark)
}

/**
 * Só o nome da música, sem o que vem pendurado nele: "Evidências - Ao Vivo" e
 * "Evidências (Remastered 2011)" viram "Evidências". Parênteses no começo fazem parte do nome.
 */
export function coreTitle(raw: string): string {
  let out = raw.trim()
  for (let pass = 0; pass < 5; pass++) {
    const before = out
    // Depois de um parêntese de enfeite só vem mais enfeite: "Evidências (Ao Vivo) DVD 50 Anos".
    out = out.replace(/\s*[([{]([^()[\]{}]*)[)\]}].*$/, (rest: string, inner: string, offset: number) => (offset > 0 && DECORATION.test(normalize(inner)) ? '' : rest))
    out = out.replace(/\s*[([{][^()[\]{}]*[)\]}]\s*$/, (group: string, offset: number) => (offset > 0 ? '' : group))
    const cut = /^(.*\S)\s+[-–—|]\s+([^-–—|]+)$/.exec(out)
    if (cut && DECORATION.test(normalize(cut[2]))) out = cut[1]
    out = out.replace(/\s+(?:feat\.?|ft\.?|featuring|part\.|participa[cç][aã]o(?:\s+especial)?(?:\s+de)?)\s+\S.*$/i, '')
    if (out === before) break
  }
  return out.trim() || raw.trim()
}

/** O começo do nome, até o primeiro separador ou parêntese: "Evidências | Show Completo" vira "Evidências". */
export function titleHead(raw: string): string {
  return raw.trim().split(/\s+[-–—|:]\s+|\s*[([{]/)[0]?.trim() || raw.trim()
}

/** O primeiro artista de uma lista ("A, B" ou "A feat. B"). Duplas com "&" ou "e" ficam inteiras. */
export function firstArtist(raw: string): string {
  return raw.split(/\s*[,;]\s*|\s+\/\s+|\s+(?:feat\.?|ft\.?|featuring|part\.)\s+/i)[0]?.trim() ?? ''
}

/** Cada artista de um nome composto, para conferir um por um. */
export function artistParts(raw: string): string[] {
  return raw
    .split(/\s*[,;/&]\s*|\s+(?:e|and|feat\.?|ft\.?|featuring|part\.|x)\s+/i)
    .map((part) => part.trim())
    .filter(Boolean)
}

/**
 * Texto de busca sem as palavras que só existem em título de vídeo. O banco de letras exige
 * todas as palavras da busca, então "clipe oficial" a mais zera o resultado.
 */
export function searchText(text: string): string {
  const all = tokens(text)
  const useful = all.filter((token) => !FILLER.has(token))
  return (useful.length > 0 ? useful : all).join(' ')
}

/** Similaridade por palavras em comum, de 0 a 1. */
export function similarity(a: string, b: string): number {
  const ta = new Set(normalize(a).split(' ').filter(Boolean))
  const tb = new Set(normalize(b).split(' ').filter(Boolean))
  if (ta.size === 0 || tb.size === 0) return 0
  let shared = 0
  for (const token of ta) if (tb.has(token)) shared += 1
  return shared / Math.max(ta.size, tb.size)
}
