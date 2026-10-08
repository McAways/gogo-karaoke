// Uso: npm run ytdlp:update
import { findYtDlp, updateYtDlp } from './binary.ts'

const before = await findYtDlp()
console.log(before ? `yt-dlp atual: ${before.version} (${before.source})` : 'yt-dlp ainda não instalado.')

try {
  const after = await updateYtDlp()
  console.log(`yt-dlp pronto: ${after.version} em ${after.path}`)
} catch (err) {
  console.error(err instanceof Error ? err.message : err)
  process.exitCode = 1
}
