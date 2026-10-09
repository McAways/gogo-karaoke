import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { formatLrcTime } from './lrc'
import { LrclibError, distinctMatches, isConfidentMatch, lyricsAvailability, lyricsForVideo, nameEvidence, pacing, pickAutomatic, rankRecords, resemblesSong, searchLyrics, searchLyricsByText, searchSteps, songQuery, videoQuery } from './lrclib'
import type { LrclibRecord } from './lrclib'
import { tokens } from './titles'

let nextId = 1

/** Letra sincronizada com um verso a cada `step` segundos, de `first` a `last`. */
function synced(first: number, last: number, step = 5): string {
  const lines: string[] = []
  for (let t = first; t <= last + 1e-9; t += step) lines.push(`[${formatLrcTime(t)}]verso aos ${t}`)
  return lines.join('\n')
}

function record(fields: Partial<LrclibRecord>): LrclibRecord {
  return {
    id: nextId++,
    trackName: 'Evidências',
    artistName: 'Chitãozinho & Xororó',
    albumName: null,
    duration: 280,
    instrumental: false,
    plainLyrics: 'texto da letra',
    syncedLyrics: null,
    ...fields,
  }
}

const query = { title: 'Evidências', artist: 'Chitãozinho & Xororó', duration: 280 }

describe('escolha da letra', () => {
  it('põe letra sincronizada sempre antes de letra só de texto', () => {
    // O registro de texto tem tudo a favor (nome e duração exatos); o sincronizado, duração bem diferente.
    const plain = record({ duration: 280 })
    const withTimes = record({ duration: 320, syncedLyrics: synced(20, 250) })
    const ranked = rankRecords([plain, withTimes], query)
    expect(ranked.map((m) => m.synced)).toEqual([true, false])
    expect(ranked[0].record.id).toBe(withTimes.id)
  })

  it('aplica sozinha a sincronizada, nunca a de texto', () => {
    const plain = record({ duration: 280 })
    const withTimes = record({ duration: 281, syncedLyrics: synced(20, 250) })
    const choice = pickAutomatic(rankRecords([plain, withTimes], query), query)
    expect(choice?.match.record.id).toBe(withTimes.id)
    expect(choice?.confident).toBe(true)

    expect(pickAutomatic(rankRecords([plain], query), query)).toBeNull()
  })

  it('rebaixa a letra cujo último verso não cabe na gravação', () => {
    // A duração cadastrada bate, mas o último verso começa depois do fim do áudio.
    const tooLong = record({ duration: 280, syncedLyrics: synced(20, 290) })
    const fits = record({ duration: 286, syncedLyrics: synced(12, 255) })
    const ranked = rankRecords([tooLong, fits], query)
    expect(ranked[0].record.id).toBe(fits.id)
    expect(ranked[1].tail).toBeLessThan(0)
    expect(isConfidentMatch(ranked[1], query)).toBe(false)
    expect(isConfidentMatch(ranked[0], query)).toBe(true)
  })

  it('prefere a sincronia que mais se repete no banco e mostra uma linha por sincronia', () => {
    const common = synced(24, 250)
    const rare = synced(12, 240)
    const records = [
      record({ duration: 282, syncedLyrics: rare, albumName: 'Regravação' }),
      ...['Álbum', 'Coletânea', 'Ao Vivo', 'Millennium'].map((albumName) => record({ duration: 282, syncedLyrics: common, albumName })),
      record({ duration: 280 }),
    ]
    const ranked = rankRecords(records, query)
    expect(ranked[0].sameTiming).toHaveLength(4)
    expect(ranked[0].firstVerse).toBe(24)

    const distinct = distinctMatches(ranked)
    expect(distinct.map((m) => (m.synced ? m.sameTiming.length : 0))).toEqual([4, 1, 0])
    expect(distinct[1].firstVerse).toBe(12)
  })

  it('sem candidata confiável, usa a melhor sincronizada e avisa que pode ser outra versão', () => {
    const otherVersion = record({ duration: 330, syncedLyrics: synced(30, 260) })
    const choice = pickAutomatic(rankRecords([otherVersion, record({ duration: 280 })], query), query)
    expect(choice?.match.record.id).toBe(otherVersion.id)
    expect(choice?.confident).toBe(false)
  })

  it('não aplica letra de outra música nem faixa instrumental', () => {
    const otherSong = record({ trackName: 'Fio de Cabelo', syncedLyrics: synced(10, 200) })
    expect(pickAutomatic(rankRecords([otherSong], query), query)).toBeNull()

    const instrumental = record({ instrumental: true, syncedLyrics: synced(10, 200) })
    expect(rankRecords([instrumental], query)).toHaveLength(0)
  })

  it('sem saber a duração do arquivo, vale só o nome', () => {
    const unknown = { ...query, duration: 0 }
    const ranked = rankRecords([record({ duration: 500, syncedLyrics: synced(20, 250) })], unknown)
    expect(ranked[0].tail).toBeNull()
    expect(isConfidentMatch(ranked[0], unknown)).toBe(true)
  })
})

