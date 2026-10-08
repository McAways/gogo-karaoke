import { DotsThreeIcon, ExportIcon, InfoIcon, ListPlusIcon, MagnifyingGlassIcon, MicrophoneStageIcon, PlusIcon, QueueIcon } from '@phosphor-icons/react'
import { motion } from 'motion/react'
import { useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { Button } from '@/components/button'
import { Cover } from '@/components/cover'
import { DropZone } from '@/components/drop-zone'
import { Segmented, TextInput } from '@/components/form'
import { Menu, MenuItem } from '@/components/overlay'
import { formatDuration, formatPoints } from '@/lib/format'
import { normalize } from '@/lib/titles'
import type { Song } from '@/lib/types'
import { askExport } from '@/state/exporting'
import { importFiles } from '@/state/jobs'
import { useLibrary } from '@/state/library'
import { useQueue } from '@/state/queue'
import { toast } from '@/state/toasts'
import { AddToPlaylistDialog, CoverMosaic, exportCollection } from './collection-parts'
import { buildCollections } from './collections'
import type { Collection } from './collections'

/** O que falta para a música estar completa, em poucas palavras. Vazio quando está tudo certo. */
export function songStatus(song: Song): string {
  if (song.melody === 'pending') return 'analisando'
  if (song.lyrics === 'none') return 'sem letra'
  if (song.lyrics === 'plain') return 'letra sem sincronia'
  return ''
}

/** Põe a música no fim da fila e avisa em que posição ela ficou. */
export function enqueue(song: Song): void {
  const position = useQueue.getState().add(song.id)
  toast(position === 1 ? `“${song.title}” é a próxima da fila.` : `“${song.title}” entrou na fila, na ${position}ª posição.`)
}

/** Põe na fila todas as músicas de um álbum ou playlist, na ordem. */
export function enqueueCollection(collection: Collection): void {
  if (collection.songs.length === 0) return
  for (const song of collection.songs) useQueue.getState().add(song.id)
  toast(collection.songs.length === 1 ? `1 música de “${collection.name}” entrou na fila.` : `${collection.songs.length} músicas de “${collection.name}” entraram na fila.`)
}

type Tab = 'musicas' | 'colecoes'

/** Botão redondo que aparece sobre a capa ao passar o mouse (e fica sempre visível no toque). */
const FLOATING =
  'flex size-12 translate-y-2 items-center justify-center rounded-full opacity-0 shadow-[var(--shadow)] transition-[opacity,transform] duration-300 ease-expo group-hover:translate-y-0 group-hover:opacity-100 focus-visible:translate-y-0 focus-visible:opacity-100 active:scale-95 [@media(hover:none)]:translate-y-0 [@media(hover:none)]:opacity-100'

function Featured({ song }: { song: Song }) {
  return (
    <section className="grid items-end gap-6 md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)] md:gap-12">
      <Link to={`/cantar/${song.id}`} aria-label={`Cantar ${song.title}`} className="group block overflow-hidden rounded-card">
        <Cover song={song} className="aspect-[16/10] w-full transition-transform duration-700 ease-expo group-hover:scale-[1.03]" />
      </Link>

      <div className="min-w-0 md:pb-3">
        <p className="text-[13px] font-semibold text-accent-ink">{song.lastSungAt ? 'A última que você cantou' : 'Acabou de chegar'}</p>
        <h2 className="display mt-3 line-clamp-3 text-4xl leading-[0.98] text-balance md:text-5xl xl:text-6xl">{song.title}</h2>
        {song.artist && <p className="mt-3 truncate text-lg text-soft">{song.artist}</p>}

        <div className="mt-7 flex flex-wrap items-center gap-2">
          <Button asChild variant="primary" size="lg">
            <Link to={`/cantar/${song.id}`}>
              <MicrophoneStageIcon size={20} weight="fill" />
              Cantar
            </Link>
          </Button>
          <Button size="lg" onClick={() => enqueue(song)}>
            <QueueIcon size={20} />
            Pôr na fila
          </Button>
          <Button asChild variant="ghost" size="lg">
            <Link to={`/musica/${song.id}`}>Detalhes</Link>
          </Button>
        </div>

        <dl className="mt-8 flex gap-10 text-sm">
          <div>
            <dt className="text-faint">Duração</dt>
            <dd className="numeric mt-0.5 text-base">{formatDuration(song.duration)}</dd>
          </div>
          <div>
            <dt className="text-faint">Melhor nota</dt>
            <dd className="numeric mt-0.5 text-base">{song.bestScore !== undefined ? formatPoints(song.bestScore) : 'sem nota'}</dd>
          </div>
        </dl>
      </div>
    </section>
  )
}

function SongTile({ song, index, onAddToPlaylist }: { song: Song; index: number; onAddToPlaylist: (song: Song) => void }) {
  const status = songStatus(song)
  const navigate = useNavigate()
  return (
    <motion.article
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: Math.min(index, 12) * 0.035, ease: [0.16, 1, 0.3, 1] }}
      className="group relative min-w-0"
    >
      <div className="relative">
        <Link to={`/musica/${song.id}`} className="block overflow-hidden rounded-card" aria-label={`${song.title}, ver detalhes`}>
          <Cover song={song} className="aspect-square w-full transition-transform duration-700 ease-expo group-hover:scale-[1.05]" />
        </Link>
        <Link to={`/cantar/${song.id}`} aria-label={`Cantar ${song.title}`} className={`absolute right-3 bottom-3 bg-accent text-on-accent ${FLOATING}`}>
          <MicrophoneStageIcon size={22} weight="fill" />
        </Link>
        <button type="button" aria-label={`Pôr ${song.title} na fila`} onClick={() => enqueue(song)} className={`absolute right-[4.25rem] bottom-3 border border-hairline bg-canvas/90 text-ink ${FLOATING}`}>
          <QueueIcon size={22} />
        </button>
        <Menu
          trigger={
            <button
              type="button"
              aria-label={`Mais ações para ${song.title}`}
              className="absolute top-3 right-3 flex size-10 items-center justify-center rounded-full border border-hairline bg-canvas/90 text-ink opacity-0 shadow-[var(--shadow)] transition-opacity duration-300 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 [@media(hover:none)]:opacity-100"
            >
              <DotsThreeIcon size={22} weight="bold" />
            </button>
          }
        >
          <MenuItem icon={<QueueIcon size={18} />} onSelect={() => enqueue(song)}>
            Pôr na fila
          </MenuItem>
          <MenuItem icon={<ListPlusIcon size={18} />} onSelect={() => onAddToPlaylist(song)}>
            Adicionar a uma playlist
          </MenuItem>
          <MenuItem icon={<ExportIcon size={18} />} onSelect={() => askExport(song.title, [song])}>
            Exportar esta música
          </MenuItem>
          <MenuItem icon={<InfoIcon size={18} />} onSelect={() => void navigate(`/musica/${song.id}`)}>
            Detalhes
          </MenuItem>
        </Menu>
      </div>

      <Link to={`/musica/${song.id}`} tabIndex={-1} className="mt-3 block min-w-0">
        <h3 className="truncate font-semibold">{song.title}</h3>
        <p className="truncate text-sm text-soft">{song.artist || 'Artista desconhecido'}</p>
      </Link>
      <p className="mt-1.5 flex items-center gap-3 text-[13px] text-faint">
        <span className="numeric">{formatDuration(song.duration)}</span>
        {status && <span>{status}</span>}
        {song.bestScore !== undefined && <span className="numeric ml-auto text-ink">{formatPoints(song.bestScore)}</span>}
      </p>
    </motion.article>
  )
}

