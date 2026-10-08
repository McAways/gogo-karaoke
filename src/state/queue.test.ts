import { beforeEach, describe, expect, it, vi } from 'vitest'

// A fila se guarda em window.localStorage, que não existe fora do navegador.
const stored = new Map<string, string>()
vi.stubGlobal('window', {
  localStorage: {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
    removeItem: (key: string) => void stored.delete(key),
  },
})

const { useQueue } = await import('./queue')

const queue = () => useQueue.getState()
const names = () => queue().playlists.map((playlist) => playlist.name)

beforeEach(() => {
  useQueue.setState({ items: [], playlists: [] })
})

describe('playlists', () => {
  it('cria com a primeira música e recusa nome vazio ou repetido', () => {
    const id = queue().createPlaylist('  Sexta à noite ', ['a'])
    expect(id).toBeTruthy()
    expect(queue().playlists).toEqual([{ id, name: 'Sexta à noite', songIds: ['a'] }])
    expect(queue().createPlaylist('   ', ['b'])).toBeNull()
    expect(queue().createPlaylist('SEXTA À NOITE', ['b'])).toBeNull()
    expect(names()).toEqual(['Sexta à noite'])
  })

  it('adiciona uma música uma vez só', () => {
    const id = queue().createPlaylist('Festa', ['a'])!
    expect(queue().addToPlaylist(id, 'b')).toBe(true)
    expect(queue().addToPlaylist(id, 'b')).toBe(false)
    expect(queue().addToPlaylist('não existe', 'c')).toBe(false)
    expect(queue().playlists[0].songIds).toEqual(['a', 'b'])
  })

  it('tira a música pela posição, sem levar a repetida junto', () => {
    queue().upsertPlaylist('Festa', ['a', 'b', 'a'])
    const { id } = queue().playlists[0]
    queue().removeFromPlaylist(id, 0)
    expect(queue().playlists[0].songIds).toEqual(['b', 'a'])
    // Fica vazia, mas continua existindo: quem exclui é a pessoa.
    queue().removeFromPlaylist(id, 0)
    queue().removeFromPlaylist(id, 0)
    expect(queue().playlists).toEqual([{ id, name: 'Festa', songIds: [] }])
  })

  it('guarda o álbum trazido inteiro como álbum, e atualiza sem trocar de identidade', () => {
    queue().upsertPlaylist('Random Access Memories, de Daft Punk', ['a'], { kind: 'album', album: 'Random Access Memories', artist: 'Daft Punk' })
    const first = queue().playlists[0]
    expect(first).toMatchObject({ kind: 'album', album: 'Random Access Memories', artist: 'Daft Punk', songIds: ['a'] })
    queue().upsertPlaylist('Random Access Memories, de Daft Punk', ['a', 'b'], { kind: 'album', album: 'Random Access Memories', artist: 'Daft Punk' })
    expect(queue().playlists).toHaveLength(1)
    expect(queue().playlists[0]).toMatchObject({ id: first.id, kind: 'album', songIds: ['a', 'b'] })
  })

  it('ao abrir um pacote, junta com a playlist de mesmo nome em vez de trocar', () => {
    queue().upsertPlaylist('Festa', ['a', 'b'])
    const { id } = queue().playlists[0]
    // O que já estava continua, na ordem; do pacote entra só o que faltava.
    queue().mergePlaylist('festa', ['b', 'c', 'd'])
    expect(queue().playlists).toEqual([{ id, name: 'Festa', songIds: ['a', 'b', 'c', 'd'] }])
    // Sem playlist com esse nome, cria. Um álbum chega como álbum.
    queue().mergePlaylist('Disco, de Banda', ['x'], { kind: 'album', album: 'Disco', artist: 'Banda' })
    expect(queue().playlists[1]).toMatchObject({ name: 'Disco, de Banda', songIds: ['x'], kind: 'album', album: 'Disco', artist: 'Banda' })
    queue().mergePlaylist('Vazia', [])
    expect(names()).toEqual(['Festa', 'Disco, de Banda'])
  })

  it('a música excluída da biblioteca sai da fila e das playlists', () => {
    queue().upsertPlaylist('Festa', ['a', 'b'])
    queue().add('a')
    queue().add('b')
    queue().forget('a')
    expect(queue().items.map((item) => item.songId)).toEqual(['b'])
    expect(queue().playlists[0].songIds).toEqual(['b'])
  })
})

describe('fila', () => {
  it('"cantar agora" põe o conjunto na frente, na ordem, sem tirar o que já estava', () => {
    queue().add('x')
    queue().playNext(['a', 'b'])
    expect(queue().items.map((item) => item.songId)).toEqual(['a', 'b', 'x'])
    // A que começou a tocar sai da frente; as outras do conjunto vêm em seguida.
    queue().started('a')
    expect(queue().items.map((item) => item.songId)).toEqual(['b', 'x'])
  })
})
