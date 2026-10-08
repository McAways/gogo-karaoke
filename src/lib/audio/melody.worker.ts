import { analyzeMelody } from './melody'

export interface AnalyzeRequest {
  left: Float32Array
  right: Float32Array | null
  sampleRate: number
}

export type AnalyzeMessage =
  | { type: 'progress'; ratio: number }
  | { type: 'done'; notes: ReturnType<typeof analyzeMelody>['notes']; peaks: Float32Array; stereoWidth: number }
  | { type: 'error'; message: string }

// O tsconfig do app usa a lib DOM, onde `self` é a janela; aqui ele é o escopo do worker.
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<AnalyzeRequest>) => void) | null
  postMessage(message: AnalyzeMessage, transfer?: Transferable[]): void
}

scope.onmessage = (event) => {
  try {
    const { left, right, sampleRate } = event.data
    const result = analyzeMelody(left, right, sampleRate, (ratio) => scope.postMessage({ type: 'progress', ratio }))
    scope.postMessage({ type: 'done', notes: result.notes, peaks: result.peaks, stereoWidth: result.stereoWidth }, [result.peaks.buffer])
  } catch (err) {
    scope.postMessage({ type: 'error', message: err instanceof Error ? err.message : 'Falha na análise.' })
  }
}
