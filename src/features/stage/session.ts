import type { MicInput, MicSample } from '@/lib/audio/mic'
import { MediaClock, PlaybackGraph } from '@/lib/audio/playback'
import type { StemElements } from '@/lib/audio/playback'
import { ScoreEngine, rulesFor } from '@/lib/scoring/engine'
import type { LineResult, ScoreSummary } from '@/lib/scoring/engine'
import { buildReference } from '@/lib/scoring/reference'
import type { ScoreReference } from '@/lib/scoring/reference'
import { RoomScores } from '@/lib/scoring/room'
import type { Difficulty, LyricLine, RefNote } from '@/lib/types'

export interface StageSetup {
  context: AudioContext
  /** O arquivo original da música (vídeo ou áudio). */
  media: HTMLMediaElement
  /**
   * Faixas separadas, quando a música tem. O instrumental passa a ser o relógio da
   * apresentação, a voz o acompanha, e o arquivo original toca mudo, só pela imagem.
   */
  stems: StemElements | null
  /** true quando o arquivo original é vídeo e deve aparecer no fundo. */
  hasPicture: boolean
  /** null = tocar sem pontuar. */
  mic: MicInput | null
  /** Letra com os tempos originais (sem o atraso aplicado). */
  lines: LyricLine[]
  notes: RefNote[]
  /** Notas do UltraStar vêm com a letra, então andam junto com o atraso dela. */
  notesFollowLyrics: boolean
  exactGuide: boolean
  difficulty: Difficulty
  /** Segundos entre o som sair e o microfone captar. */
  latency: number
  /** Atraso da letra, em segundos. */
  offset: number
  /** Como quem canta neste computador aparece no placar da sala. */
  hostName: string
}

/** Estado que muda poucas vezes por segundo: é o que o React observa. */
export interface StageSnapshot {
  playing: boolean
  ended: boolean
  points: number
  streak: number
  lastLine: LineResult | null
  offset: number
  /** Placar da sala, do primeiro ao último. Vazio quando não há convidados. */
  board: BoardEntry[]
}

export interface BoardEntry {
  name: string
  points: number
  streak: number
  /** true para quem canta no microfone deste computador. */
  host: boolean
}

/** Linha da letra como vai para o celular: [início, fim, texto, [[início, fim, palavra, colada], ...]]. */
export type GuestLine = [number, number, string, Array<[number, number, string, 0 | 1]>]

/** O que cada quadro entrega para quem desenha (letra, pista de tom, medidor). */
export interface Frame {
  time: number
  lyricTime: number
  playing: boolean
  mic: MicSample
}

/** Ponto do rastro da voz na pista de tom. */
export interface TrailPoint {
  time: number
  midi: number
  /** Nota que deveria estar sendo cantada. null fora de uma nota. */
  target: number | null
  diff: number | null
  credit: number
}

const SILENT: MicSample = { midi: null, level: 0 }
const TRAIL_LIMIT = 400
/** Quanto (s) a voz pode se afastar do instrumental antes de ser reposicionada. */
const VOCALS_TOLERANCE = 0.045
/** A imagem aguenta bem mais: um salto de quadro não se nota como um salto de som. */
const PICTURE_TOLERANCE = 0.15
/** Quadros com voz (meio segundo) para o host entrar no resultado de uma rodada da sala. */
const HOST_MIN_VOICED = 30

interface Follower {
  element: HTMLMediaElement
  tolerance: number
}

function shift(lines: LyricLine[], offset: number): LyricLine[] {
  if (offset === 0) return lines
  return lines.map((line) => ({
    ...line,
    start: line.start + offset,
    end: line.end + offset,
    words: line.words.map((word) => ({ ...word, start: word.start + offset, end: word.end + offset })),
  }))
}

/**
 * Uma apresentação. Vive fora do React: junta o relógio da música, o microfone e a
 * pontuação num único requestAnimationFrame, e só avisa o React do que muda devagar.
 */
export class StageSession {
  /** O elemento que marca o tempo: o instrumental quando há faixas separadas, senão o arquivo original. */
  readonly media: HTMLMediaElement
  readonly scoring: boolean
  readonly trail: TrailPoint[] = []
  reference: ScoreReference
  engine: ScoreEngine

  private readonly setup: StageSetup
  private readonly clock: MediaClock
  private readonly graph: PlaybackGraph
  private readonly frameListeners = new Set<(frame: Frame) => void>()
  private readonly listeners = new Set<() => void>()
  private snapshot: StageSnapshot
  private readonly followers: Follower[] = []
  private frames = 0
  private offset: number
  private raf = 0
  private lastPointsEmit = 0
  /** Pontuação dos convidados da sala. */
  private readonly room: RoomScores
  private lastBoardEmit = 0
  private boardKey = ''
  private hostVoiced = 0
  private disposed = false

