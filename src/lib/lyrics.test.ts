import { describe, expect, it } from 'vitest'
import { formatLrcTime, linesToLrc, looksLikeLrc, lrcToLines, parseLrc } from './lrc'
import { buildLines, distributeWords, joinWords, lineIndexAt, syllableCount } from './lyrics-timing'
import { coreTitle, firstArtist, parseFileName, parseVideoTitle, searchText, similarity, titleHead, versionMarks } from './titles'
import { looksLikeUltraStar, parseUltraStar } from './ultrastar'

describe('LRC', () => {
  it('lê tempos, metadados e ordena as linhas', () => {
    const { entries, meta } = parseLrc('[ar:Queen]\n[ti:Teste]\n[00:12.50]segunda\n[00:05.00] primeira\n[00:20]terceira')
    expect(meta).toEqual({ ar: 'Queen', ti: 'Teste' })
    expect(entries.map((e) => [e.time, e.text])).toEqual([
      [5, 'primeira'],
      [12.5, 'segunda'],
      [20, 'terceira'],
    ])
  })

  it('aceita milissegundos, vários tempos por linha e offset', () => {
    const { entries } = parseLrc('[offset:500]\n[00:10.250][01:00.000]refrão')
    expect(entries.map((e) => e.time)).toEqual([9.75, 59.5])
    expect(entries.every((e) => e.text === 'refrão')).toBe(true)
  })

  it('usa a linha vazia como fim da linha anterior', () => {
    const { lines } = lrcToLines('[00:10.00]cantando agora\n[00:13.00]\n[00:40.00]depois da pausa')
    expect(lines).toHaveLength(2)
    expect(lines[0].end).toBe(13)
    expect(lines[1].start).toBe(40)
  })

  it('não estica uma linha curta até a próxima quando há um solo no meio', () => {
    const { lines } = lrcToLines('[00:10.00]oi\n[01:10.00]voltei')
    expect(lines[0].end).toBeLessThan(13)
  })

  it('lê marcações por palavra (enhanced LRC)', () => {
    const { lines, hasWordTimes } = lrcToLines('[00:10.00]<00:10.00>Quando <00:10.60>eu <00:10.90>di<00:11.20>go\n[00:14.00]fim')
    expect(hasWordTimes).toBe(true)
    expect(lines[0].text).toBe('Quando eu digo')
    expect(lines[0].words.map((w) => [w.text, w.start, w.glue ?? false])).toEqual([
      ['Quando', 10, false],
      ['eu', 10.6, false],
      ['di', 10.9, false],
      ['go', 11.2, true],
    ])
    expect(lines[0].words[0].end).toBe(10.6)
  })

  it('reconhece LRC e escreve de volta', () => {
    expect(looksLikeLrc('[00:01.00]a')).toBe(true)
    expect(looksLikeLrc('só uma letra\ncorrida')).toBe(false)
    expect(formatLrcTime(75.5)).toBe('01:15.50')
    const { lines } = lrcToLines('[00:01.00]a\n[01:15.50]b')
    expect(linesToLrc(lines)).toBe('[00:01.00]a\n[01:15.50]b')
  })
})

