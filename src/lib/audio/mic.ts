import { PitchDetector } from 'pitchy'
import { PitchGate } from './pitch-gate'
import type { PitchReading } from './pitch-gate'

export type ListenMode = 'fones' | 'caixas'

/** `midi` é a nota que vale ponto; `shown`, a que se desenha (ver `PitchReading`). */
export interface MicSample extends PitchReading {
  /** Volume de entrada, 0..1, para o medidor. */
  level: number
}

export class MicError extends Error {
  reason: 'negado' | 'ausente' | 'outro'
  constructor(reason: MicError['reason'], message: string) {
    super(message)
    this.reason = reason
  }
}

const FFT_SIZE = 2048

function toDb(rms: number): number {
  return 20 * Math.log10(Math.max(rms, 1e-7))
}

/** Entrada de microfone com detecção de tom (método de McLeod, via pitchy). */
export class MicInput {
  private readonly context: AudioContext
  private stream: MediaStream | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private analyser: AnalyserNode | null = null
  private readonly buffer = new Float32Array(FFT_SIZE)
  private readonly detector = PitchDetector.forFloat32Array(FFT_SIZE)
  private readonly gate = new PitchGate()
  deviceLabel = ''

  constructor(context: AudioContext) {
    this.context = context
  }

  get active(): boolean {
    return this.analyser !== null
  }

  /**
   * `caixas` liga o cancelamento de eco do navegador, que tira do microfone a música
   * que sai dos alto-falantes. Com fones ele fica desligado: o cancelamento distorce
   * notas longas e atrapalha a leitura do tom.
   */
  async start(deviceId: string | null, mode: ListenMode): Promise<void> {
    this.stop()
    if (!navigator.mediaDevices?.getUserMedia) throw new MicError('ausente', 'Este navegador não dá acesso ao microfone.')

    const base: MediaTrackConstraints = {
      echoCancellation: mode === 'caixas',
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1,
    }

    try {
      this.stream = await this.open(deviceId ? { ...base, deviceId: { exact: deviceId } } : base).catch((err: unknown) => {
        // O microfone salvo pode ter sido desconectado: cai no padrão do sistema.
        if (deviceId && err instanceof DOMException && (err.name === 'OverconstrainedError' || err.name === 'NotFoundError')) return this.open(base)
        throw err
      })
    } catch (err) {
      const name = err instanceof DOMException ? err.name : ''
      if (name === 'NotAllowedError' || name === 'SecurityError') throw new MicError('negado', 'O navegador bloqueou o microfone para este site.')
      if (name === 'NotFoundError' || name === 'OverconstrainedError') throw new MicError('ausente', 'Nenhum microfone foi encontrado.')
      throw new MicError('outro', 'Não foi possível abrir o microfone.')
    }

    this.deviceLabel = this.stream.getAudioTracks()[0]?.label ?? ''
    this.source = this.context.createMediaStreamSource(this.stream)
    const highpass = this.context.createBiquadFilter()
    highpass.type = 'highpass'
    highpass.frequency.value = 60

    this.analyser = this.context.createAnalyser()
    this.analyser.fftSize = FFT_SIZE
    this.analyser.smoothingTimeConstant = 0
    // Não é ligado à saída: o cantor não se ouve pelo app, o que evita microfonia.
    this.source.connect(highpass).connect(this.analyser)

    this.gate.reset()
  }

  private open(audio: MediaTrackConstraints): Promise<MediaStream> {
    return navigator.mediaDevices.getUserMedia({ audio })
  }

  read(): MicSample {
    if (!this.analyser) return { midi: null, shown: null, level: 0 }
    this.analyser.getFloatTimeDomainData(this.buffer)

    let sum = 0
    for (let i = 0; i < FFT_SIZE; i++) sum += this.buffer[i] * this.buffer[i]
    const db = toDb(Math.sqrt(sum / FFT_SIZE))
    const level = Math.min(1, Math.max(0, (db + 60) / 54))

    const [hz, clarity] = this.detector.findPitch(this.buffer, this.context.sampleRate)
    return { ...this.gate.push({ time: performance.now() / 1000, hz, clarity, db }), level }
  }

  stop(): void {
    this.stream?.getTracks().forEach((track) => track.stop())
    this.source?.disconnect()
    this.stream = null
    this.source = null
    this.analyser = null
  }
}

/** Os nomes dos microfones só aparecem depois que o usuário autoriza o acesso. */
export async function listMicrophones(): Promise<MediaDeviceInfo[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return []
  const devices = await navigator.mediaDevices.enumerateDevices()
  return devices.filter((d) => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications')
}

export async function microphonePermission(): Promise<PermissionState | 'unknown'> {
  try {
    const status = await navigator.permissions.query({ name: 'microphone' as PermissionName })
    return status.state
  } catch {
    return 'unknown'
  }
}
