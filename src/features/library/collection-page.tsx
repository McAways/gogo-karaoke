import { ArrowLeftIcon, ExportIcon, MicrophoneStageIcon, QueueIcon, TrashIcon, XIcon } from '@phosphor-icons/react'
import { useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { Button, IconButton } from '@/components/button'
import { Cover } from '@/components/cover'
import { Dialog } from '@/components/overlay'
import { formatDuration, formatPoints } from '@/lib/format'
import { useLibrary } from '@/state/library'
import { useQueue } from '@/state/queue'
import { toast } from '@/state/toasts'
import { CoverMosaic, exportCollection } from './collection-parts'
import { buildCollections, totalDuration } from './collections'
import { enqueueCollection, songStatus } from './library-page'

const BACK = '/?aba=colecoes'

/** Página de um álbum ou de uma playlist: as músicas, na ordem, e o que dá para fazer com o conjunto. */
export function CollectionPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const songs = useLibrary((state) => state.songs)
  const status = useLibrary((state) => state.status)
  const playlists = useQueue((state) => state.playlists)
  const [confirming, setConfirming] = useState(false)

  const collection = useMemo(() => buildCollections(songs, playlists).find((entry) => entry.id === id), [songs, playlists, id])

  if (status === 'loading') {
    return (
      <div aria-busy="true">
        <div className="skeleton h-5 w-40 rounded-full" />
        <div className="skeleton mt-6 h-40 w-full max-w-xl rounded-card" />
      </div>
    )
  }

  if (!collection) {
    return (
      <section className="flex min-h-[55dvh] flex-col items-start justify-center">
        <h1 className="display text-4xl md:text-5xl">Esse álbum ou playlist não existe mais.</h1>
        <p className="mt-4 max-w-[52ch] text-lg text-soft">Pode ter sido excluído, ou as músicas dele saíram da biblioteca.</p>
        <Button asChild variant="primary" className="mt-7">
          <Link to={BACK}>Ver álbuns e playlists</Link>
        </Button>
      </section>
    )
  }

  const count = collection.songs.length
  const saved = collection.playlistId !== undefined
  const label = collection.kind === 'album' ? 'Álbum' : 'Playlist'

  const sing = () => {
    const ids = collection.songs.map((song) => song.id)
    if (ids.length === 0) return
    // O conjunto entra na frente da fila: a primeira toca agora e as outras vêm em seguida.
    useQueue.getState().playNext(ids)
    void navigate(`/cantar/${ids[0]}`)
  }

  return (
    <>
      <Link to={BACK} className="inline-flex items-center gap-2 text-sm font-semibold text-soft hover:text-ink">
        <ArrowLeftIcon size={16} />
        Álbuns e playlists
      </Link>

      <div className="mt-6 grid items-end gap-x-10 gap-y-6 md:grid-cols-[minmax(0,240px)_minmax(0,1fr)]">
        <CoverMosaic songs={collection.songs} className="aspect-square w-full max-w-60 rounded-card" />
        <div className="min-w-0">
          <p className="text-[13px] font-semibold text-accent-ink">{label}</p>
          <h1 className="display mt-2 text-4xl text-balance md:text-5xl">{collection.name}</h1>
          {collection.artist && <p className="mt-2 text-lg text-soft">{collection.artist}</p>}
          <p className="mt-3 text-soft">
            <span className="numeric text-ink">{count}</span> {count === 1 ? 'música' : 'músicas'}
            {count > 0 && (
              <>
                , <span className="numeric text-ink">{formatDuration(totalDuration(collection))}</span> no total
              </>
            )}
          </p>

          <div className="mt-6 flex flex-wrap gap-2">
            <Button variant="primary" size="lg" disabled={count === 0} onClick={sing}>
              <MicrophoneStageIcon size={20} weight="fill" />
              Cantar agora
            </Button>
            <Button size="lg" disabled={count === 0} onClick={() => enqueueCollection(collection)}>
              <QueueIcon size={20} />
              Pôr na fila
            </Button>
            <Button size="lg" disabled={count === 0} onClick={() => exportCollection(collection)}>
              <ExportIcon size={20} />
              Exportar {collection.kind === 'album' ? 'álbum' : 'playlist'}
            </Button>
            {saved && (
              <Button variant="ghost" size="lg" onClick={() => setConfirming(true)}>
                <TrashIcon size={20} />
                Excluir
              </Button>
            )}
          </div>
        </div>
      </div>

      {count === 0 ? (
        <p className="mt-12 max-w-[56ch] text-soft">
          {collection.kind === 'album'
            ? 'As músicas deste álbum não estão mais na biblioteca. Dá para excluí-lo daqui, ou colar de novo o link do álbum em “Adicionar música” para baixá-las.'
            : 'Esta playlist está vazia. Dá para excluí-la, ou pôr músicas nela pelo menu de cada música, na biblioteca.'}
        </p>
      ) : (
        <ol className="mt-12">
          {collection.songs.map((song, index) => {
            const missing = songStatus(song)
            return (
              // A mesma música pode estar duas vezes numa playlist: a posição entra na chave.
              <li key={`${song.id}-${index}`} className="flex items-center gap-4 border-t border-hairline py-3">
                <span className="numeric w-7 shrink-0 text-right text-sm text-faint">{index + 1}</span>
                <Link to={`/musica/${song.id}`} className="shrink-0 overflow-hidden rounded-field" aria-label={`${song.title}, ver detalhes`}>
                  <Cover song={song} className="size-12" />
                </Link>
                <Link to={`/musica/${song.id}`} className="min-w-0 flex-1">
                  <p className="truncate font-semibold">{song.title}</p>
                  <p className="truncate text-sm text-soft">
                    {song.artist || 'Artista desconhecido'}
                    {missing && <span className="ml-2 text-faint">{missing}</span>}
                  </p>
                </Link>
                {song.bestScore !== undefined && <span className="numeric hidden text-sm sm:block">{formatPoints(song.bestScore)}</span>}
                <span className="numeric w-12 text-right text-sm text-faint">{formatDuration(song.duration)}</span>
                <Link
                  to={`/cantar/${song.id}`}
                  aria-label={`Cantar ${song.title}`}
                  className="flex size-10 shrink-0 items-center justify-center rounded-full bg-accent text-on-accent transition-transform duration-200 ease-expo hover:scale-105 active:scale-95"
                >
                  <MicrophoneStageIcon size={18} weight="fill" />
                </Link>
                {saved && (
                  <IconButton
                    label={`Tirar ${song.title} ${collection.kind === 'album' ? 'deste álbum' : 'desta playlist'}`}
                    size="sm"
                    onClick={() => {
                      useQueue.getState().removeFromPlaylist(collection.playlistId!, index)
                      toast(`“${song.title}” saiu de “${collection.name}”. A música continua na biblioteca.`)
                    }}
                  >
                    <XIcon size={16} weight="bold" />
                  </IconButton>
                )}
              </li>
            )
          })}
        </ol>
      )}

      {!saved && <p className="mt-8 max-w-[62ch] text-sm text-faint">Este álbum foi montado pelo app com as músicas que dizem ser dele. Ele some se sobrar só uma.</p>}

      <Dialog
        open={confirming}
        onOpenChange={setConfirming}
        title={collection.kind === 'album' ? 'Excluir este álbum da lista?' : 'Excluir esta playlist?'}
        description={`“${collection.name}” deixa de aparecer aqui. As músicas continuam na biblioteca.`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              Manter
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                if (collection.playlistId) useQueue.getState().deletePlaylist(collection.playlistId)
                setConfirming(false)
                void navigate(BACK, { replace: true })
              }}
            >
              Excluir
            </Button>
          </>
        }
      />
    </>
  )
}