describe('temporização por palavra', () => {
  it('conta sílabas de forma aproximada', () => {
    expect(syllableCount('evidências')).toBe(4)
    expect(syllableCount('amor')).toBe(2)
    expect(syllableCount('hmm')).toBe(1)
  })

  it('distribui as palavras em ordem, dentro da linha, com as longas durando mais', () => {
    const words = distributeWords('eu amo evidências', 10, 14)
    expect(words.map((w) => w.text)).toEqual(['eu', 'amo', 'evidências'])
    expect(words[0].start).toBe(10)
    expect(words[2].end).toBeLessThanOrEqual(14)
    for (let i = 1; i < words.length; i++) expect(words[i].start).toBeGreaterThanOrEqual(words[i - 1].end - 1e-9)
    expect(words[2].end - words[2].start).toBeGreaterThan(words[0].end - words[0].start)
  })

  it('acha a linha ativa por busca binária', () => {
    const lines = buildLines([
      { time: 5, text: 'a' },
      { time: 10, text: 'b' },
      { time: 15, text: 'c' },
    ])
    expect(lineIndexAt(lines, 0)).toBe(-1)
    expect(lineIndexAt(lines, 5)).toBe(0)
    expect(lineIndexAt(lines, 12)).toBe(1)
    expect(lineIndexAt(lines, 99)).toBe(2)
  })

  it('junta sílabas coladas sem espaço', () => {
    expect(joinWords([{ text: 'Hel', start: 0, end: 1 }, { text: 'lo', start: 1, end: 2, glue: true }, { text: 'you', start: 2, end: 3 }])).toBe('Hello you')
  })
})

describe('UltraStar', () => {
  const file = [
    '#TITLE:Teste',
    '#ARTIST:Alguém',
    '#BPM:300',
    '#GAP:2000',
    ': 0 4 0 Can',
    ': 4 4 2 tan',
    ': 8 4 4 do ',
    ': 12 6 5 alto',
    '- 20',
    '* 24 4 7 De',
    ': 28 4 7  no',
    ': 32 4 5 ~',
    'F 36 4 0  vo',
    'E',
    ': 99 4 0 ignorada',
  ].join('\n')

  it('converte batidas em segundos e notas em MIDI', () => {
    const song = parseUltraStar(file)
    // 300 BPM de quartos = 0,05 s por batida, com 2 s de GAP.
    expect(song.title).toBe('Teste')
    expect(song.notes[0]).toEqual({ start: 2, end: 2.2, midi: 60, conf: 1 })
    expect(song.notes[3].midi).toBe(65)
    expect(song.notes[3].end).toBeCloseTo(2.9, 6)
  })

  it('monta palavras a partir das sílabas e quebra as linhas', () => {
    const song = parseUltraStar(file)
    expect(song.lines.map((l) => l.text)).toEqual(['Cantando alto', 'De no vo'])
    expect(song.lines[0].words.map((w) => w.glue ?? false)).toEqual([false, true, true, false])
    expect(song.lines[0].start).toBe(2)
  })

  it('prolonga a sílaba com "~" e não pontua freestyle', () => {
    const song = parseUltraStar(file)
    const no = song.lines[1].words[1]
    expect(no.text).toBe('no')
    expect(no.end).toBeCloseTo(2 + 36 * 0.05, 6)
    // 4 notas da linha 1, mais 3 da linha 2 (a F fica de fora).
    expect(song.notes).toHaveLength(7)
  })

  it('reconhece o formato', () => {
    expect(looksLikeUltraStar(file)).toBe(true)
    expect(looksLikeUltraStar('[00:01.00]isso é LRC')).toBe(false)
  })
})

