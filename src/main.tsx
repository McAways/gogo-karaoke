import '@fontsource-variable/mona-sans/wdth.css'
import '@fontsource-variable/geist-mono/wght.css'
import './styles.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app/app'
import { useLibrary } from './state/library'

if (import.meta.env.DEV) {
  // Porta de entrada do teste de ponta a ponta (scripts/e2e.ts) para o estado do app.
  // Importar o módulo pelo endereço não serve: depois de uma edição, o servidor de
  // desenvolvimento passa a servi-lo com outro endereço e o teste pegaria uma cópia vazia.
  ;(window as unknown as { __gogo: { useLibrary: typeof useLibrary } }).__gogo = { useLibrary }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
