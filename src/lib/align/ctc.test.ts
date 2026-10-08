import { describe, expect, it } from 'vitest'
import { alignLines, forcedAlign, planTokens, romanize } from './ctc'
import type { LineInput, Vocab } from './ctc'

// Vocabulário de brinquedo: branco, as 26 letras e o apóstrofo.
const vocab: Vocab = { '<blank>': 0 }
for (const char of "abcdefghijklmnopqrstuvwxyz'") vocab[char] = Object.keys(vocab).length
const classes = Object.keys(vocab).length
const FRAME = 0.02

/**
 * Finge o que o modelo acústico ouviria: silêncio em tudo, menos nos quadros em que uma
 * letra é "cantada", onde ela aparece com 90% de certeza.
 */
class Voice {
  readonly frames: number
  readonly logProbs: Float32Array

  constructor(seconds: number) {
    this.frames = Math.round(seconds / FRAME)
    this.logProbs = new Float32Array(this.frames * classes).fill(Math.log(0.01 / (classes - 1)))
    for (let f = 0; f < this.frames; f++) this.logProbs[f * classes] = Math.log(0.99)
  }

  /** Canta `text` a partir de `at` segundos, uma letra a cada `step` segundos. Espaços viram pausa. */
  sing(text: string, at: number, step = 0.06): this {
    let frame = Math.round(at / FRAME)
    for (const char of text) {
      const id = vocab[char]
      if (id !== undefined) {
        const row = frame * classes
        this.logProbs.fill(Math.log(0.05 / (classes - 2)), row, row + classes)
        this.logProbs[row] = Math.log(0.05)
        this.logProbs[row + id] = Math.log(0.9)
      }
      frame += Math.round(step / FRAME)
    }
    return this
  }

  align(lines: LineInput[], voiced?: Uint8Array) {
    return alignLines(this.logProbs, this.frames, classes, vocab, 0, lines, { frameSeconds: FRAME, voiced })
  }
}

const line = (text: string, reference?: number): LineInput => ({ words: text.split(' '), reference: reference ?? null })

describe('texto que o modelo entende', () => {
  it('tira acentos, caixa e pontuação', () => {
    expect(romanize('Coração,')).toBe('coracao')
    expect(romanize('“Você”')).toBe('voce')
    expect(romanize("don't")).toBe("don't")
    expect(romanize('’cause')).toBe('cause')
    expect(romanize('Straße')).toBe('strasse')
    expect(romanize('2000')).toBe('')
  })

  it('guarda a que palavra e a que linha pertence cada letra', () => {
    const plan = planTokens([['ab', '12'], ['c']], vocab)
    expect([...plan.ids]).toEqual([vocab.a, vocab.b, vocab.c])
    expect([...plan.wordOf]).toEqual([0, 0, 2])
    expect([...plan.lineOf]).toEqual([0, 0, 1])
    expect(plan.words).toBe(3)
  })
})

describe('encaixe das letras', () => {
  it('põe cada letra no quadro em que ela foi cantada', () => {
    const voice = new Voice(4).sing('sol', 1)
    const spans = forcedAlign(voice.logProbs, voice.frames, classes, planTokens([['sol']], vocab), 0)!
    expect(spans.map((s) => s.start)).toEqual([50, 53, 56])
    expect(spans.every((s) => s.score > 0.85)).toBe(true)
  })

  it('exige um intervalo entre duas letras iguais seguidas', () => {
    const voice = new Voice(2).sing('oo', 0.5)
    const spans = forcedAlign(voice.logProbs, voice.frames, classes, planTokens([['oo']], vocab), 0)!
    expect(spans[1].start).toBeGreaterThan(spans[0].end)
  })

  it('devolve null quando o texto não cabe no áudio', () => {
    const voice = new Voice(0.1)
    expect(forcedAlign(voice.logProbs, voice.frames, classes, planTokens([['palavragrande']], vocab), 0)).toBeNull()
  })

  it('mantém juntas as letras de uma linha, mesmo as que não foram ouvidas', () => {
    // A segunda linha é "mar azul", mas só "azul" foi cantado, aos 10 s. O "mar" não aparece em lugar nenhum.
    const voice = new Voice(14).sing('sol', 1).sing('azul', 10)
    const plan = planTokens([['sol'], ['mar', 'azul']], vocab)
    const loose = forcedAlign(voice.logProbs, voice.frames, classes, plan, 0)!
    const tight = forcedAlign(voice.logProbs, voice.frames, classes, plan, 0, { gapPenalty: 0.03 })!
    const firstOfMar = (spans: typeof tight) => spans[3].start * FRAME
    // Com o custo do silêncio dentro da linha, o "mar" encosta no "azul" em vez de boiar no trecho vazio.
    expect(firstOfMar(tight)).toBeGreaterThan(9.5)
    expect(firstOfMar(tight)).toBeGreaterThanOrEqual(firstOfMar(loose))
  })
})

