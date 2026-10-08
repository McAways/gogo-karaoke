/** 3:07, ou 1:02:45 quando passa de uma hora. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const total = Math.round(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const tail = `${String(s).padStart(2, '0')}`
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${tail}` : `${m}:${tail}`
}

/** 3:07.4 (décimos), para o editor de sincronia. */
export function formatPreciseTime(seconds: number): string {
  const safe = Math.max(0, seconds)
  const m = Math.floor(safe / 60)
  const s = safe - m * 60
  return `${m}:${s.toFixed(2).padStart(5, '0')}`
}

const decimal = (value: number, digits: number) => value.toLocaleString('pt-BR', { minimumFractionDigits: digits, maximumFractionDigits: digits })

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB'
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  if (bytes < 1024 ** 3) return `${decimal(bytes / 1024 ** 2, bytes < 10 * 1024 ** 2 ? 1 : 0)} MB`
  const gb = bytes / 1024 ** 3
  return `${decimal(gb, gb < 10 ? 1 : 0)} GB`
}

const pointsFormat = new Intl.NumberFormat('pt-BR')

/** 7.420 */
export function formatPoints(points: number): string {
  return pointsFormat.format(Math.round(points))
}

export function formatPercent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`
}

const dateFormat = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })

export function formatDate(timestamp: number): string {
  return dateFormat.format(timestamp)
}

/** +0,3 s / -1,2 s */
export function formatOffset(seconds: number): string {
  const rounded = Math.round(seconds * 10) / 10
  const sign = rounded > 0 ? '+' : rounded < 0 ? '-' : ''
  return `${sign}${Math.abs(rounded).toFixed(1).replace('.', ',')} s`
}

const listFormat = new Intl.ListFormat('pt-BR', { style: 'long', type: 'conjunction' })

/** Ana, Beto e Caio */
export function formatList(items: string[]): string {
  return listFormat.format(items)
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

const NOTE_NAMES = ['Dó', 'Dó#', 'Ré', 'Ré#', 'Mi', 'Fá', 'Fá#', 'Sol', 'Sol#', 'Lá', 'Lá#', 'Si']

/** Nome da nota em português com a oitava: 69 vira Lá4. */
export function noteName(midi: number): string {
  const rounded = Math.round(midi)
  return `${NOTE_NAMES[((rounded % 12) + 12) % 12]}${Math.floor(rounded / 12) - 1}`
}