function CollectionTile({ collection, index }: { collection: Collection; index: number }) {
  const count = collection.songs.length
  return (
    <motion.div
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: Math.min(index, 12) * 0.035, ease: [0.16, 1, 0.3, 1] }}
      className="group relative min-w-0"
    >
      <div className="relative">
        <Link to={`/colecao/${collection.id}`} className="block overflow-hidden rounded-card" aria-label={`Abrir ${collection.name}`}>
          <CoverMosaic songs={collection.songs} className="aspect-square w-full transition-transform duration-700 ease-expo group-hover:scale-[1.05]" />
        </Link>
        {count > 0 && (
          <button
            type="button"
            aria-label={`Pôr ${collection.name} inteiro na fila`}
            onClick={() => enqueueCollection(collection)}
            className={`absolute right-3 bottom-3 border border-hairline bg-canvas/90 text-ink ${FLOATING}`}
          >
            <QueueIcon size={22} />
          </button>
        )}
        {count > 0 && (
          <button
            type="button"
            aria-label={`Exportar ${collection.name}`}
            onClick={() => exportCollection(collection)}
            className={`absolute right-[4.25rem] bottom-3 border border-hairline bg-canvas/90 text-ink ${FLOATING}`}
          >
            <ExportIcon size={22} />
          </button>
        )}
      </div>
      <Link to={`/colecao/${collection.id}`} tabIndex={-1} className="mt-3 block min-w-0">
        <h3 className="truncate font-semibold">{collection.name}</h3>
        <p className="truncate text-sm text-soft">
          {collection.artist && `${collection.artist}, `}
          <span className="numeric">{count}</span> {count === 1 ? 'música' : 'músicas'}
        </p>
      </Link>
    </motion.div>
  )
}