  constructor(setup: StageSetup) {
    this.setup = setup
    this.media = setup.stems ? setup.stems.instrumental : setup.media
    if (setup.stems) {
      this.followers.push({ element: setup.stems.vocals, tolerance: VOCALS_TOLERANCE })
      if (setup.hasPicture) this.followers.push({ element: setup.media, tolerance: PICTURE_TOLERANCE })
    }
    this.scoring = setup.mic !== null
    this.offset = setup.offset
    this.clock = new MediaClock(this.media)
    this.graph = new PlaybackGraph(setup.context, setup.media, setup.stems)

    this.reference = this.buildReference()
    this.engine = new ScoreEngine(this.reference, rulesFor(setup.difficulty, setup.exactGuide))
    this.room = new RoomScores(this.reference, rulesFor(setup.difficulty, setup.exactGuide))
    this.snapshot = { playing: false, ended: false, points: 0, streak: 0, lastLine: null, offset: this.offset, board: [] }

    this.media.addEventListener('ended', this.onEnded)
    this.raf = requestAnimationFrame(this.loop)
  }

  private buildReference(): ScoreReference {
    const { lines, notes, notesFollowLyrics } = this.setup
    const shiftedNotes = notesFollowLyrics && this.offset !== 0 ? notes.map((n) => ({ ...n, start: n.start + this.offset, end: n.end + this.offset })) : notes
    return buildReference(shift(lines, this.offset), shiftedNotes)
  }

  private readonly onEnded = () => this.update({ ended: true, playing: false })

  private readonly loop = () => {
    if (this.disposed) return
    this.raf = requestAnimationFrame(this.loop)

    const { mic, latency } = this.setup
    const time = this.clock.now()
    const playing = !this.media.paused && !this.media.ended
    const sample = mic ? mic.read() : SILENT

    if (playing && mic) {
      // O que o microfone ouve agora foi cantado sobre o som de `latency` segundos atrás.
      const sungTime = time - latency
      const judgment = this.engine.push(sungTime, sample.midi)
      if (sample.midi !== null) {
        this.hostVoiced++
        this.trail.push({ time: sungTime, midi: sample.midi, target: judgment.target, diff: judgment.diff, credit: judgment.credit })
        if (this.trail.length > TRAIL_LIMIT) this.trail.splice(0, this.trail.length - TRAIL_LIMIT)
      }

      const closed = this.engine.closeLines(sungTime)
      const now = performance.now()
      if (closed.length > 0) {
        this.lastPointsEmit = now
        this.update({ points: this.engine.points, streak: this.engine.currentStreak, lastLine: closed[closed.length - 1] })
      } else if (this.engine.points !== this.snapshot.points && now - this.lastPointsEmit > 120) {
        this.lastPointsEmit = now
        this.update({ points: this.engine.points })
      }
    }

    if (this.room.size > 0) {
      if (playing) this.room.closeLines(time - latency)
      const now = performance.now()
      if (now - this.lastBoardEmit > 400) {
        this.lastBoardEmit = now
        this.emitBoard()
      }
    }

    if (playing !== this.snapshot.playing) this.update({ playing })
    if (++this.frames % 20 === 0) this.syncFollowers()

    const frame: Frame = { time, lyricTime: time - this.offset, playing, mic: sample }
    for (const listener of this.frameListeners) listener(frame)
  }

  /**
   * Voz e imagem são elementos de mídia separados e cada um tem seu próprio relógio.
   * A cada terço de segundo, quem se afastou do instrumental é reposicionado.
   */
  private syncFollowers(): void {
    const clock = this.media
    for (const { element, tolerance } of this.followers) {
      if (clock.paused || clock.ended) {
        if (!element.paused) element.pause()
        continue
      }
      if (element.paused && !element.ended) void element.play().catch(() => {})
      if (Math.abs(element.currentTime - clock.currentTime) > tolerance) element.currentTime = clock.currentTime
    }
  }

  private newEngine(): ScoreEngine {
    return new ScoreEngine(this.reference, rulesFor(this.setup.difficulty, this.setup.exactGuide))
  }

  private board(): BoardEntry[] {
    if (this.room.size === 0 || this.reference.mode === 'nenhum') return []
    const entries: BoardEntry[] = this.room.entries().map((entry) => ({ ...entry, host: false }))
    if (this.scoring) entries.push({ name: this.setup.hostName, points: this.engine.points, streak: this.engine.currentStreak, host: true })
    // A ordenação é estável: quem empata fica na ordem em que entrou.
    return entries.sort((a, b) => b.points - a.points)
  }

  /** Só avisa o React quando o placar mudou de fato. */
  private emitBoard(): void {
    const board = this.board()
    const key = board.map((entry) => `${entry.name}:${entry.points}`).join('|')
    if (key === this.boardKey) return
    this.boardKey = key
    this.update({ board })
  }

  /** Quem está na sala ganha um lugar no placar, mesmo antes de cantar a primeira nota. */
  setRoster(names: readonly string[]): void {
    if (this.disposed || this.reference.mode === 'nenhum' || names.length === 0) return
    this.room.enroll(names)
    this.emitBoard()
  }