describe('títulos', () => {
  it('separa artista e música e tira o ruído', () => {
    expect(parseVideoTitle('Chitãozinho & Xororó - Evidências (Clipe Oficial) [4K]', 'Chitãozinho & Xororó')).toEqual({
      artist: 'Chitãozinho & Xororó',
      title: 'Evidências',
    })
    expect(parseVideoTitle('Queen – Bohemian Rhapsody (Official Video Remastered)', 'Queen Official')).toEqual({
      artist: 'Queen',
      title: 'Bohemian Rhapsody',
    })
  })

  it('tira etiquetas entre colchetes e ruído escrito com pontos', () => {
    expect(parseVideoTitle('Jonathan Coulton - Code Monkey [H.Q.]', 'I C')).toEqual({ artist: 'Jonathan Coulton', title: 'Code Monkey' })
    expect(parseVideoTitle('Legião Urbana - Tempo Perdido (H.D.) {Remaster}', '')).toEqual({ artist: 'Legião Urbana', title: 'Tempo Perdido' })
  })

  it('mantém parênteses que fazem parte do nome', () => {
    expect(parseVideoTitle('Otis Redding - (Sittin\' On) The Dock of the Bay', '').title).toBe("(Sittin' On) The Dock of the Bay")
  })

  it('usa o canal quando o título não traz o artista', () => {
    expect(parseVideoTitle('Evidências (Remastered 2020)', 'Chitãozinho & Xororó - Topic')).toEqual({
      artist: 'Chitãozinho & Xororó',
      title: 'Evidências',
    })
  })

  it('inverte quando o canal mostra que o artista veio depois', () => {
    expect(parseVideoTitle('Evidências - Chitãozinho & Xororó', 'Chitãozinho & Xororó')).toEqual({
      artist: 'Chitãozinho & Xororó',
      title: 'Evidências',
    })
  })

  it('lê nomes de arquivo', () => {
    expect(parseFileName('03 - Legião Urbana - Tempo Perdido.mp3')).toEqual({ artist: 'Legião Urbana', title: 'Tempo Perdido' })
    expect(parseFileName('minha_musica.m4a')).toEqual({ artist: '', title: 'minha musica' })
  })

  it('compara ignorando acento e caixa', () => {
    expect(similarity('Evidências', 'EVIDENCIAS')).toBe(1)
    expect(similarity('Tempo Perdido', 'Faroeste Caboclo')).toBe(0)
  })

  it('fica só com o nome da música, sem o que vem pendurado nele', () => {
    expect(coreTitle('Evidências - Ao Vivo')).toBe('Evidências')
    expect(coreTitle('Bebi Liguei (Todos Os Cantos - Ao Vivo)')).toBe('Bebi Liguei')
    expect(coreTitle('Evidências (Ao Vivo) DVD 50 Anos')).toBe('Evidências')
    expect(coreTitle('Hotel California - Live On MTV, 1994')).toBe('Hotel California')
    expect(coreTitle('Tempo Perdido - Remastered 2010 (Deluxe)')).toBe('Tempo Perdido')
    expect(coreTitle('Borboletas (Villa Country)')).toBe('Borboletas')
    expect(coreTitle('Infiel feat. Fulano de Tal')).toBe('Infiel')
    // O que faz parte do nome fica.
    expect(coreTitle("(Sittin' On) The Dock of the Bay")).toBe("(Sittin' On) The Dock of the Bay")
    expect(coreTitle('Evidências | Show Completo 50 Anos')).toBe('Evidências | Show Completo 50 Anos')
    expect(titleHead('Evidências | Show Completo 50 Anos')).toBe('Evidências')
    expect(titleHead("(Sittin' On) The Dock of the Bay")).toBe("(Sittin' On) The Dock of the Bay")
  })

  it('separa o primeiro artista sem partir uma dupla', () => {
    expect(firstArtist('Marília Mendonça, Maiara & Maraisa')).toBe('Marília Mendonça')
    expect(firstArtist('Chitãozinho & Xororó')).toBe('Chitãozinho & Xororó')
    expect(firstArtist('Anitta feat. Becky G')).toBe('Anitta')
    expect(firstArtist('AC/DC')).toBe('AC/DC')
  })

  it('tira da busca as palavras que só existem em título de vídeo', () => {
    expect(searchText('Chitãozinho & Xororó - Evidências (Clipe Oficial) [4K]')).toBe('chitaozinho e xororo evidencias')
    expect(searchText('evidencias ao vivo letra')).toBe('evidencias ao vivo')
    expect(searchText('Letra')).toBe('letra')
  })

  it('reconhece as marcas de outra gravação', () => {
    expect(versionMarks('Evidências (Ao Vivo)')).toEqual(['ao vivo'])
    expect(versionMarks('Tempo Perdido - Acústico MTV')).toEqual(['acústico'])
    expect(versionMarks('Evidências')).toEqual([])
  })
})
