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

/** Similaridade por palavras em comum, de 0 a 1. */
export function similarity(a: string, b: string): number {
  const ta = new Set(normalize(a).split(' ').filter(Boolean))
  const tb = new Set(normalize(b).split(' ').filter(Boolean))
  if (ta.size === 0 || tb.size === 0) return 0
  let shared = 0
  for (const token of ta) if (tb.has(token)) shared += 1
  return shared / Math.max(ta.size, tb.size)
}
