import { useEffect, useRef } from 'react'
import { cn } from '@/components/cn'
import type { StageSession } from './session'

/** Segundos de passado e de futuro visíveis na pista. */
const PAST = 1.6
const FUTURE = 3.6
const MIN_SPAN = 11
const RANGE_PADDING = 2.5

/** Primeiro índice cujo fim passa de `time`, em uma lista ordenada por tempo. */
function firstEndingAfter(items: ReadonlyArray<{ end: number }>, time: number): number {
  let lo = 0
  let hi = items.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (items[mid].end <= time) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * Pista de tom: as notas do guia correm da direita para a esquerda e o rastro da
 * voz mostra onde o cantor está em relação a elas. Como a pontuação ignora a oitava,
 * a voz é desenhada na oitava mais próxima da nota alvo.
 */
export function PitchLane({ session, className }: { session: StageSession; className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const context = canvas?.getContext('2d')
    if (!canvas || !context) return

    const styles = getComputedStyle(canvas)
    const accent = styles.getPropertyValue('--accent').trim() || '#c9f24a'
    const ink = styles.getPropertyValue('--ink').trim() || '#f4f4ee'

    let width = 0
    let height = 0
    const resize = () => {
      const ratio = Math.min(2, window.devicePixelRatio || 1)
      width = canvas.clientWidth
      height = canvas.clientHeight
      canvas.width = Math.round(width * ratio)
      canvas.height = Math.round(height * ratio)
      context.setTransform(ratio, 0, 0, ratio, 0, 0)
    }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(canvas)

    // Faixa de notas visível, suavizada para a pista não pular a cada frase.
    let viewLow = 55
    let viewHigh = 67
    let settled = false

    const stop = session.onFrame(({ time, mic }) => {
      if (width === 0 || height === 0) return
      context.clearRect(0, 0, width, height)

      const { laneNotes, slots } = session.reference
      const from = time - PAST
      const to = time + FUTURE
      const pxPerSecond = width / (PAST + FUTURE)
      const x = (t: number) => (t - from) * pxPerSecond
      const nowX = x(time)

      // 1. Faixa de alturas: acompanha as notas que estão na tela.
      let low = Infinity
      let high = -Infinity
      const firstNote = firstEndingAfter(laneNotes, from)
      for (let i = firstNote; i < laneNotes.length && laneNotes[i].start < to; i++) {
        low = Math.min(low, laneNotes[i].midi)
        high = Math.max(high, laneNotes[i].midi)
      }
      if (low !== Infinity) {
        const center = (low + high) / 2
        const span = Math.max(MIN_SPAN, high - low + RANGE_PADDING * 2)
        const targetLow = center - span / 2
        const targetHigh = center + span / 2
        const ease = settled ? 0.06 : 1
        viewLow += (targetLow - viewLow) * ease
        viewHigh += (targetHigh - viewHigh) * ease
        settled = true
      }
      const thickness = Math.max(7, Math.min(14, height * 0.07))
      const usable = height - thickness * 2
      const y = (midi: number) => {
        const raw = thickness + (1 - (midi - viewLow) / (viewHigh - viewLow)) * usable
        // Quem canta muito longe da nota encosta na borda, em vez de sumir da pista.
        return Math.min(height - thickness * 0.7, Math.max(thickness * 0.7, raw))
      }

      // 2. Notas do guia, em cinza. As que o guia tem menos certeza ficam mais apagadas.
      context.lineCap = 'round'
      context.lineWidth = thickness
      context.strokeStyle = ink
      for (let i = firstNote; i < laneNotes.length && laneNotes[i].start < to; i++) {
        const note = laneNotes[i]
        const x0 = x(note.start) + thickness / 2
        const x1 = Math.max(x0 + 0.5, x(note.end) - thickness / 2)
        context.globalAlpha = 0.12 + 0.16 * note.conf
        context.beginPath()
        context.moveTo(x0, y(note.midi))
        context.lineTo(x1, y(note.midi))
        context.stroke()
      }

      // 3. Por cima, em lima, o que já foi acertado.
      context.lineCap = 'butt'
      context.strokeStyle = accent
      let lo = 0
      let hi = slots.length
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (slots[mid].t1 <= from) lo = mid + 1
        else hi = mid
      }
      for (let i = lo; i < slots.length && slots[i].t0 < time; i++) {
        const slot = slots[i]
        const value = session.engine.slotValue(i)
        if (slot.midi === null || value <= 0) continue
        context.globalAlpha = 0.3 + 0.7 * value
        context.beginPath()
        context.moveTo(x(slot.t0), y(slot.midi))
        context.lineTo(x(slot.t1) + 0.5, y(slot.midi))
        context.stroke()
      }

      // 4. Linha do "agora".
      context.globalAlpha = 0.45
      context.fillStyle = ink
      context.fillRect(nowX - 0.75, 0, 1.5, height)

      // 5. Rastro da voz.
      const span = viewHigh - viewLow
      const fold = (midi: number) => {
        // Sem nota alvo, traz a voz para dentro da faixa visível mudando só a oitava.
        const center = (viewLow + viewHigh) / 2
        let value = midi
        while (value - center > 6) value -= 12
        while (center - value > 6) value += 12
        return Math.min(viewHigh + span * 0.04, Math.max(viewLow - span * 0.04, value))
      }
      const shown = (point: { midi: number; target: number | null; diff: number | null }) =>
        point.target !== null && point.diff !== null ? point.target + point.diff : fold(point.midi)

      const { trail } = session
      const radius = Math.max(2.2, thickness * 0.3)
      for (let i = trail.length - 1; i >= 0; i--) {
        const point = trail[i]
        if (point.time < from) break
        const age = (time - point.time) / PAST
        context.globalAlpha = Math.max(0, 1 - age) * (point.credit >= 0.5 ? 1 : 0.55)
        context.fillStyle = point.credit >= 0.5 ? accent : ink
        context.beginPath()
        context.arc(x(point.time), y(shown(point)), radius, 0, Math.PI * 2)
        context.fill()
      }

      // 6. Cursor: onde a voz está neste instante.
      const last = trail[trail.length - 1]
      if (mic.midi !== null && last && time - last.time < 0.35) {
        const onPitch = last.credit >= 0.5
        context.globalAlpha = 1
        context.fillStyle = onPitch ? accent : ink
        context.beginPath()
        context.arc(nowX, y(shown(last)), thickness * 0.62, 0, Math.PI * 2)
        context.fill()
      }
      context.globalAlpha = 1
    })

    return () => {
      stop()
      observer.disconnect()
    }
  }, [session])

  return <canvas ref={canvasRef} aria-hidden className={cn('block h-full w-full', className)} />
}
