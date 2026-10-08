import { describe, expect, it } from 'vitest'
import { MIN_VIDEO_SCORE, buildExport, findInLibrary, parseExport, rankVideos, spotifyLinkKind, tidyTrackTitle, videoScore } from './transfer'
import type { LyricsDoc, MelodyDoc, Song } from './types'

const song = (id: string, title: string, artist: string, videoId: string | null): Song => ({
  id,
  title,
  artist,
  duration: 200,
  mediaKind: 'audio',
  mediaFile: `${id}.m4a`,
  mime: 'audio/mp4',
  size: 1000,
  source: videoId ? { type: 'youtube', url: `https://www.youtube.com/watch?v=${videoId}`, videoId } : { type: 'file', name: `${title}.mp3` },
  addedAt: 1,
  lyrics: 'none',
  lyricOffset: 0.3,
  melody: 'ready',
  plays: 4,
})

const lyricsOf = (songId: string): LyricsDoc => ({
  songId,
  lines: [{ start: 1, end: 3, text: 'Bom dia', words: [{ text: 'Bom', start: 1, end: 1.5 }, { text: 'dia', start: 1.5, end: 3 }] }],
  level: 'word',
  source: 'lrclib',
  lrclibId: 77,
  timing: 'audio',
  alignment: { at: 5, score: 0.3, heard: 0.9, tied: 0 },
  previous: { lines: [], level: 'line', lyricOffset: 0 },
  updatedAt: 9,
})

describe('lista exportada', () => {
  it('vai e volta sem perder de onde veio a música, a letra nem as playlists', () => {
    const songs = [song('a', 'Evidências', 'Chitãozinho & Xororó', 'vid00000001'), song('b', 'Do Computador', 'Eu', null), song('c', 'Outra', 'Alguém', 'vid00000003')]
    const melody: MelodyDoc = { songId: 'c', source: 'ultrastar', notes: [{ start: 1, end: 2, midi: 60, conf: 1 }], version: 1 }
    const file = buildExport({
      name: 'Minha biblioteca',
      songs,
      lyrics: new Map([['a', lyricsOf('a')]]),
      melodies: new Map([['c', melody]]),
      playlists: [
        { name: 'Sertanejo', songIds: ['a', 'sumiu', 'c'] },
        { name: 'Vazia', songIds: ['sumiu'] },
      ],
      now: 123,
    })
    const back = parseExport(JSON.stringify(file))

    expect(back.name).toBe('Minha biblioteca')
    expect(back.songs.map((s) => s.title)).toEqual(['Evidências', 'Do Computador', 'Outra'])
    expect(back.songs[0].source).toEqual({ type: 'youtube', url: 'https://www.youtube.com/watch?v=vid00000001', videoId: 'vid00000001' })
    expect(back.songs[0].lyricOffset).toBe(0.3)
    expect(back.songs[0].lyrics?.timing).toBe('audio')
    expect(back.songs[0].lyrics?.lines[0].words[1]).toEqual({ text: 'dia', start: 1.5, end: 3 })
    // A sincronia anterior não viaja: só serve para desfazer no aparelho de origem.
    expect(JSON.stringify(file)).not.toContain('previous')
    expect(back.songs[1].source).toEqual({ type: 'file', name: 'Do Computador.mp3' })
    // Notas anotadas à mão viajam; o guia tirado do áudio, não.
    expect(back.songs[2].notes).toHaveLength(1)
    expect(back.songs[0].notes).toBeUndefined()
    // A música que sumiu da biblioteca sai da playlist, e a playlist que ficou vazia sai da lista.
    expect(back.playlists).toEqual([{ name: 'Sertanejo', songs: [0, 2] }])
  })

  it('recusa arquivo que não é do app, com mensagem clara', () => {
    expect(() => parseExport('isto não é json')).toThrow('não é uma lista exportada')
    expect(() => parseExport('{"songs":[]}')).toThrow('não é uma lista exportada')
    expect(() => parseExport(JSON.stringify({ app: 'gogo-karaoke', kind: 'lista', version: 1, songs: [] }))).toThrow('não tem nenhuma música')
    expect(() => parseExport(JSON.stringify({ app: 'gogo-karaoke', kind: 'lista', version: 9, songs: [{}] }))).toThrow('versão mais nova')
  })

  it('pula músicas quebradas e acerta as posições das playlists', () => {
    const file = {
      app: 'gogo-karaoke',
      kind: 'lista',
      version: 1,
      songs: [
        { title: 'Boa', artist: 'A', source: { type: 'youtube', url: 'u', videoId: 'v1' } },
        { title: '', source: { type: 'youtube', url: 'u', videoId: 'v2' } },
        { title: 'Sem origem' },
        { title: 'Outra boa', source: { type: 'file', name: 'x.mp3' }, lyrics: { lines: 'errado' } },
      ],
      playlists: [{ name: 'P', songs: [0, 1, 3, 'x'] }],
    }
    const back = parseExport(JSON.stringify(file))
    expect(back.songs.map((s) => s.title)).toEqual(['Boa', 'Outra boa'])
    expect(back.songs[1].lyrics).toBeUndefined()
    expect(back.playlists).toEqual([{ name: 'P', songs: [0, 1] }])
  })
})

