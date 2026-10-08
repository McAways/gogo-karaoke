import { UploadSimpleIcon } from '@phosphor-icons/react'
import { useRef } from 'react'
import { Button } from './button'
import { cn } from './cn'

export const MEDIA_ACCEPT = 'audio/*,video/*,.mp3,.m4a,.aac,.ogg,.opus,.wav,.flac,.mp4,.m4v,.webm,.mov,.mkv'

/**
 * Convite para trazer arquivos do computador. Soltar funciona na janela inteira
 * (quem cuida disso é o shell), então aqui fica só o botão de escolher.
 */
export function DropZone({ onFiles, className, compact = false }: { onFiles: (files: File[]) => void; className?: string; compact?: boolean }) {
  const input = useRef<HTMLInputElement>(null)

  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center rounded-card border-2 border-dashed border-hairline bg-surface text-center',
        compact ? 'gap-4 px-6 py-10' : 'gap-5 px-8 py-16',
        className,
      )}
    >
      <span className="flex size-14 items-center justify-center rounded-full bg-raised text-soft">
        <UploadSimpleIcon size={26} />
      </span>
      <div>
        <p className="text-lg font-semibold">Arraste áudio ou vídeo para cá</p>
        <p className="mx-auto mt-1 max-w-[34ch] text-sm text-soft">MP3, M4A, WAV, FLAC, MP4 ou WEBM. Os arquivos ficam só neste navegador.</p>
      </div>
      <Button onClick={() => input.current?.click()}>Escolher arquivos</Button>
      <input
        ref={input}
        type="file"
        accept={MEDIA_ACCEPT}
        multiple
        hidden
        onChange={(event) => {
          const files = Array.from(event.target.files ?? [])
          if (files.length > 0) onFiles(files)
          event.target.value = ''
        }}
      />
    </div>
  )
}
