import { ArrowDownIcon, ArrowUpIcon, ExportIcon, MicrophoneStageIcon, XIcon } from '@phosphor-icons/react'
import { AnimatePresence, motion } from 'motion/react'
import { useState } from 'react'
import type { FormEvent } from 'react'
import { Link } from 'react-router'
import { Button, IconButton } from '@/components/button'
import { Cover } from '@/components/cover'
import { Field, TextInput } from '@/components/form'
import { formatDuration } from '@/lib/format'
import type { Song } from '@/lib/types'
import { askExport } from '@/state/exporting'
import { useLibrary } from '@/state/library'
import { useQueue } from '@/state/queue'
import { toast } from '@/state/toasts'

/** As músicas da fila, na ordem, já casadas com a biblioteca. */
export function useQueuedSongs(): Array<{ key: string; song: Song }> {
  const items = useQueue((state) => state.items)
  const songs = useLibrary((state) => state.songs)
  return items.flatMap((item) => {
    const song = songs.find((s) => s.id === item.songId)
    return song ? [{ key: item.key, song }] : []
  })
}

export function QueuePage() {
  const queued = useQueuedSongs()
  const playlists = useQueue((state) => state.playlists)
  const { remove, move, clear, savePlaylist, loadPlaylist, deletePlaylist } = useQueue.getState()
  const libraryStatus = useLibrary((state) => state.status)
  const songCount = useLibrary((state) => state.songs.length)
  const [name, setName] = useState('')
  const [nameError, setNameError] = useState<string | null>(null)

  const total = queued.reduce((sum, item) => sum + item.song.duration, 0)

  const save = (event: FormEvent) => {
    event.preventDefault()
    if (!name.trim()) return setNameError('Dê um nome para a playlist.')
    if (!savePlaylist(name)) return setNameError('Já existe uma playlist com esse nome.')
    toast(`Playlist “${name.trim()}” salva.`)
    setName('')
    setNameError(null)
  }

  if (libraryStatus === 'loading') {
    return (
      <div aria-busy="true" className="space-y-3">
        <div className="skeleton h-12 w-48 rounded-field" />
        <div className="skeleton h-20 w-full max-w-3xl rounded-card" />
      </div>
    )
  }

  return (
    <>
      <div className="flex flex-wrap items-end gap-x-4 gap-y-4">
        <h1 className="display text-4xl md:text-5xl">Fila</h1>
        {queued.length > 0 && <span className="numeric mb-1 text-lg text-faint">{queued.length}</span>}
        {queued.length > 0 && (
          <div className="ml-auto flex flex-wrap gap-2">
            <Button variant="ghost" onClick={clear}>
              Esvaziar
            </Button>
            <Button asChild variant="primary">
              <Link to={`/cantar/${queued[0].song.id}`}>
                <MicrophoneStageIcon size={18} weight="fill" />
                Começar a fila
              </Link>
            </Button>
          </div>
        )}
      </div>

      <div className="mt-8 grid gap-x-14 gap-y-12 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <section aria-label="Músicas na fila">
          {queued.length === 0 ? (
            <div className="rounded-card border-2 border-dashed border-hairline bg-surface px-8 py-14 text-center">
              <p className="text-lg font-semibold">A fila está vazia</p>
              <p className="mx-auto mt-1 max-w-[42ch] text-soft">
                {songCount === 0
                  ? 'Adicione músicas à biblioteca e depois monte a ordem em que elas vão ser cantadas.'
                  : 'Na biblioteca, use o botão de fila em cada música para montar a ordem da cantoria.'}
              </p>
              <Button asChild className="mt-5">
                <Link to={songCount === 0 ? '/adicionar' : '/'}>{songCount === 0 ? 'Adicionar música' : 'Ir para a biblioteca'}</Link>
              </Button>
            </div>
          ) : (
            <>
              <ol className="space-y-1">
                <AnimatePresence initial={false}>
                  {queued.map(({ key, song }, index) => (
                    <motion.li
                      key={key}
                      layout
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, x: 24 }}
                      transition={{ type: 'spring', stiffness: 460, damping: 38 }}
                      className="flex items-center gap-4 rounded-card py-2 pr-2 pl-3 hover:bg-ink/5"
                    >
                      <span className="numeric w-6 shrink-0 text-right text-faint">{index + 1}</span>
                      <Cover song={song} className="size-14 shrink-0 rounded-field" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-semibold">{song.title}</p>
                        <p className="truncate text-sm text-soft">{song.artist || 'Artista desconhecido'}</p>
                      </div>
                      <span className="numeric hidden text-sm text-faint sm:block">{formatDuration(song.duration)}</span>
                      <div className="flex shrink-0 items-center">
                        <IconButton label="Subir na fila" size="sm" disabled={index === 0} onClick={() => move(key, -1)}>
                          <ArrowUpIcon size={16} weight="bold" />
                        </IconButton>
                        <IconButton label="Descer na fila" size="sm" disabled={index === queued.length - 1} onClick={() => move(key, 1)}>
                          <ArrowDownIcon size={16} weight="bold" />
                        </IconButton>
                        <IconButton label={`Tirar ${song.title} da fila`} size="sm" onClick={() => remove(key)}>
                          <XIcon size={16} weight="bold" />
                        </IconButton>
                      </div>
                    </motion.li>
                  ))}
                </AnimatePresence>
              </ol>
              <p className="mt-4 pl-3 text-sm text-faint">
                Cerca de <span className="numeric text-soft">{formatDuration(total)}</span> de música. Ao terminar cada uma, a tela de resultado já oferece a próxima.
              </p>
            </>
          )}
        </section>

        <section aria-labelledby="playlists-heading">
          <h2 id="playlists-heading" className="display text-2xl">
            Playlists
          </h2>

          {queued.length > 0 && (
            <form onSubmit={save} className="mt-5 flex items-end gap-2">
              <Field label="Salvar a fila atual como" error={nameError} className="flex-1">
                {(field) => (
                  <TextInput
                    {...field}
                    value={name}
                    onChange={(event) => {
                      setName(event.target.value)
                      setNameError(null)
                    }}
                    placeholder="Churrasco de sábado"
                    maxLength={60}
                  />
                )}
              </Field>
              <Button type="submit" className={nameError ? 'mb-[27px]' : ''}>
                Salvar
              </Button>
            </form>
          )}

          {playlists.length === 0 ? (
            <p className="mt-5 text-soft">
              {queued.length > 0 ? 'Nenhuma playlist salva ainda.' : 'Monte uma fila e salve-a aqui para repetir a mesma seleção outro dia.'}
            </p>
          ) : (
            <ul className="mt-5 space-y-1">
              {playlists.map((playlist) => (
                <li key={playlist.id} className="flex items-center gap-3 rounded-field py-2 pr-1 pl-3 hover:bg-ink/5">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-semibold">{playlist.name}</p>
                    <p className="text-sm text-soft">
                      <span className="numeric">{playlist.songIds.length}</span> {playlist.songIds.length === 1 ? 'música' : 'músicas'}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    disabled={playlist.songIds.length === 0}
                    onClick={() => {
                      loadPlaylist(playlist.id)
                      toast(`“${playlist.name}” entrou na fila.`)
                    }}
                  >
                    Pôr na fila
                  </Button>
                  <IconButton
                    label={`Exportar a playlist ${playlist.name} para outro aparelho`}
                    size="sm"
                    onClick={() => {
                      const songs = useLibrary.getState().songs
                      // Cada música uma vez só, na ordem da playlist.
                      const picked = [...new Set(playlist.songIds)].flatMap((id) => songs.find((song) => song.id === id) ?? [])
                      askExport(playlist.name, picked, [playlist])
                    }}
                  >
                    <ExportIcon size={16} />
                  </IconButton>
                  <IconButton label={`Excluir a playlist ${playlist.name}`} size="sm" onClick={() => deletePlaylist(playlist.id)}>
                    <XIcon size={16} weight="bold" />
                  </IconButton>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  )
}
