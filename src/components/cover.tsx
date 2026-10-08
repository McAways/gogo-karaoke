import { useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import { coverUrl } from '@/lib/storage/files'
import type { Song } from '@/lib/types'
import { cn } from './cn'

/** undefined enquanto carrega, null quando a música não tem capa. */
export function useCoverUrl(file: string | undefined): string | null | undefined {
  const [url, setUrl] = useState<string | null | undefined>(file ? undefined : null)

  useEffect(() => {
    if (!file) return setUrl(null)
    let alive = true
    setUrl(undefined)
    void coverUrl(file).then((value) => alive && setUrl(value))
    return () => {
      alive = false
    }
  }, [file])

  return url
}

function hueOf(seed: string): number {
  let hash = 0
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0
  return hash % 360
}

function initials(title: string): string {
  const words = title.replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean)
  if (words.length === 0) return '?'
  if (words.length === 1) return words[0].slice(0, 2)
  return words[0][0] + words[1][0]
}

/**
 * Capa da música. Sem imagem (arquivo de áudio local), vira um bloco tipográfico
 * com as iniciais do título e um tom próprio de cada música.
 */
export function Cover({ song, className }: { song: Pick<Song, 'id' | 'title' | 'coverFile'>; className?: string }) {
  const url = useCoverUrl(song.coverFile)

  return (
    <div className={cn('@container relative overflow-hidden bg-raised', className)}>
      {url === undefined && <div className="skeleton absolute inset-0" />}
      {url && <img src={url} alt="" draggable={false} className="size-full object-cover" />}
      {url === null && (
        <div
          aria-hidden
          className="flex size-full items-end overflow-hidden bg-[oklch(var(--tile-l)_var(--tile-c)_var(--tile-h))] p-[8cqw]"
          style={{ '--tile-h': hueOf(song.id) } as CSSProperties}
        >
          <span className="display text-[46cqw] leading-[0.8] text-ink/80 uppercase">{initials(song.title)}</span>
        </div>
      )}
    </div>
  )
}