describe('nome que vem do YouTube', () => {
  const liveVideo = videoQuery({ title: 'Marília Mendonça - Bebi Liguei (Todos Os Cantos - Ao Vivo)', channel: 'Marília Mendonça', duration: 160 })

  it('reconhece o registro dentro de um título cheio de enfeite', () => {
    const live = record({ trackName: 'Bebi Liguei - Ao Vivo', artistName: 'Marília Mendonça', albumName: 'Todos Os Cantos, Vol. 1 (Ao Vivo)' })
    expect(nameEvidence(live, liveVideo)).toEqual({ title: 1, artist: 1 })

    // Sem travessão no título, o nome que o app guarda é o texto inteiro, com o artista junto.
    const loose = { title: 'Victor & Leo Borboletas', artist: '', duration: 200 }
    expect(nameEvidence(record({ trackName: 'Borboletas', artistName: 'Victor & Leo' }), loose)).toEqual({ title: 1, artist: 1 })

    const official = videoQuery({ title: 'Marília Mendonça - Estranho (Agora Que São Elas 2 - Vídeo Oficial)', channel: 'Marília Mendonça', duration: 160 })
    expect(nameEvidence(record({ trackName: 'estranho', artistName: 'Marília Mendonça', albumName: 'Agora É Que São Elas 2' }), official)).toEqual({ title: 1, artist: 1 })
  })

  it('aceita um dos artistas de um nome composto, e não um prenome solto', () => {
    const duo = record({ trackName: 'Estranho', artistName: 'Marília Mendonça & Maiara & Maraisa' })
    expect(nameEvidence(duo, { title: 'Estranho', artist: 'Marília Mendonça', duration: 160 }).artist).toBe(1)

    const other = { title: 'Borboletas', artist: 'Leo Santana', duration: 200 }
    expect(nameEvidence(record({ trackName: 'Borboletas', artistName: 'Victor & Leo' }), other).artist).toBeLessThan(0.6)
  })

  it('separa outra música do mesmo artista e música de mesmo nome de outro artista', () => {
    expect(nameEvidence(record({ trackName: 'Infiel', artistName: 'Marília Mendonça' }), liveVideo).title).toBe(0)
    expect(nameEvidence(record({ trackName: 'Bebi Liguei', artistName: 'Outra Dupla' }), liveVideo)).toEqual({ title: 1, artist: 0 })
    // Um nome curto que por acaso aparece no título explica pouco dele.
    const long = { title: 'Todo Mundo Vai Sofrer', artist: 'Marília Mendonça', duration: 180 }
    expect(nameEvidence(record({ trackName: 'Sofrer', artistName: 'Marília Mendonça' }), long).title).toBeLessThan(0.7)
  })

  it('sem nada além do nome da música, o artista não tem como ser conferido', () => {
    expect(nameEvidence(record({}), { title: 'Evidências (Ao Vivo)', artist: '', duration: 0 })).toEqual({ title: 1, artist: null })
  })

  it('não confia em música de mesmo nome quando o artista é outro', () => {
    const video = videoQuery({ title: 'Victor & Leo - Borboletas (Video Clipe)', channel: 'Victor e Leo', duration: 200 })
    const sameLength = record({ trackName: 'Borboletas', artistName: 'Outra Banda', duration: 201, syncedLyrics: synced(10, 180) })
    const choice = pickAutomatic(rankRecords([sameLength], video), video)
    expect(choice?.confident).toBe(false)

    const otherLength = record({ trackName: 'Borboletas', artistName: 'Outra Banda', duration: 240, syncedLyrics: synced(10, 180) })
    expect(pickAutomatic(rankRecords([otherLength], video), video)).toBeNull()

    const right = record({ trackName: 'Borboletas', artistName: 'Victor & Leo', duration: 202, syncedLyrics: synced(10, 180) })
    expect(pickAutomatic(rankRecords([sameLength, otherLength, right], video), video)).toMatchObject({ confident: true, match: { record: { id: right.id } } })
  })

  it('usa o título do vídeo guardado na música, a não ser que ela tenha sido renomeada para outra', () => {
    const source = { type: 'youtube' as const, url: 'u', videoId: 'v', channel: 'Marília Mendonça', title: 'Marília Mendonça - Bebi Liguei (Todos Os Cantos - Ao Vivo)' }
    const kept = songQuery({ title: 'Bebi Liguei - Ao Vivo', artist: 'Marília Mendonça', duration: 160, source })
    expect(kept).toMatchObject({ videoTitle: source.title, channel: 'Marília Mendonça' })

    const renamed = songQuery({ title: 'Evidências', artist: 'Chitãozinho & Xororó', duration: 160, source })
    expect(renamed.videoTitle).toBeUndefined()

    const file = songQuery({ title: 'Tempo Perdido', artist: 'Legião Urbana', duration: 300, source: { type: 'file', name: '03 - Legião Urbana - Tempo Perdido (Ao Vivo).mp3' } }, 'tempo perdido')
    expect(file).toMatchObject({ videoTitle: '03 - Legião Urbana - Tempo Perdido (Ao Vivo)', typed: 'tempo perdido' })
  })

  it('nome curto que só aparece dentro do nome da música não passa por ela', () => {
    const song = { title: 'Rua da Voz', artist: 'Banda Imaginária', duration: 18 }
    const [inside] = rankRecords([record({ trackName: 'Voz', artistName: 'Outro Artista', duration: 200 })], song)
    expect(resemblesSong(inside)).toBe(false)
    // Com o nome inteiro, é candidata mesmo de outro artista: pode ser uma regravação, e quem escolhe é a pessoa.
    const [same] = rankRecords([record({ trackName: 'Rua da Voz', artistName: 'Outro Artista', duration: 200 })], song)
    expect(resemblesSong(same)).toBe(true)
    // E quando só se conhece o nome da música, não há artista para desmentir.
    const [unknown] = rankRecords([record({ trackName: 'Voz', artistName: 'Outro Artista', duration: 200 })], { ...song, artist: '' })
    expect(resemblesSong(unknown)).toBe(true)
  })

  it('entre a gravação de estúdio e a ao vivo, fica com a que o vídeo diz ser', () => {
    const studio = record({ trackName: 'Bebi Liguei', artistName: 'Marília Mendonça', duration: 158, syncedLyrics: synced(10, 140) })
    const live = record({ trackName: 'Bebi Liguei - Ao Vivo', artistName: 'Marília Mendonça', duration: 158, syncedLyrics: synced(14, 140) })
    expect(rankRecords([studio, live], liveVideo)[0].record.id).toBe(live.id)
  })
})

