import { MotionConfig } from 'motion/react'
import { useEffect } from 'react'
import { BrowserRouter, Link, Route, Routes } from 'react-router'
import { Button, TooltipProvider } from '@/components/button'
import { Toaster } from '@/components/toaster'
import { AddPage } from '@/features/add/add-page'
import { ListPage } from '@/features/add/list-page'
import { LyricsEditorPage } from '@/features/editor/lyrics-editor-page'
import { CollectionPage } from '@/features/library/collection-page'
import { LibraryPage } from '@/features/library/library-page'
import { PartyPage } from '@/features/party/party-page'
import { QueuePage } from '@/features/queue/queue-page'
import { ResultPage } from '@/features/result/result-page'
import { SettingsPage } from '@/features/settings/settings-page'
import { SongPage } from '@/features/song/song-page'
import { StagePage } from '@/features/stage/stage-page'
import { resumePendingAnalyses } from '@/lib/importer'
import { requestPersistence, storageSupported } from '@/lib/storage/files'
import { useLibrary } from '@/state/library'
import { useParty } from '@/state/party'
import { resolveTheme, useSettings } from '@/state/settings'
import { Shell } from './shell'

/** Mantém o atributo data-theme do <html> igual à escolha do usuário (ou do sistema). */
function useThemeSync(): void {
  const theme = useSettings((state) => state.theme)

  useEffect(() => {
    const apply = () => {
      document.documentElement.dataset.theme = resolveTheme(theme)
    }
    apply()
    if (theme !== 'system') return
    const media = window.matchMedia('(prefers-color-scheme: light)')
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [theme])
}

function NotFound() {
  return (
    <section className="flex min-h-[60dvh] flex-col items-start justify-center">
      <h1 className="display text-4xl md:text-5xl">Essa página não existe.</h1>
      <p className="mt-4 text-lg text-soft">O endereço pode ter mudado ou a música foi excluída.</p>
      <Button asChild variant="primary" className="mt-7">
        <Link to="/">Ir para a biblioteca</Link>
      </Button>
    </section>
  )
}

export function App() {
  useThemeSync()

  useEffect(() => {
    if (!storageSupported()) return
    void useLibrary
      .getState()
      .load()
      .then(resumePendingAnalyses)
    // Pede ao navegador para não apagar a biblioteca quando o disco apertar.
    void requestPersistence().catch(() => false)
    // Página recarregada com a sala aberta: os convidados continuam lá, é só reconectar.
    void useParty.getState().resume()
  }, [])

  return (
    <MotionConfig reducedMotion="user">
      <TooltipProvider delayDuration={350}>
        <BrowserRouter>
          <Routes>
            <Route element={<Shell />}>
              <Route index element={<LibraryPage />} />
              <Route path="colecao/:id" element={<CollectionPage />} />
              <Route path="fila" element={<QueuePage />} />
              <Route path="sala" element={<PartyPage />} />
              <Route path="adicionar" element={<AddPage />} />
              <Route path="adicionar/lista" element={<ListPage />} />
              <Route path="musica/:id" element={<SongPage />} />
              <Route path="musica/:id/letra" element={<LyricsEditorPage />} />
              <Route path="resultado/:scoreId" element={<ResultPage />} />
              <Route path="ajustes" element={<SettingsPage />} />
              <Route path="*" element={<NotFound />} />
            </Route>
            {/* O palco ocupa a tela toda, fora da moldura do app. */}
            <Route path="cantar/:id" element={<StagePage />} />
          </Routes>
        </BrowserRouter>
        <Toaster />
      </TooltipProvider>
    </MotionConfig>
  )
}
