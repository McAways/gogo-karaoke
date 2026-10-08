import { normalize } from '@/lib/titles'
import type { Song } from '@/lib/types'
import type { Playlist } from '@/state/queue'

/** Um conjunto de músicas da biblioteca: uma playlist guardada ou um álbum. */
export interface Collection {
  /** Vai no endereço da página: p-<id da playlist> ou a-<nome do álbum, normalizado>. */
  id: string
  kind: 'playlist' | 'album'
  name: string
  /** Artista do álbum. Vazio nas playlists. */
  artist: string
  songs: Song[]
  /** Presente quando o conjunto é uma lista guardada: dá para tirar músicas e excluir. */
  playlistId?: string
}

/**
 * Junta as playlists guardadas com os álbuns da biblioteca.
 *
 * Álbum aparece de dois jeitos: o que foi trazido inteiro (de um link de álbum do Spotify) e o
 * que o app monta sozinho quando duas ou mais músicas dizem ser do mesmo álbum. O segundo não
 * repete o primeiro.
 */
export function buildCollections(songs: readonly Song[], playlists: readonly Playlist[]): Collection[] {
  const byId = new Map(songs.map((song) => [song.id, song]))
  const saved: Collection[] = []
  const broughtWhole = new Set<string>()

  for (const playlist of playlists) {
    const album = playlist.kind === 'album'
    if (album) broughtWhole.add(normalize(playlist.album ?? playlist.name))
    saved.push({
      id: `p-${playlist.id}`,
      kind: album ? 'album' : 'playlist',
      name: album ? (playlist.album ?? playlist.name) : playlist.name,
      artist: album ? (playlist.artist ?? '') : '',
      // A música excluída da biblioteca some daqui; a que entrou duas vezes na playlist continua duas vezes.
      songs: playlist.songIds.flatMap((id) => byId.get(id) ?? []),
      playlistId: playlist.id,
    })
  }

  const groups = new Map<string, Song[]>()
  for (const song of songs) {
    const key = song.album ? normalize(song.album) : ''
    if (!key) continue
    const group = groups.get(key)
    if (group) group.push(song)
    else groups.set(key, [song])
  }
  const found: Collection[] = []
  for (const [key, group] of groups) {
    // Uma música sozinha não faz um álbum: viraria uma tela cheia de álbuns de uma faixa só.
    if (group.length < 2 || broughtWhole.has(key)) continue
    const artists = new Set(group.map((song) => normalize(song.artist)))
    found.push({
      id: `a-${key.replace(/\s+/g, '-')}`,
      kind: 'album',
      name: group[0].album ?? '',
      artist: artists.size === 1 ? group[0].artist : 'Vários artistas',
      songs: [...group].sort((a, b) => a.addedAt - b.addedAt),
    })
  }
  found.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'))

  return [...saved, ...found]
}

/** Duração somada das músicas, em segundos. */
export function totalDuration(collection: Collection): number {
  return collection.songs.reduce((sum, song) => sum + (song.duration > 0 ? song.duration : 0), 0)
}
