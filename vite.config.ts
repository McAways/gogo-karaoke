import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { helperPlugin } from './helper/plugin.ts'

// A porta é fixa de propósito: a biblioteca (OPFS + IndexedDB) pertence à origem
// http://localhost:5173. Em outra porta o navegador enxerga uma biblioteca vazia.
const PORT = 5173

export default defineConfig({
  plugins: [react(), tailwindcss(), helperPlugin()],
  resolve: { tsconfigPaths: true },
  server: { port: PORT, strictPort: true },
  preview: { port: PORT, strictPort: true },
  worker: { format: 'es' },
  build: {
    rolldownOptions: {
      output: {
        // Bibliotecas em arquivos próprios: mudam pouco e o navegador as mantém em cache.
        codeSplitting: {
          groups: [
            { name: 'react', test: /node_modules[\\/](react|react-dom|react-router|scheduler)[\\/]/ },
            { name: 'interface', test: /node_modules[\\/](motion|motion-dom|motion-utils|framer-motion|radix-ui|@radix-ui|@floating-ui|@phosphor-icons)[\\/]/ },
          ],
        },
      },
    },
  },
})