describe('achar o vídeo de uma faixa', () => {
  const track = { title: 'Evidências', artist: 'Chitãozinho & Xororó', duration: 281 }
  const videos = [
    { id: 'live', title: 'Chitãozinho & Xororó - Evidências (Ao Vivo)', channel: 'ClassicoVEVO', duration: 347 },
    { id: 'karaoke', title: 'Evidências - Chitãozinho e Xororó (Karaokê)', channel: 'Karaokê Total', duration: 283 },
    { id: 'album', title: 'Chitãozinho & Xororó - Evidências', channel: 'Chitãozinho & Xororó', duration: 281 },
    { id: 'cover', title: 'EVIDÊNCIAS (cover) Fulano', channel: 'Fulano', duration: 280 },
    { id: 'other', title: 'Sandy, Xororó - Meu Disfarce', channel: 'Sandy', duration: 240 },
  ]

  it('prefere a gravação com a mesma duração e deixa versões alternativas para trás', () => {
    const ranked = rankVideos(track, videos)
    expect(ranked[0].id).toBe('album')
    // Karaokê e cover têm o nome e a duração certos, mas não são a gravação: nunca passam do mínimo.
    expect(videoScore(track, videos[1])).toBeLessThan(MIN_VIDEO_SCORE)
    expect(videoScore(track, videos[3])).toBeLessThan(MIN_VIDEO_SCORE)
    expect(videoScore(track, videos[2])).toBeGreaterThan(MIN_VIDEO_SCORE)
    expect(videoScore(track, videos[4])).toBeLessThan(MIN_VIDEO_SCORE)
  })

  it('aceita a versão ao vivo quando é ela que foi pedida', () => {
    const live = { title: 'Evidências (Ao Vivo)', artist: 'Chitãozinho & Xororó', duration: 347 }
    expect(rankVideos(live, videos)[0].id).toBe('live')
  })

  it('sem duração conhecida, decide pelo nome e pelo artista', () => {
    const ranked = rankVideos({ title: 'Evidências', artist: 'Chitãozinho & Xororó', duration: 0 }, videos)
    expect(['album', 'live']).toContain(ranked[0].id)
    // A música de outro nome, o karaokê e o cover ficam abaixo do mínimo: nenhum é baixado sozinho.
    for (const id of ['other', 'karaoke', 'cover']) expect(videoScore({ ...track, duration: 0 }, videos.find((v) => v.id === id)!)).toBeLessThan(MIN_VIDEO_SCORE)
  })
})

describe('apoio', () => {
  it('acha na biblioteca pelo vídeo ou pelo nome', () => {
    const songs = [song('a', 'Evidências', 'Chitãozinho & Xororó', 'vid00000001'), song('b', 'Do Computador', '', null)]
    expect(findInLibrary({ title: 'outro nome', artist: '', videoId: 'vid00000001' }, songs)?.id).toBe('a')
    expect(findInLibrary({ title: 'EVIDENCIAS', artist: 'chitaozinho xororo' }, songs)?.id).toBe('a')
    expect(findInLibrary({ title: 'do computador', artist: 'Qualquer' }, songs)?.id).toBe('b')
    expect(findInLibrary({ title: 'Evidências', artist: 'Outro Artista' }, songs)).toBeUndefined()
  })

  it('tira do nome da faixa o que é só etiqueta de catálogo', () => {
    expect(tidyTrackTitle('Dreams - 2004 Remaster')).toBe('Dreams')
    expect(tidyTrackTitle('Another One Bites The Dust - Remastered 2011')).toBe('Another One Bites The Dust')
    expect(tidyTrackTitle('Heroes (Single Version)')).toBe('Heroes')
    expect(tidyTrackTitle('Evidências - Ao Vivo')).toBe('Evidências - Ao Vivo')
    expect(tidyTrackTitle('Garota de Ipanema (Acústico)')).toBe('Garota de Ipanema (Acústico)')
    expect(tidyTrackTitle('Anna Júlia')).toBe('Anna Júlia')
    expect(tidyTrackTitle('Hip-Hop - Rap')).toBe('Hip-Hop - Rap')
  })

  it('reconhece links do Spotify de playlist, de álbum e de música', () => {
    expect(spotifyLinkKind('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=abc')).toBe('playlist')
    expect(spotifyLinkKind('https://open.spotify.com/intl-pt/playlist/37i9dQZF1DXcBWIGoYBM5M')).toBe('playlist')
    expect(spotifyLinkKind('spotify:playlist:37i9dQZF1DXcBWIGoYBM5M')).toBe('playlist')
    expect(spotifyLinkKind('https://open.spotify.com/intl-pt/album/0ETFjACtuP2ADo6LFhL6HN?si=xyz')).toBe('album')
    expect(spotifyLinkKind('spotify:album:0ETFjACtuP2ADo6LFhL6HN')).toBe('album')
    expect(spotifyLinkKind('https://open.spotify.com/track/11hcBLPtbMp4aQI6zGQLub')).toBe('track')
    // Artista, podcast e texto comum não são lidos: caem na busca normal ou num aviso.
    expect(spotifyLinkKind('https://open.spotify.com/artist/06HL4z0CvFAxyc27GXpf02')).toBeNull()
    expect(spotifyLinkKind('Evidências')).toBeNull()
  })
})