/**
 * Banco de mentira com a regra do de verdade: só devolve o registro que tem todas as palavras
 * da busca. `busy` é quantos pedidos ele responde "ocupado" antes de voltar a atender.
 */
function fakeBank(records: LrclibRecord[], busy = 0) {
  const asked: string[] = []
  let running = 0
  let left = busy
  const state = { asked, mostAtOnce: 0 }
  const has = (field: string, text: string | null) => !text || tokens(text).every((word) => tokens(field).includes(word))
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const params = new URL(String(input)).searchParams
    asked.push([...params].map(([name, value]) => `${name}=${value}`).join('&'))
    state.mostAtOnce = Math.max(state.mostAtOnce, ++running)
    await new Promise((resolve) => setTimeout(resolve, 2))
    running--
    if (left > 0) {
      left--
      return new Response('{}', { status: 503 })
    }
    const found = records.filter(
      (r) => has(`${r.trackName} ${r.artistName} ${r.albumName ?? ''}`, params.get('q')) && has(r.trackName, params.get('track_name')) && has(r.artistName, params.get('artist_name')),
    )
    return new Response(JSON.stringify(found.slice(0, 20)))
  })
  return state
}

describe('busca em degraus', () => {
  beforeAll(() => {
    pacing.gapMs = 0
    pacing.retryMs = 0
  })
  afterEach(() => vi.unstubAllGlobals())

  const studio = record({ duration: 280, syncedLyrics: synced(20, 250) })
  const live = record({ trackName: 'Evidências - Ao Vivo', duration: 343, syncedLyrics: synced(25, 310) })
  const cover = record({ artistName: 'Dalila', duration: 252, syncedLyrics: synced(15, 230) })
  const dvd = {
    title: 'Evidências (Ao Vivo) DVD 50 Anos',
    artist: 'Chitãozinho & Xororó, Zezé Di Camargo',
    duration: 343,
    videoTitle: 'Chitãozinho & Xororó - Evidências (Ao Vivo) | DVD 50 Anos',
  }

  it('vai do mais exato ao mais aberto, sem repetir pedido e só com o primeiro artista', () => {
    const steps = searchSteps({ ...dvd, typed: 'evidencias chitaozinho clipe oficial' })
    expect(steps[0]).toEqual({ track_name: 'Evidências ao vivo', artist_name: 'Chitãozinho & Xororó' })
    expect(steps).toContainEqual({ track_name: 'Evidências', artist_name: 'Chitãozinho & Xororó' })
    expect(steps).toContainEqual({ q: 'evidencias chitaozinho' })
    expect(steps.at(-1)).toEqual({ q: 'evidencias' })
    expect(new Set(steps.map((step) => JSON.stringify(step))).size).toBe(steps.length)
    expect(JSON.stringify(steps)).not.toContain('Zezé')
  })

  it('acha a letra mesmo quando o nome guardado tem palavras que o banco não conhece', async () => {
    const bank = fakeBank([studio, live, cover])
    // "Show Completo 50 Anos" não é enfeite que o app conheça: vai inteiro nos primeiros pedidos.
    const show = { ...dvd, title: 'Evidências | Show Completo 50 Anos', videoTitle: 'Chitãozinho & Xororó - Evidências | Show Completo 50 Anos' }
    const matches = await searchLyrics(show)
    expect(pickAutomatic(matches, show)).toMatchObject({ confident: true, match: { record: { id: live.id } } })
    // O primeiro degrau volta vazio por causa das palavras a mais; o do começo do nome acha, e a busca para.
    expect(bank.asked).toEqual(['track_name=Evidências | Show Completo 50 Anos&artist_name=Chitãozinho & Xororó', 'track_name=Evidências&artist_name=Chitãozinho & Xororó'])

    // Com enfeite conhecido, o primeiro pedido já sai limpo.
    bank.asked.length = 0
    expect(pickAutomatic(await searchLyrics(dvd), dvd)).toMatchObject({ confident: true, match: { record: { id: live.id } } })
    expect(bank.asked).toEqual(['track_name=Evidências ao vivo&artist_name=Chitãozinho & Xororó'])
  })

  it('para no primeiro degrau quando o nome já vem limpo', async () => {
    const bank = fakeBank([studio, live, cover])
    const matches = await searchLyrics(query)
    expect(pickAutomatic(matches, query)).toMatchObject({ confident: true, match: { record: { id: studio.id } } })
    expect(bank.asked).toEqual(['track_name=Evidências&artist_name=Chitãozinho & Xororó'])
  })

  it('repete o pedido quando o banco responde ocupado', async () => {
    const bank = fakeBank([studio], 2)
    const matches = await searchLyrics(query)
    expect(matches).toHaveLength(1)
    expect(bank.asked).toHaveLength(3)
  })

  it('com o banco fora do ar, a letra achada antes do download continua valendo', async () => {
    fakeBank([], Infinity)
    await expect(searchLyrics(query)).rejects.toBeInstanceOf(LrclibError)
    const kept = await searchLyrics(dvd, undefined, [live])
    expect(kept.map((match) => match.record.id)).toEqual([live.id])
  })

  it('manda um pedido de cada vez, mesmo com várias músicas procurando letra juntas', async () => {
    const bank = fakeBank([studio, live, cover])
    await Promise.all([searchLyrics(query), searchLyrics(dvd), searchLyrics({ ...query, title: 'Fio de Cabelo' })])
    expect(bank.mostAtOnce).toBe(1)
  })

  it('a busca com as palavras da pessoa não inventa degraus', async () => {
    const bank = fakeBank([studio, live, cover])
    const matches = await searchLyricsByText('Evidências Dalila (letra)', 252)
    expect(matches.map((match) => match.record.id)).toEqual([cover.id])
    expect(bank.asked).toEqual(['q=evidencias dalila'])
  })
})

