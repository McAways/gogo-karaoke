const CROSSOVER_HZ = 140

export interface StemElements {
  instrumental: HTMLMediaElement
  vocals: HTMLMediaElement
}

/**
 * Caminho do áudio da música até a saída, com volume geral e volume da voz original.
 *
 * Tem dois modos:
 *
 * - **Faixas separadas** (a música passou pelo separador): instrumental e voz são dois
 *   arquivos, e o volume da voz é só um ganho. É o modo que funciona de verdade.
 * - **Arquivo único**: usa o truque clássico de karaoke. A voz principal costuma estar
 *   igual nos dois canais, então L - R a cancela. Bumbo e baixo também ficam no centro,
 *   por isso o grave (abaixo de 140 Hz) é preservado à parte. Só funciona em estéreo e
 *   o resultado varia muito de gravação para gravação.
 */
export class PlaybackGraph {
  /** true quando o volume da voz atua sobre uma faixa de voz de verdade. */
  readonly exact: boolean
  private readonly context: AudioContext
  private readonly sources: MediaElementAudioSourceNode[] = []
  private readonly master: GainNode
  private readonly vocals: GainNode | null = null
  private readonly dry: GainNode | null = null
  private readonly karaoke: GainNode | null = null

  constructor(context: AudioContext, media: HTMLMediaElement, stems: StemElements | null) {
    this.context = context
    this.exact = stems !== null
    this.master = context.createGain()

    if (stems) {
      const instrumental = context.createMediaElementSource(stems.instrumental)
      const voice = context.createMediaElementSource(stems.vocals)
      this.vocals = context.createGain()
      instrumental.connect(this.master)
      voice.connect(this.vocals).connect(this.master)
      this.sources.push(instrumental, voice)
      // O arquivo original só entra pela imagem (quando é vídeo): o som vem das duas faixas.
      media.muted = true
    } else {
      const source = context.createMediaElementSource(media)
      this.sources.push(source)
      this.dry = context.createGain()
      this.karaoke = context.createGain()
      this.karaoke.gain.value = 0
      source.connect(this.dry).connect(this.master)

      // L - R em mono.
      const splitter = context.createChannelSplitter(2)
      const invert = context.createGain()
      invert.gain.value = -1
      const side = context.createGain()
      side.channelCount = 1
      side.channelCountMode = 'explicit'
      side.gain.value = 0.8
      source.connect(splitter)
      splitter.connect(side, 0)
      splitter.connect(invert, 1)
      invert.connect(side)

      const sideHighpass = context.createBiquadFilter()
      sideHighpass.type = 'highpass'
      sideHighpass.frequency.value = CROSSOVER_HZ
      side.connect(sideHighpass).connect(this.karaoke)

      const bass = context.createBiquadFilter()
      bass.type = 'lowpass'
      bass.frequency.value = CROSSOVER_HZ
      source.connect(bass).connect(this.karaoke)

      this.karaoke.connect(this.master)
    }

    this.master.connect(context.destination)
  }

  setVolume(volume: number): void {
    this.master.gain.setTargetAtTime(Math.min(1, Math.max(0, volume)), this.context.currentTime, 0.02)
  }

  /** 1 = voz original inteira, 0 = sem a voz original. */
  setVocalLevel(level: number): void {
    const k = Math.min(1, Math.max(0, level))
    const now = this.context.currentTime
    if (this.vocals) {
      this.vocals.gain.setTargetAtTime(k, now, 0.03)
    } else if (this.dry && this.karaoke) {
      this.dry.gain.setTargetAtTime(k, now, 0.03)
      this.karaoke.gain.setTargetAtTime(1 - k, now, 0.03)
    }
  }

  dispose(): void {
    for (const source of this.sources) source.disconnect()
    this.master.disconnect()
  }
}

/**
 * Relógio da música. `currentTime` do elemento de mídia anda em degraus em alguns
 * navegadores; entre uma atualização e outra o tempo é estimado pelo relógio do sistema,
 * para a letra e a pista de tom correrem lisas.
 */
export class MediaClock {
  private readonly media: HTMLMediaElement
  private reported = 0
  private reportedAt = 0
  private last = 0

  constructor(media: HTMLMediaElement) {
    this.media = media
  }

  now(): number {
    const { media } = this
    const current = media.currentTime
    if (media.paused || media.seeking || media.ended) {
      this.reported = current
      this.reportedAt = performance.now()
      this.last = current
      return current
    }

    if (current !== this.reported) {
      this.reported = current
      this.reportedAt = performance.now()
    }
    const estimated = this.reported + Math.min(0.25, ((performance.now() - this.reportedAt) / 1000) * media.playbackRate)

    // Não deixa o tempo voltar por causa de uma correção pequena; saltos reais passam.
    const time = estimated < this.last && this.last - estimated < 0.08 ? this.last : estimated
    this.last = time
    return time
  }
}
