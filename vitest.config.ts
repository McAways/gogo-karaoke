import { defineConfig } from 'vitest/config'

// Os testes cobrem só lógica (letras, pontuação, análise de áudio, a fila de downloads e as
// novas tentativas do ajudante), então não carregam os plugins do app.
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'helper/**/*.test.ts'],
  },
})
