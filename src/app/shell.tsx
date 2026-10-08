import { BooksIcon, ExportIcon, GearSixIcon, PlusIcon, QueueIcon, UploadSimpleIcon, UsersThreeIcon } from '@phosphor-icons/react'
import { motion } from 'motion/react'
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Link, NavLink, Outlet, useLocation } from 'react-router'
import { Button, Tooltip } from '@/components/button'
import { cn } from '@/components/cn'
import { ExportDialog } from '@/components/export-dialog'
import { ImportTray } from '@/components/import-tray'
import { useBatch } from '@/state/batch'
import { askExport } from '@/state/exporting'
import { importFiles } from '@/state/jobs'
import { useLibrary } from '@/state/library'
import { useParty } from '@/state/party'
import { useQueue } from '@/state/queue'

/** Soltar arquivos em qualquer ponto da janela importa a música. */
function useWindowDrop(): boolean {
  const [dragging, setDragging] = useState(false)

  useEffect(() => {
    let depth = 0
    const hasFiles = (event: DragEvent) => event.dataTransfer?.types.includes('Files') ?? false

    const onEnter = (event: DragEvent) => {
      if (!hasFiles(event)) return
      depth++
      setDragging(true)
    }
    const onLeave = (event: DragEvent) => {
      if (!hasFiles(event)) return
      depth = Math.max(0, depth - 1)
      if (depth === 0) setDragging(false)
    }
    const onOver = (event: DragEvent) => {
      if (hasFiles(event)) event.preventDefault()
    }
    const onDrop = (event: DragEvent) => {
      if (!hasFiles(event)) return
      event.preventDefault()
      depth = 0
      setDragging(false)
      const files = Array.from(event.dataTransfer?.files ?? [])
      if (files.length > 0) importFiles(files)
    }

    window.addEventListener('dragenter', onEnter)
    window.addEventListener('dragleave', onLeave)
    window.addEventListener('dragover', onOver)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onEnter)
      window.removeEventListener('dragleave', onLeave)
      window.removeEventListener('dragover', onOver)
      window.removeEventListener('drop', onDrop)
    }
  }, [])

  return dragging
}

function TopLink({ to, children, className }: { to: string; children: ReactNode; className?: string }) {
  return (
    <NavLink
      to={to}
      end={to === '/'}
      className={({ isActive }) =>
        cn('relative rounded-full px-4 py-2 text-sm font-semibold transition-colors duration-200', isActive ? 'text-ink' : 'text-soft hover:text-ink', className)
      }
    >
      {({ isActive }) => (
        <>
          {isActive && <motion.span layoutId="top-nav" className="absolute inset-0 rounded-full bg-ink/8" transition={{ type: 'spring', stiffness: 480, damping: 40 }} />}
          <span className="relative">{children}</span>
        </>
      )}
    </NavLink>
  )
}

function BottomLink({ to, icon, children }: { to: string; icon: ReactNode; children: ReactNode }) {
  return (
    <NavLink
      to={to}
      end={to === '/'}
      className={({ isActive }) => cn('flex flex-1 flex-col items-center gap-1 py-2.5 text-[11px] font-semibold', isActive ? 'text-ink' : 'text-faint')}
    >
      {icon}
      {children}
    </NavLink>
  )
}

