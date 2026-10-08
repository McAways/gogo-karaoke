import type { RefNote } from '../types'
import type { AnalyzeMessage, AnalyzeRequest } from './melody.worker'

/** Taxa em que o áudio é analisado. Metade do CD basta para a voz e corta o custo pela metade. */
const ANALYSIS_RATE = 22_050
/** Acima disso o áudio decodificado não cabe com folga na memória de uma aba. */
const MAX_SECONDS = 20 * 60

export interface AudioAnalysis {
  notes: RefNote[]
  peaks: Float32Array
  stereoWidth: number
  duration: number
}

export class AnalysisError extends Error {}

/**
 * Decodifica o arquivo (áudio ou a trilha de um vídeo) e extrai o guia de melodia
 * num Web Worker, para a interface não travar.
 */
export async function analyzeMedia(file: Blob, onProgress?: (ratio: number) => void): Promise<AudioAnalysis> {
  const bytes = await file.arrayBuffer()

  // decodeAudioData já entrega o áudio na taxa do contexto, então não é preciso reamostrar depois.
  const context = new OfflineAudioContext({ numberOfChannels: 2, length: 1, sampleRate: ANALYSIS_RATE })
  let audio: AudioBuffer
  try {
    audio = await context.decodeAudioData(bytes)
  } catch {
    throw new AnalysisError('O navegador não conseguiu ler o áudio desse arquivo.')
  }
  if (audio.duration > MAX_SECONDS) throw new AnalysisError('Arquivo longo demais para analisar (mais de 20 minutos).')

  const left = audio.getChannelData(0).slice()
  const right = audio.numberOfChannels > 1 ? audio.getChannelData(1).slice() : null
  const duration = audio.duration

  const worker = new Worker(new URL('./melody.worker.ts', import.meta.url), { type: 'module' })
  try {
    return await new Promise<AudioAnalysis>((resolve, reject) => {
      worker.onmessage = (event: MessageEvent<AnalyzeMessage>) => {
        const message = event.data
        if (message.type === 'progress') onProgress?.(message.ratio)
        else if (message.type === 'done') resolve({ notes: message.notes, peaks: message.peaks, stereoWidth: message.stereoWidth, duration })
        else reject(new AnalysisError(message.message))
      }
      worker.onerror = () => reject(new AnalysisError('A análise do áudio falhou.'))

      const request: AnalyzeRequest = { left, right, sampleRate: audio.sampleRate }
      worker.postMessage(request, right ? [left.buffer, right.buffer] : [left.buffer])
    })
  } finally {
    worker.terminate()
  }
}

/** Duração (s) lida dos metadados, sem decodificar o arquivo. */
export function probeDuration(file: Blob, kind: 'audio' | 'video'): Promise<number> {
  return new Promise((resolve) => {
    const element = document.createElement(kind)
    const url = URL.createObjectURL(file)
    const finish = (value: number) => {
      URL.revokeObjectURL(url)
      element.removeAttribute('src')
      resolve(Number.isFinite(value) && value > 0 ? value : 0)
    }
    element.preload = 'metadata'
    element.onloadedmetadata = () => finish(element.duration)
    element.onerror = () => finish(0)
    element.src = url
  })
}

/** Tira um quadro do vídeo para servir de capa. */
export function captureVideoFrame(file: Blob): Promise<Blob | null> {
  return new Promise((resolve) => {
    const video = document.createElement('video')
    const url = URL.createObjectURL(file)
    const finish = (blob: Blob | null) => {
      URL.revokeObjectURL(url)
      video.removeAttribute('src')
      resolve(blob)
    }
    const timer = setTimeout(() => finish(null), 8000)

    video.muted = true
    video.preload = 'auto'
    video.onloadedmetadata = () => {
      video.currentTime = Math.min(video.duration * 0.25, 30)
    }
    video.onseeked = () => {
      clearTimeout(timer)
      const scale = Math.min(1, 960 / video.videoWidth)
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(video.videoWidth * scale)
      canvas.height = Math.round(video.videoHeight * scale)
      const context = canvas.getContext('2d')
      if (!context || canvas.width === 0) return finish(null)
      context.drawImage(video, 0, 0, canvas.width, canvas.height)
      canvas.toBlob((blob) => finish(blob), 'image/jpeg', 0.82)
    }
    video.onerror = () => {
      clearTimeout(timer)
      finish(null)
    }
    video.src = url
  })
}
