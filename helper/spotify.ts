import { HelperError } from './ytdlp.ts'

/**
 * Lista de faixas de um link do Spotify: playlist pública, álbum ou uma música só.
 *
 * Não usa a API de desenvolvedor nem pede login: lê a página de incorporação do link (a mesma
 * que aparece embutida em sites), que traz o nome, o dono e as faixas. Daqui saem só nome,
 * artista e duração de cada faixa; o áudio nunca vem do Spotify.
 *
 * Limites: playlist só se for pública, e a página traz no máximo 100 faixas. É uma página, não
 * um serviço com contrato: se o Spotify mudar o formato dela, isto para de funcionar.
 */

export type SpotifyKind = 'playlist' | 'album' | 'track'

export interface SpotifyTrack {
  title: string
  artist: string
  /** Segundos. */
  duration: number
}

export interface SpotifyList {
  kind: SpotifyKind
  id: string
  /** Nome da playlist, do álbum ou da música. */
  name: string
  /** Dono da playlist, ou artista do álbum ou da música. */
  owner: string
  tracks: SpotifyTrack[]
  /** true quando a página veio com 100 faixas: é provável que haja mais. */
  truncated: boolean
}

/** Quantas faixas a página de incorporação traz, no máximo. */
const PAGE_LIMIT = 100
const LINK = /(?:open\.spotify\.com\/(?:intl-[a-z-]+\/)?(?:embed\/)?(playlist|album|track)\/|spotify:(playlist|album|track):)([A-Za-z0-9]{16,40})/

const NOT_FOUND: Record<SpotifyKind, string> = {
  playlist: 'Não achei as faixas dessa playlist. Ela precisa ser pública; se for, o Spotify pode ter mudado a página.',
  album: 'Não achei as faixas desse álbum. O link pode estar errado, ou o Spotify pode ter mudado a página.',
  track: 'Não achei essa música no Spotify. O link pode estar errado, ou o Spotify pode ter mudado a página.',
}

// Vários artistas vêm separados por vírgula e espaço não separável.
const tidy = (text: unknown): string => (typeof text === 'string' ? text.replace(/ /g, ' ').replace(/\s+/g, ' ').trim() : '')
const seconds = (ms: unknown): number => (typeof ms === 'number' && ms > 0 ? Math.round(ms / 1000) : 0)

export async function spotifyTracks(link: string): Promise<SpotifyList> {
  const match = LINK.exec(link.trim())
  if (!match) {
    throw new HelperError(400, /open\.spotify\.com|^spotify:/.test(link.trim()) ? 'Do Spotify, só leio links de playlist, de álbum ou de música.' : 'Esse não parece um link do Spotify.')
  }
  const kind = (match[1] ?? match[2]) as SpotifyKind
  const id = match[3]

  let html: string
  try {
    const res = await fetch(`https://open.spotify.com/embed/${kind}/${id}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36',
        'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
      },
      signal: AbortSignal.timeout(25_000),
    })
    if (!res.ok) throw new HelperError(502, `O Spotify respondeu com erro (${res.status}).`)
    html = await res.text()
  } catch (err) {
    if (err instanceof HelperError) throw err
    throw new HelperError(502, 'Não deu para abrir o link no Spotify. Confira a internet e tente de novo.')
  }

  const raw = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html)?.[1]
  let entity: Record<string, unknown> | null = null
  try {
    const data = JSON.parse(raw ?? 'null') as { props?: { pageProps?: { state?: { data?: { entity?: Record<string, unknown> } } } } } | null
    entity = data?.props?.pageProps?.state?.data?.entity ?? null
  } catch {
    entity = null
  }
  if (!entity) throw new HelperError(404, NOT_FOUND[kind])

  // Uma música só: a página traz os dados dela direto, sem lista de faixas.
  if (kind === 'track') {
    const title = tidy(entity.name) || tidy(entity.title)
    if (!title) throw new HelperError(404, NOT_FOUND.track)
    const artist = (Array.isArray(entity.artists) ? entity.artists : []).map((item) => tidy((item as { name?: unknown } | null)?.name)).filter(Boolean).join(', ')
    return { kind, id, name: title, owner: artist, tracks: [{ title, artist, duration: seconds(entity.duration) }], truncated: false }
  }

  if (!Array.isArray(entity.trackList)) throw new HelperError(404, NOT_FOUND[kind])
  const tracks: SpotifyTrack[] = []
  for (const item of entity.trackList as Array<Record<string, unknown>>) {
    // A playlist pode ter episódios de podcast no meio: só faixas de música interessam.
    if (item.entityType !== undefined && item.entityType !== 'track') continue
    const title = tidy(item.title)
    if (!title) continue
    tracks.push({ title, artist: tidy(item.subtitle), duration: seconds(item.duration) })
  }
  if (tracks.length === 0) throw new HelperError(404, kind === 'album' ? 'Esse álbum veio sem faixas.' : 'Essa playlist está vazia ou não tem faixas de música.')

  return {
    kind,
    id,
    name: tidy(entity.name) || (kind === 'album' ? 'Álbum do Spotify' : 'Playlist do Spotify'),
    owner: tidy(entity.subtitle),
    tracks,
    truncated: (entity.trackList as unknown[]).length >= PAGE_LIMIT,
  }
}