describe('letra conferida antes de baixar', () => {
  beforeAll(() => {
    pacing.gapMs = 0
    pacing.retryMs = 0
  })
  afterEach(() => vi.unstubAllGlobals())

  const studio = record({ duration: 280, syncedLyrics: synced(20, 250) })
  const cover = record({ artistName: 'Dalila', duration: 252, syncedLyrics: synced(15, 230) })
  const textOnly = record({ trackName: 'Fio de Cabelo', duration: 200 })
  const videos = [
    { id: 'oficial', title: 'Chitãozinho & Xororó - Evidências (Clipe Oficial)', channel: 'Chitãozinho & Xororó', duration: 281 },
    { id: 'show', title: 'Chitãozinho & Xororó - Evidências (Ao Vivo em Goiânia)', channel: 'Chitãozinho & Xororó', duration: 352 },
    { id: 'outra', title: 'Chitãozinho & Xororó - Fio de Cabelo', channel: 'Chitãozinho & Xororó', duration: 200 },
    { id: 'dalila', title: 'Dalila - Evidencias', channel: 'Dalila Oficial', duration: 252 },
  ]

  it('diz que letra cada vídeo tem, com um pedido só, e entrega as letras', async () => {
    const bank = fakeBank([studio, cover, textOnly])
    const found = await lyricsAvailability('evidencias', videos)
    expect(bank.asked).toEqual(['q=evidencias'])
    expect(found.get('oficial')).toMatchObject({ kind: 'exata', matches: [{ record: { id: studio.id } }] })
    expect(found.get('show')?.kind).toBe('outra')
    // A letra de cada vídeo é a do artista dele, não a primeira de mesmo nome.
    expect(found.get('dalila')).toMatchObject({ kind: 'exata', matches: [{ record: { id: cover.id } }] })
    expect(found.has('outra')).toBe(false)
  })

  it('o que foi digitado vale para reconhecer o artista de um vídeo que não o cita', async () => {
    fakeBank([studio, cover])
    const bare = [{ id: 'selo', title: 'Evidências (Áudio Oficial)', channel: 'Som Livre', duration: 280 }]
    expect((await lyricsAvailability('evidencias', bare)).has('selo')).toBe(false)
    expect((await lyricsAvailability('evidencias chitaozinho', bare)).get('selo')?.kind).toBe('exata')
  })

  it('a letra que a tela mostra passa na importação, que já conhece os dados de música do YouTube', async () => {
    fakeBank([studio, cover])
    const found = (await lyricsAvailability('evidencias chitaozinho', videos)).get('oficial')!
    // Depois do download o app guarda o nome que o YouTube informa, e ele pode vir diferente.
    const afterDownload = { title: 'Evidências - Remasterizado', artist: 'Chitãozinho & Xororó, Zezé Di Camargo', duration: 281, videoTitle: videos[0].title, channel: videos[0].channel, typed: 'evidencias chitaozinho' }
    const records = found.matches.map((match) => match.record)
    expect(pickAutomatic(rankRecords(records, afterDownload), afterDownload)).toMatchObject({ confident: true, match: { record: { id: studio.id } } })
  })

  it('link colado: um vídeo só, busca completa', async () => {
    const bank = fakeBank([studio, cover])
    const found = await lyricsForVideo({ id: 'colado', title: 'Chitãozinho & Xororó - Evidências (Clipe Oficial) [4K]', channel: 'Chitãozinho & Xororó', duration: 280 })
    expect(found.get('colado')?.kind).toBe('exata')
    expect(bank.asked[0]).toBe('track_name=Evidências&artist_name=Chitãozinho & Xororó')
  })
})