  /**
   * Leituras de tom vindas do celular de um convidado. Cada uma traz o instante em que
   * foi captada (no relógio do host), então o atraso da rede não entra na conta.
   */
  pushRemote(name: string, samples: readonly unknown[]): void {
    if (this.disposed || this.reference.mode === 'nenhum' || this.media.paused || this.media.ended) return
    this.room.push(name, samples, this.clock.now(), Date.now(), this.setup.latency)
  }

  private update(changes: Partial<StageSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...changes }
    for (const listener of this.listeners) listener()
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  readonly getSnapshot = (): StageSnapshot => this.snapshot

  onFrame(listener: (frame: Frame) => void): () => void {
    this.frameListeners.add(listener)
    return () => this.frameListeners.delete(listener)
  }

  get duration(): number {
    return Number.isFinite(this.media.duration) ? this.media.duration : 0
  }

  get currentOffset(): number {
    return this.offset
  }

  /** Posição da música agora, em segundos. */
  get time(): number {
    return this.clock.now()
  }

  play(): void {
    this.room.mark(Date.now())
    void this.setup.context.resume()
    // Todos no mesmo instante: quanto mais juntos saírem, menos correção depois.
    void this.media.play().catch(() => {})
    for (const { element } of this.followers) void element.play().catch(() => {})
  }

  pause(): void {
    this.media.pause()
    for (const { element } of this.followers) element.pause()
  }

  toggle(): void {
    if (this.media.paused) this.play()
    else this.pause()
  }

  seek(time: number): void {
    const target = Math.min(Math.max(0, time), Math.max(0, this.duration - 0.05))
    this.media.currentTime = target
    for (const { element } of this.followers) element.currentTime = target
    this.trail.length = 0
    this.room.mark(Date.now())
  }

  restart(): void {
    this.media.currentTime = 0
    for (const { element } of this.followers) element.currentTime = 0
    this.trail.length = 0
    this.reference = this.buildReference()
    this.engine = this.newEngine()
    this.room.restart(this.reference)
    this.hostVoiced = 0
    this.boardKey = ''
    this.update({ points: 0, streak: 0, lastLine: null, ended: false, board: this.board() })
    this.play()
  }

  /** Muda o atraso da letra sem perder o que já foi cantado. */
  setOffset(offset: number): void {
    if (offset === this.offset) return
    this.offset = offset
    const previous = this.engine
    this.reference = this.buildReference()
    this.engine = this.newEngine()
    this.engine.adopt(previous)
    this.room.rebase(this.reference, this.clock.now() - this.setup.latency)
    this.trail.length = 0
    this.update({ offset, points: this.engine.points, streak: this.engine.currentStreak })
  }

  setVolume(volume: number): void {
    this.graph.setVolume(volume)
  }

  /** 1 = voz original inteira, 0 = sem a voz original. */
  setVocalLevel(level: number): void {
    this.graph.setVocalLevel(level)
  }

  /** true quando a música tem faixas separadas e o volume da voz é exato, não o truque aproximado. */
  get hasStems(): boolean {
    return this.graph.exact
  }

  /**
   * Resultado de quem cantou. `name` null é quem cantou no microfone deste computador.
   * Vazio quando não havia o que pontuar (ninguém com microfone, ou música sem letra e sem guia).
   */
  finish(): Array<{ name: string | null; summary: ScoreSummary }> {
    if (this.reference.mode === 'nenhum') return []
    const results: Array<{ name: string | null; summary: ScoreSummary }> = this.room.results()
    // Sozinho, o host sempre leva a nota. Numa rodada da sala, só se cantou: microfone
    // ligado e calado não deve aparecer no placar com zero.
    if (this.scoring && (results.length === 0 || this.hostVoiced >= HOST_MIN_VOICED)) results.push({ name: null, summary: this.engine.summary() })
    return results
  }

  /**
   * O que os celulares dos convidados precisam para mostrar a música: a letra com o tempo de
   * cada palavra (já com o atraso aplicado) e as notas da pista de tom.
   */
  get guestView(): { lines: GuestLine[]; notes: Array<[number, number, number]>; latency: number; tolerance: number } {
    const at = (seconds: number) => Math.round((seconds + this.offset) * 100) / 100
    return {
      lines: this.setup.lines.map((line) => [at(line.start), at(line.end), line.text, line.words.map((word) => [at(word.start), at(word.end), word.text, word.glue ? 1 : 0])]),
      notes: this.reference.laneNotes.map((note) => [Math.round(note.start * 100) / 100, Math.round(note.end * 100) / 100, Math.round(note.midi * 10) / 10]),
      latency: this.setup.latency,
      tolerance: rulesFor(this.setup.difficulty, this.setup.exactGuide).tolerance,
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    cancelAnimationFrame(this.raf)
    this.media.removeEventListener('ended', this.onEnded)
    this.media.pause()
    for (const { element } of this.followers) element.pause()
    this.graph.dispose()
    this.frameListeners.clear()
    this.listeners.clear()
  }
}