describe('letra inteira', () => {
  it('dá o tempo de cada linha e de cada palavra', () => {
    const voice = new Voice(10).sing('bom dia', 1).sing('sol e mar', 5)
    const result = voice.align([line('Bom dia'), line('Sol e mar')])!
    expect(result.lines).toHaveLength(2)
    expect(result.lines[0].start).toBeCloseTo(1, 1)
    expect(result.lines[1].start).toBeCloseTo(5, 1)
    expect(result.lines[0].words).toHaveLength(2)
    // "dia" começa depois de "bom" e do espaço: 4 passos de 0,06 s.
    expect(result.lines[0].words![1].start).toBeCloseTo(1.24, 1)
    expect(result.heard).toBe(1)
    expect(result.tied).toBe(0)
  })

  it('prende à referência a linha que não foi ouvida', () => {
    // Cinco linhas; a terceira não aparece no som (e usa letras que as outras não têm, para não pegar carona). A referência está 0,5 s adiantada em tudo.
    const voice = new Voice(30).sing('bom dia flor', 2).sing('sol e mar azul', 8).sing('noite alta ceu', 20).sing('vento norte frio', 25)
    const lines = [line('bom dia flor', 1.5), line('sol e mar azul', 7.5), line('gypj kwx', 13.5), line('noite alta ceu', 19.5), line('vento norte frio', 24.5)]
    const result = voice.align(lines)!
    const lost = result.lines[2]
    expect(lost.tied).toBe(true)
    // Esperado: 13,5 s da referência mais os 0,5 s vistos nas vizinhas.
    expect(lost.start).toBeGreaterThan(13.4)
    expect(lost.start).toBeLessThan(14.6)
    // Sem ter sido ouvida, a linha não ganha tempo por palavra.
    expect(lost.words).toBeNull()
    expect(result.lines[3].start).toBeCloseTo(20, 1)
    expect(result.tied).toBe(1)
  })

  it('sem referência, a linha não ouvida fica onde couber e é marcada', () => {
    const voice = new Voice(30).sing('bom dia flor', 2).sing('sol e mar azul', 8).sing('noite alta ceu', 20)
    const result = voice.align([line('bom dia flor'), line('sol e mar azul'), line('gypj kwx'), line('noite alta ceu')])!
    expect(result.lines[2].words).toBeNull()
    expect(result.lines[2].tied).toBe(false)
    expect(result.lines[2].start).toBeGreaterThan(8)
    expect(result.lines[2].start).toBeLessThan(20.1)
    expect(result.heard).toBe(0.75)
  })

  it('acompanha uma pausa que a referência não conhece', () => {
    // O vídeo tem 6 s a mais de pausa depois da segunda linha: daí em diante tudo vem 6 s depois da referência.
    const voice = new Voice(40).sing('bom dia flor', 2).sing('sol e mar azul', 6).sing('noite alta ceu', 16).sing('vento norte frio', 20).sing('chuva fina cai', 24)
    const lines = [line('bom dia flor', 2), line('sol e mar azul', 6), line('noite alta ceu', 10), line('vento norte frio', 14), line('chuva fina cai', 18)]
    const result = voice.align(lines)!
    expect(result.lines.map((l) => Math.round(l.start))).toEqual([2, 6, 16, 20, 24])
    expect(result.tied).toBe(0)
  })

  it('estica a palavra enquanto a nota é segurada, sem passar da próxima', () => {
    const voice = new Voice(12).sing('sol', 1).sing('mar', 8)
    const voiced = new Uint8Array(voice.frames)
    // Voz de 1 s a 4 s (o "sol" segurado) e de 8 s a 9 s.
    voiced.fill(1, 50, 200)
    voiced.fill(1, 400, 450)
    const result = voice.align([line('sol'), line('mar')], voiced)!
    expect(result.lines[0].words![0].end).toBeCloseTo(4, 1)
    expect(result.lines[0].end).toBeLessThanOrEqual(result.lines[1].start)

    // Sem a informação de voz, a palavra termina onde a última letra foi ouvida.
    const plain = voice.align([line('sol'), line('mar')])!
    expect(plain.lines[0].words![0].end).toBeLessThan(1.5)
  })

  it('lida com palavra sem letra e com linha só de símbolos', () => {
    const voice = new Voice(12).sing('ano', 1).sing('novo', 2).sing('sol', 8)
    const result = voice.align([line('ano 2000 novo'), line('♪'), line('sol')])!
    const words = result.lines[0].words!
    expect(words).toHaveLength(3)
    // O "2000" não tem letra: ocupa o instante entre as vizinhas, em ordem.
    expect(words[1].start).toBeGreaterThanOrEqual(words[0].start)
    expect(words[1].end).toBeLessThanOrEqual(words[2].start)
    expect(result.lines[1].words).toBeNull()
    expect(result.lines[1].start).toBeGreaterThanOrEqual(result.lines[0].start)
    expect(result.lines[2].start).toBeCloseTo(8, 1)
  })

  it('devolve null quando a letra é maior do que o áudio', () => {
    expect(new Voice(0.2).align([line('uma letra bem maior do que o audio')])).toBeNull()
  })
})