export function Shell() {
  const location = useLocation()
  const dragging = useWindowDrop()
  const queued = useQueue((state) => state.items.length)
  const roomOpen = useParty((state) => state.status === 'aberta')
  const inRoom = useParty((state) => state.guests.length)
  const hasSongs = useLibrary((state) => state.songs.length > 0)
  // Músicas da lista em andamento (arquivo exportado ou link do Spotify) que ainda não estão na biblioteca.
  const toDownload = useBatch((state) => state.batch?.items.filter((item) => item.status !== 'pronta' && item.status !== 'na-biblioteca').length ?? 0)
  const onAddPage = location.pathname === '/adicionar'

  useEffect(() => {
    // A lista em andamento fica guardada no navegador: é lida aqui para o menu saber dela em qualquer tela.
    void useBatch.getState().load()
  }, [])

  return (
    <div className="min-h-[100dvh]">
      <header className="sticky top-0 z-10 border-b border-hairline/60 bg-canvas/85 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-[1400px] items-center gap-6 px-5 md:px-10">
          <Link to="/" className="display text-[22px]" aria-label="Gogó, ir para a biblioteca">
            Gogó
          </Link>
          <nav aria-label="Principal" className="hidden items-center gap-1 md:flex">
            <TopLink to="/">Biblioteca</TopLink>
            <TopLink to="/fila">
              Fila
              {queued > 0 && <span className="numeric ml-1.5 text-faint">{queued}</span>}
            </TopLink>
            <TopLink to="/sala">
              Sala
              {roomOpen && <span className="numeric ml-1.5 text-accent-ink">{inRoom}</span>}
            </TopLink>
            <TopLink to="/ajustes">Ajustes</TopLink>
            {/* Em tela estreita não cabe: a tela de adicionar música mostra o mesmo atalho. */}
            {toDownload > 0 && (
              <TopLink to="/adicionar/lista" className="hidden lg:block">
                Para baixar
                <span className="numeric ml-1.5 text-accent-ink">{toDownload}</span>
              </TopLink>
            )}
          </nav>
          {/* No celular a barra inferior já leva a "Adicionar", e a biblioteca tem o seu "Exportar". */}
          <div className="ml-auto hidden items-center gap-2 md:flex">
            {hasSongs && (
              // Só em tela larga: abaixo disso não cabe ao lado do menu, e o botão fica na biblioteca.
              // O "hidden" vai num elemento em volta porque no botão ele perde para o "inline-flex" da base.
              <div className="hidden lg:block">
                <Tooltip label="Leva a biblioteca para outro aparelho: só a lista, ou as músicas completas" side="bottom">
                  <Button variant="ghost" size="sm" onClick={() => askExport('Minha biblioteca', useLibrary.getState().songs, useQueue.getState().playlists)}>
                    <ExportIcon size={16} weight="bold" />
                    Exportar
                  </Button>
                </Tooltip>
              </div>
            )}
            {!onAddPage && (
              <Button asChild variant="primary" size="sm">
                <Link to="/adicionar">
                  <PlusIcon size={16} weight="bold" />
                  Adicionar música
                </Link>
              </Button>
            )}
          </div>
        </div>
      </header>

      <motion.main
        key={location.pathname}
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
        className="mx-auto max-w-[1400px] px-5 pt-8 pb-36 md:px-10 md:pt-12 md:pb-24"
      >
        <Outlet />
      </motion.main>

      <nav aria-label="Principal" className="fixed inset-x-0 bottom-0 z-10 flex border-t border-hairline bg-canvas/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-md md:hidden">
        <BottomLink to="/" icon={<BooksIcon size={22} />}>
          Biblioteca
        </BottomLink>
        <BottomLink to="/fila" icon={<QueueIcon size={22} />}>
          {queued > 0 ? `Fila (${queued})` : 'Fila'}
        </BottomLink>
        <BottomLink to="/sala" icon={<UsersThreeIcon size={22} />}>
          {roomOpen ? `Sala (${inRoom})` : 'Sala'}
        </BottomLink>
        <BottomLink to="/adicionar" icon={<PlusIcon size={22} />}>
          Adicionar
        </BottomLink>
        <BottomLink to="/ajustes" icon={<GearSixIcon size={22} />}>
          Ajustes
        </BottomLink>
      </nav>

      <ImportTray />
      <ExportDialog />

      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center bg-canvas/90 p-6 animate-fade-in">
          <div className="flex h-full w-full flex-col items-center justify-center gap-4 rounded-card border-2 border-dashed border-accent-ink">
            <UploadSimpleIcon size={44} className="text-accent-ink" />
            <p className="display text-3xl md:text-5xl">Solte para importar</p>
          </div>
        </div>
      )}
    </div>
  )
}
