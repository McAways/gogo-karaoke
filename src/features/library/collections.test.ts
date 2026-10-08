import { describe, expect, it } from 'vitest'
import type { Song } from '@/lib/types'
import type { Playlist } from '@/state/queue'
import { buildCollections, totalDuration } from './collections'

const song = (id: string, title: string, artist: string, album?: string, addedAt = 1): Song => ({
  id,
  title,
  artist,
  ...(album ? { album } : {}),
  duration: 200,
  mediaKind: 'audio',
  mediaFile: `${id}.m4a`,
  mime: 'audio/mp4',
  size: 1,
  source: { type: 'file', name: `${id}.mp3` },
  addedAt,
  lyrics: 'none',
  lyricOffset: 0,
  melody: 'ready',
  plays: 0,
})

describe('álbuns e playlists da biblioteca', () => {
  const songs = [
    song('a', 'Come Together', 'The Beatles', 'Abbey Road', 3),
    song('b', 'Something', 'The Beatles', 'Abbey Road', 1),
    song('c', 'Evidências', 'Chitãozinho & Xororó', 'Cowboy do Asfalto'),
    song('d', 'Solta', 'Alguém'),
    song('e', 'Get Lucky', 'Daft Punk', 'Random Access Memories'),
    song('f', 'Instant Crush', 'Daft Punk', 'Random Access Memories'),
    song('g', 'Faixa de coletânea', 'Fulano', 'Sucessos'),
    song('h', 'Outra da coletânea', 'Beltrano', 'Sucessos'),
  ]

  it('mostra as playlists guardadas, na ordem das músicas, sem as que saíram da biblioteca', () => {
    const playlists: Playlist[] = [{ id: 'p1', name: 'Festa', songIds: ['d', 'sumiu', 'a', 'd'] }]
    const [festa] = buildCollections(songs, playlists)
    expect(festa).toMatchObject({ id: 'p-p1', kind: 'playlist', name: 'Festa', artist: '', playlistId: 'p1' })
    // A música repetida na playlist continua repetida; a excluída some.
    expect(festa.songs.map((s) => s.id)).toEqual(['d', 'a', 'd'])
    expect(totalDuration(festa)).toBe(600)
  })

  it('monta sozinho os álbuns com duas músicas ou mais, e não os de uma só', () => {
    const albums = buildCollections(songs, []).filter((c) => c.kind === 'album')
    expect(albums.map((c) => c.name)).toEqual(['Abbey Road', 'Random Access Memories', 'Sucessos'])
    const abbey = albums[0]
    expect(abbey.artist).toBe('The Beatles')
    expect(abbey.playlistId).toBeUndefined()
    // Sem número de faixa, a ordem é a de chegada na biblioteca.
    expect(abbey.songs.map((s) => s.id)).toEqual(['b', 'a'])
    expect(albums[2].artist).toBe('Vários artistas')
  })

  it('não repete o álbum que foi trazido inteiro', () => {
    const playlists: Playlist[] = [{ id: 'p2', name: 'Random Access Memories, de Daft Punk', songIds: ['e', 'f'], kind: 'album', album: 'Random Access Memories', artist: 'Daft Punk' }]
    const all = buildCollections(songs, playlists)
    const ram = all.filter((c) => c.name === 'Random Access Memories')
    expect(ram).toHaveLength(1)
    expect(ram[0]).toMatchObject({ id: 'p-p2', kind: 'album', artist: 'Daft Punk', playlistId: 'p2' })
  })

  it('junta o mesmo álbum escrito com caixa ou acento diferente', () => {
    const mixed = [song('x', 'Uma', 'Banda', 'Coração Valente'), song('y', 'Duas', 'Banda', 'coracao valente')]
    const albums = buildCollections(mixed, [])
    expect(albums).toHaveLength(1)
    expect(albums[0].songs).toHaveLength(2)
  })
})