function EmptyLibrary() {
  return (
    <section className="grid min-h-[68dvh] items-center gap-10 md:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] md:gap-16">
      <div>
        <h1 className="display text-5xl text-balance md:text-6xl xl:text-7xl">Sua biblioteca começa aqui.</h1>
        <p className="mt-6 max-w-[46ch] text-lg text-soft">
          Busque uma música no YouTube ou traga um arquivo seu. A letra sincronizada e o guia de melodia chegam sozinhos.
        </p>
        <Button asChild variant="primary" size="lg" className="mt-8">
          <Link to="/adicionar">
            <PlusIcon size={20} weight="bold" />
            Adicionar música
          </Link>
        </Button>
      </div>
      <DropZone onFiles={importFiles} />
    </section>
  )
}

function LibrarySkeleton() {
  return (
    <div aria-busy="true" aria-label="Carregando a biblioteca">
      <div className="grid items-end gap-6 md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)] md:gap-12">
        <div className="skeleton aspect-[16/10] rounded-card" />
        <div className="space-y-4 md:pb-3">
          <div className="skeleton h-4 w-40 rounded-full" />
          <div className="skeleton h-12 w-4/5 rounded-field" />
          <div className="skeleton h-5 w-1/2 rounded-full" />
          <div className="skeleton h-14 w-40 rounded-full" />
        </div>
      </div>
      <div className="mt-16 grid grid-cols-2 gap-x-4 gap-y-9 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i}>
            <div className="skeleton aspect-square rounded-card" />
            <div className="skeleton mt-3 h-4 w-3/4 rounded-full" />
            <div className="skeleton mt-2 h-3.5 w-1/2 rounded-full" />
          </div>
        ))}
      </div>
    </div>
  )
}

const GRID = 'grid grid-cols-2 gap-x-4 gap-y-9 sm:grid-cols-3 md:gap-x-6 lg:grid-cols-4 xl:grid-cols-5'

function CollectionGroup({ id, title, collections }: { id: string; title: string; collections: Collection[] }) {
  if (collections.length === 0) return null
  return (
    <section aria-labelledby={id} className="mt-10 first:mt-9">
      <h2 id={id} className="display text-2xl">
        {title}
        <span className="numeric ml-3 text-lg text-faint">{collections.length}</span>
      </h2>
      <div className={`mt-6 ${GRID}`}>
        {collections.map((collection, index) => (
          <CollectionTile key={collection.id} collection={collection} index={index} />
        ))}
      </div>
    </section>
  )
}

