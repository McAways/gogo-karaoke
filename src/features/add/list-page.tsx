import { ArrowsClockwiseIcon, CheckIcon, DownloadSimpleIcon, MagnifyingGlassIcon } from '@phosphor-icons/react'
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { Button } from '@/components/button'
import { cn } from '@/components/cn'
import { Dialog } from '@/components/overlay'
import { formatDuration } from '@/lib/format'
import type { VideoSummary } from '@/lib/helper'
import { PARALLEL, useBatch } from '@/state/batch'
import type { BatchItem, BatchStatus } from '@/state/batch'
import { toast } from '@/state/toasts'

const BUSY: BatchStatus[] = ['procurando', 'baixando']
const DONE: BatchStatus[] = ['pronta', 'na-biblioteca']

function statusText(item: BatchItem): string {
  switch (item.status) {
    case 'pendente':
      return item.video ? 'Na fila para baixar.' : 'Na fila. O vídeo é procurado na hora de baixar.'
    case 'procurando':
      return 'Procurando o vídeo no YouTube.'
    case 'baixando':
      return 'Baixando e preparando. O andamento aparece no painel de importações.'
    case 'pronta':
      return 'Pronta para cantar.'
    case 'na-biblioteca':
      return 'Já estava na biblioteca.'
    case 'falhou':
      return item.error ?? 'O download falhou.'
    case 'sem-video':
      return 'Não achei um vídeo que pareça ser esta gravação. Escolha um.'
    case 'arquivo':
      return 'Veio de um arquivo do computador, então não há de onde baixar. Dá para escolher um vídeo do YouTube no lugar.'
  }
}

