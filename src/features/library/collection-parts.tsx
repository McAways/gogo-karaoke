import { CheckIcon, MusicNotesIcon } from '@phosphor-icons/react'
import { useState } from 'react'
import type { FormEvent } from 'react'
import { Button } from '@/components/button'
import { cn } from '@/components/cn'
import { Cover } from '@/components/cover'
import { Field, TextInput } from '@/components/form'
import { Dialog } from '@/components/overlay'
import type { Song } from '@/lib/types'
import { askExport } from '@/state/exporting'
import { useQueue } from '@/state/queue'
import { toast } from '@/state/toasts'
import type { Collection } from './collections'

/** Capa de um álbum ou playlist: as quatro primeiras capas em mosaico, ou uma só quando há poucas músicas. */
export function CoverMosaic({ songs, className }: { songs: Song[]; className?: string }) {
  const distinct = [...new Map(songs.map((song) => [song.id, song])).values()].slice(0, 4)
  if (distinct.length === 0) {
    return (
      <div className={cn('flex items-center justify-center bg-raised text-faint', className)}>
        <MusicNotesIcon size={36} />
      </div>
    )
  }
  if (distinct.length < 4) return <Cover song={distinct[0]} className={className} />
  return (
    <div className={cn('grid grid-cols-2 grid-rows-2 overflow-hidden bg-raised', className)}>
      {distinct.map((song) => (
        <Cover key={song.id} song={song} className="size-full" />
      ))}
    </div>
  )
}

/** Exportar um álbum ou playlist: cada música uma vez, e o conjunto montado dentro do arquivo. */
export function exportCollection(collection: Collection): void {
  const songs = [...new Map(collection.songs.map((song) => [song.id, song])).values()]
  const songIds = collection.songs.map((song) => song.id)
  const saved = collection.playlistId ? useQueue.getState().playlists.find((playlist) => playlist.id === collection.playlistId) : undefined
  // A lista guardada vai como está. O álbum que o app montou sozinho vira álbum de verdade no outro aparelho.
  const entry = saved
    ? { ...saved, songIds }
    : {
        name: collection.artist && collection.artist !== 'Vários artistas' ? `${collection.name}, de ${collection.artist}` : collection.name,
        songIds,
        ...(collection.kind === 'album' ? { kind: 'album' as const, album: collection.name, artist: collection.artist } : {}),
      }
  askExport(collection.name, songs, [entry])
}

/** Escolher em que playlist pôr uma música, ou criar uma nova com ela. */
export function AddToPlaylistDialog({ song, onClose }: { song: Song | null; onClose: () => void }) {
  const playlists = useQueue((state) => state.playlists).filter((playlist) => playlist.kind !== 'album')
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)

  const close = () => {
    setName('')
    setError(null)
    onClose()
  }

  const create = (event: FormEvent) => {
    event.preventDefault()
    if (!song) return
    if (!name.trim()) return setError('Escreva um nome para a playlist.')
    if (!useQueue.getState().createPlaylist(name, [song.id])) return setError('Já existe uma playlist com esse nome.')
    toast(`“${song.title}” entrou na playlist nova “${name.trim()}”.`)
    close()
  }

  return (
    <Dialog open={song !== null} onOpenChange={(open) => !open && close()} title="Adicionar a uma playlist" description={song ? `“${song.title}”${song.artist ? `, de ${song.artist}` : ''}` : undefined}>
      {song && (
        <>
          {playlists.length > 0 && (
            <ul className="mb-6 space-y-1">
              {playlists.map((playlist) => {
                const inside = playlist.songIds.includes(song.id)
                return (
                  <li key={playlist.id} className="flex items-center gap-3 rounded-field py-1.5 pr-1 pl-3 hover:bg-ink/5">
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-semibold">{playlist.name}</p>
                      <p className="text-[13px] text-soft">
                        <span className="numeric">{playlist.songIds.length}</span> {playlist.songIds.length === 1 ? 'música' : 'músicas'}
                      </p>
                    </div>
                    {inside ? (
                      <span className="inline-flex items-center gap-1 px-3 text-sm font-semibold text-accent-ink">
                        <CheckIcon size={14} weight="bold" />
                        Já está
                      </span>
                    ) : (
                      <Button
                        size="sm"
                        onClick={() => {
                          useQueue.getState().addToPlaylist(playlist.id, song.id)
                          toast(`“${song.title}” entrou em “${playlist.name}”.`)
                          close()
                        }}
                      >
                        Adicionar
                      </Button>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
          <form onSubmit={create} className="flex items-end gap-2">
            <Field label={playlists.length > 0 ? 'Ou criar uma playlist nova' : 'Nome da playlist nova'} error={error} className="min-w-0 flex-1">
              {(field) => (
                <TextInput
                  {...field}
                  value={name}
                  maxLength={60}
                  autoComplete="off"
                  placeholder="Sexta à noite"
                  onChange={(event) => {
                    setName(event.target.value)
                    setError(null)
                  }}
                />
              )}
            </Field>
            <Button type="submit" variant="primary" className={error ? 'mb-7' : ''}>
              Criar
            </Button>
          </form>
        </>
      )}
    </Dialog>
  )
}