export function LibraryPage() {
  const songs = useLibrary((state) => state.songs)
  const status = useLibrary((state) => state.status)
  const reload = useLibrary((state) => state.load)
  const playlists = useQueue((state) => state.playlists)
  const [params, setParams] = useSearchParams()
  const [query, setQuery] = useState('')
  const [adding, setAdding] = useState<Song | null>(null)

  // A aba fica no endereço: voltar da página de um álbum cai de novo em "Álbuns e playlists".
  const tab: Tab = params.get('aba') === 'colecoes' ? 'colecoes' : 'musicas'

  const featured = useMemo(() => {
    const sung = songs.filter((s) => s.lastSungAt).sort((a, b) => (b.lastSungAt ?? 0) - (a.lastSungAt ?? 0))[0]
    return sung ?? songs[0]
  }, [songs])

  const collections = useMemo(() => buildCollections(songs, playlists), [songs, playlists])
  const needle = normalize(query)

  const filtered = useMemo(() => {
    if (!needle) return songs
    return songs.filter((s) => normalize(`${s.title} ${s.artist}`).includes(needle))
  }, [songs, needle])

  const shownCollections = useMemo(() => {
    if (!needle) return collections
    return collections.filter((c) => normalize(`${c.name} ${c.artist}`).includes(needle))
  }, [collections, needle])

  if (status === 'loading') return <LibrarySkeleton />

  if (status === 'error') {
    return (
      <section className="flex min-h-[60dvh] flex-col items-start justify-center">
        <h1 className="display text-4xl md:text-5xl">A biblioteca não abriu.</h1>
        <p className="mt-4 max-w-[52ch] text-lg text-soft">
          O navegador recusou o acesso ao armazenamento local. Isso costuma acontecer em janela anônima ou com os dados do site bloqueados.
        </p>
        <Button className="mt-7" onClick={() => void reload()}>
          Tentar de novo
        </Button>
      </section>
    )
  }

  if (songs.length === 0) return <EmptyLibrary />

  return (
    <>
      <Featured song={featured} />

      <section className="mt-16 md:mt-20">
        <div className="flex flex-wrap items-end gap-x-4 gap-y-5">
          <h1 className="display text-4xl md:text-5xl">Biblioteca</h1>
          <span className="numeric mb-1 text-lg text-faint">{tab === 'musicas' ? songs.length : collections.length}</span>
          <div className="relative w-full sm:ml-auto sm:w-80">
            <label htmlFor="library-search" className="sr-only">
              Buscar na biblioteca
            </label>
            <MagnifyingGlassIcon size={18} className="pointer-events-none absolute top-1/2 left-4 -translate-y-1/2 text-faint" />
            <TextInput
              id="library-search"
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={tab === 'musicas' ? 'Música ou artista' : 'Álbum, playlist ou artista'}
              className="rounded-full pl-11"
            />
          </div>
        </div>

        <div className="mt-6 flex flex-wrap items-center gap-3">
          <Segmented
            label="O que mostrar da biblioteca"
            value={tab}
            onChange={(value) => setParams(value === 'colecoes' ? { aba: 'colecoes' } : {}, { replace: true })}
            options={[
              { value: 'musicas', label: 'Músicas' },
              { value: 'colecoes', label: 'Álbuns e playlists' },
            ]}
          />
          {/* Em tela larga este botão está no menu de cima, em todas as telas. */}
          <Button size="sm" className="ml-auto lg:hidden" onClick={() => askExport('Minha biblioteca', songs, playlists)}>
            <ExportIcon size={16} weight="bold" />
            Exportar
          </Button>
        </div>

        {tab === 'musicas' &&
          (filtered.length === 0 ? (
            <p className="mt-12 text-lg text-soft">
              Nada na biblioteca com <span className="font-semibold text-ink">“{query}”</span>.
            </p>
          ) : (
            <div className={`mt-9 ${GRID}`}>
              {filtered.map((song, index) => (
                <SongTile key={song.id} song={song} index={index} onAddToPlaylist={setAdding} />
              ))}
            </div>
          ))}

        {tab === 'colecoes' &&
          (collections.length === 0 ? (
            <div className="mt-12 max-w-[60ch]">
              <p className="text-lg text-soft">Nenhuma playlist nem álbum ainda.</p>
              <p className="mt-3 text-soft">
                Para montar uma playlist, abra o menu de uma música e escolha “Adicionar a uma playlist”, ou salve a fila na tela da fila. O link de um álbum ou de uma playlist do
                Spotify, em “Adicionar música”, traz o conjunto inteiro. Álbuns também aparecem sozinhos quando há duas ou mais músicas do mesmo.
              </p>
            </div>
          ) : shownCollections.length === 0 ? (
            <p className="mt-12 text-lg text-soft">
              Nenhum álbum ou playlist com <span className="font-semibold text-ink">“{query}”</span>.
            </p>
          ) : (
            <>
              <CollectionGroup id="playlists-heading" title="Playlists" collections={shownCollections.filter((c) => c.kind === 'playlist')} />
              <CollectionGroup id="albums-heading" title="Álbuns" collections={shownCollections.filter((c) => c.kind === 'album')} />
            </>
          ))}
      </section>

      <AddToPlaylistDialog song={adding} onClose={() => setAdding(null)} />
    </>
  )
}