/** Escolha manual do vídeo de um item: mostra os resultados da busca, do mais ao menos parecido. */
function VideoChooser({ item, onClose }: { item: BatchItem; onClose: () => void }) {
  const [error, setError] = useState<string | null>(null)
  const videos: VideoSummary[] | null = item.candidates ?? null
  const asked = useRef(false)

  useEffect(() => {
    if (item.candidates || asked.current) return
    asked.current = true
    useBatch
      .getState()
      .findVideos(item.key)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'A busca falhou.'))
  }, [item.key, item.candidates])

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()} title="Escolher o vídeo" description={`${item.title}${item.artist ? `, de ${item.artist}` : ''}${item.duration ? ` (${formatDuration(item.duration)})` : ''}`} wide>
      {error && <p className="text-danger">{error}</p>}
      {!videos && !error && (
        <ul aria-busy="true" className="space-y-3">
          {[0, 1, 2].map((row) => (
            <li key={row} className="skeleton h-16 rounded-field" />
          ))}
        </ul>
      )}
      {videos?.length === 0 && <p className="text-soft">Nenhum vídeo encontrado para esta música.</p>}
      {videos && videos.length > 0 && (
        <ul className="space-y-1">
          {videos.map((video) => (
            <li key={video.id} className="flex items-center gap-4 rounded-field py-2 pr-2 pl-2 hover:bg-ink/5">
              <img src={video.thumbnail} alt="" loading="lazy" className="aspect-video w-24 shrink-0 rounded-field bg-raised object-cover" />
              <div className="min-w-0 flex-1">
                <p className="line-clamp-2 text-sm font-semibold">{video.title}</p>
                <p className="mt-0.5 truncate text-[13px] text-soft">
                  {video.channel} <span className="numeric ml-2 text-faint">{formatDuration(video.duration)}</span>
                </p>
              </div>
              <Button
                size="sm"
                variant={item.video?.id === video.id ? 'primary' : 'secondary'}
                onClick={() => {
                  useBatch.getState().choose(item.key, video)
                  onClose()
                }}
              >
                {item.video?.id === video.id ? 'Em uso' : 'Usar este'}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  )
}

export function ListPage() {
  const batch = useBatch((state) => state.batch)
  const running = useBatch((state) => state.running)
  const [choosing, setChoosing] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)

  useEffect(() => {
    void useBatch.getState().load()
  }, [])

  if (!batch) {
    return (
      <section className="flex min-h-[55dvh] flex-col items-start justify-center">
        <h1 className="display text-4xl md:text-5xl">Nenhuma lista aberta.</h1>
        <p className="mt-4 max-w-[54ch] text-lg text-soft">
          Cole o link de uma playlist ou de um álbum do Spotify, ou abra um arquivo de lista exportado de outro aparelho, na tela de adicionar música.
        </p>
        <Button asChild variant="primary" className="mt-7">
          <Link to="/adicionar">Adicionar música</Link>
        </Button>
      </section>
    )
  }

  const { downloadOne, downloadAll, stop, discard } = useBatch.getState()
  const done = batch.items.filter((item) => DONE.includes(item.status)).length
  const pending = batch.items.filter((item) => item.status === 'pendente').length
  const stuck = batch.items.filter((item) => item.status === 'falhou' || item.status === 'sem-video' || item.status === 'arquivo').length
  const inFlight = batch.items.filter((item) => BUSY.includes(item.status)).length
  // À mão também vale o limite: enquanto o "baixar tudo" anda, ou com três em andamento, espera.
  const busy = running || inFlight >= PARALLEL
  const chosen = choosing ? batch.items.find((item) => item.key === choosing) : undefined

  return (
    <>
      <div className="flex flex-wrap items-end gap-x-6 gap-y-4">
        <div className="min-w-0">
          <p className="text-[13px] font-semibold text-soft">{batch.source !== 'spotify' ? 'Lista exportada' : batch.kind === 'album' ? 'Álbum do Spotify' : 'Playlist do Spotify'}</p>
          <h1 className="display mt-1 text-4xl text-balance md:text-5xl">{batch.name}</h1>
        </div>
        <div className="ml-auto flex flex-wrap gap-2">
          <Button variant="ghost" onClick={() => setConfirming(true)}>
            Descartar a lista
          </Button>
          {running ? (
            <Button onClick={stop}>Parar depois das que estão baixando</Button>
          ) : (
            pending > 0 && (
              <Button variant="primary" disabled={inFlight > 0} onClick={() => void downloadAll()}>
                <DownloadSimpleIcon size={18} weight="bold" />
                Baixar {pending === 1 ? 'a que falta' : `as ${pending} que faltam`}
              </Button>
            )
          )}
        </div>
      </div>

      <p className="mt-4 text-soft">
        {batch.items.length} {batch.items.length === 1 ? 'música' : 'músicas'}: <span className="numeric text-ink">{done}</span> na biblioteca
        {pending > 0 && (
          <>
            , <span className="numeric text-ink">{pending}</span> para baixar
          </>
        )}
        {stuck > 0 && (
          <>
            , <span className="numeric text-ink">{stuck}</span> {stuck === 1 ? 'precisa' : 'precisam'} de você
          </>
        )}
        .
      </p>
      {batch.note && <p className="mt-2 max-w-[70ch] text-sm text-soft">{batch.note}</p>}
      <p className="mt-2 max-w-[70ch] text-sm text-faint">
        Três músicas são baixadas ao mesmo tempo: quando uma termina, a próxima começa. Um download que falha é tentado de novo, até três vezes, antes de aparecer como falha. A lista fica
        guardada: dá para fechar o app e continuar depois.
        {batch.playlists.length > 0 && ` Conforme ficam prontas, entram na playlist “${batch.playlists.map((playlist) => playlist.name).join('”, “')}”, na tela da fila.`}
      </p>

      <ol className="mt-8">
        {batch.items.map((item, index) => {
          const working = BUSY.includes(item.status)
          return (
            <li key={item.key} className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-hairline py-3.5">
              <span className="numeric w-7 shrink-0 text-right text-sm text-faint">{index + 1}</span>
              <div className="min-w-0 flex-1 basis-56">
                <p className="truncate font-semibold">{item.title}</p>
                <p className="truncate text-sm text-soft">
                  {item.artist || 'Artista desconhecido'}
                  {item.duration > 0 && <span className="numeric ml-2 text-faint">{formatDuration(item.duration)}</span>}
                </p>
                <p className={cn('mt-1 text-[13px]', item.status === 'falhou' ? 'text-danger' : DONE.includes(item.status) ? 'text-accent-ink' : 'text-faint')}>
                  {DONE.includes(item.status) && <CheckIcon size={13} weight="bold" className="mr-1 inline align-[-1px]" />}
                  {statusText(item)}
                  {item.video && batch.source === 'spotify' && item.status === 'pendente' && <span className="text-soft"> Vídeo: {item.video.title}.</span>}
                </p>
              </div>
              <div className="ml-auto flex shrink-0 gap-2">
                {DONE.includes(item.status) && item.songId && (
                  <Button asChild size="sm" variant="ghost">
                    <Link to={`/musica/${item.songId}`}>Abrir</Link>
                  </Button>
                )}
                {/* A que falhou também pode trocar de vídeo: o da lista pode ter saído do ar. */}
                {(item.status === 'sem-video' || item.status === 'arquivo' || item.status === 'falhou' || (item.status === 'pendente' && batch.source === 'spotify')) && (
                  <Button size="sm" variant={item.status === 'pendente' ? 'ghost' : 'secondary'} disabled={busy} onClick={() => setChoosing(item.key)}>
                    <MagnifyingGlassIcon size={16} />
                    {item.video ? 'Trocar vídeo' : 'Escolher vídeo'}
                  </Button>
                )}
                {item.status === 'pendente' && (
                  <Button size="sm" disabled={busy} onClick={() => void downloadOne(item.key)}>
                    <DownloadSimpleIcon size={16} weight="bold" />
                    Baixar
                  </Button>
                )}
                {item.status === 'falhou' && (
                  <Button size="sm" disabled={busy} onClick={() => void downloadOne(item.key)}>
                    <ArrowsClockwiseIcon size={16} />
                    Tentar de novo
                  </Button>
                )}
                {working && <span className="skeleton h-9 w-28 rounded-full" aria-label="Em andamento" />}
              </div>
            </li>
          )
        })}
      </ol>

      {chosen && <VideoChooser item={chosen} onClose={() => setChoosing(null)} />}
      <Dialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Descartar esta lista?"
        description="As músicas que já foram baixadas continuam na biblioteca. Só a lista do que faltava é apagada."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              Manter
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                discard()
                setConfirming(false)
                toast('Lista descartada.')
              }}
            >
              Descartar
            </Button>
          </>
        }
      />
    </>
  )
}
