import { useEffect, useState } from 'react'
import { prepareExport } from '@/lib/export'
import type { PreparedExport } from '@/lib/export'
import { formatBytes } from '@/lib/format'
import { useExport } from '@/state/exporting'
import { useSettings } from '@/state/settings'
import type { ExportKind } from '@/state/settings'
import { toast } from '@/state/toasts'
import { Button } from './button'
import { cn } from './cn'
import { Dialog } from './overlay'

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

function Option({ value, selected, onSelect, title, size, children }: { value: ExportKind; selected: boolean; onSelect: (value: ExportKind) => void; title: string; size: string | null; children: string }) {
  return (
    <label className={cn('flex cursor-pointer gap-3.5 rounded-field border p-4 transition-colors duration-200', selected ? 'border-accent-ink bg-accent/10' : 'border-hairline hover:border-faint')}>
      <input type="radio" name="export-kind" value={value} checked={selected} onChange={() => onSelect(value)} className="mt-1 size-4 shrink-0 accent-accent-ink" />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-3">
          <span className="font-semibold">{title}</span>
          {size === null ? <span className="skeleton h-4 w-14 rounded-full" /> : <span className="numeric text-sm text-soft">{size}</span>}
        </span>
        <span className="mt-1 block text-sm text-soft">{children}</span>
      </span>
    </label>
  )
}

/**
 * Exportar para outro aparelho. Quem exporta escolhe: só a lista (o outro aparelho baixa de
 * novo) ou as músicas completas (chegam prontas). Fica no esqueleto da página; qualquer tela
 * abre com `askExport`.
 */
export function ExportDialog() {
  const request = useExport((state) => state.request)
  const close = useExport((state) => state.close)
  const kind = useSettings((state) => state.exportKind)
  const update = useSettings((state) => state.update)
  const [prepared, setPrepared] = useState<PreparedExport | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!request) return
    let live = true
    setPrepared(null)
    setFailed(false)
    prepareExport(request.name, request.songs, request.playlists).then(
      (result) => live && setPrepared(result),
      () => live && setFailed(true),
    )
    return () => {
      live = false
    }
  }, [request])

  const full = kind === 'completo'
  const nothingToPack = prepared !== null && prepared.pack.songs === 0

  const save = () => {
    if (!prepared) return
    if (full) {
      prepared.pack.save()
      const large = prepared.pack.bytes > 200 * 1024 * 1024
      toast(`Pacote com ${count(prepared.pack.songs, 'música', 'músicas')} (${formatBytes(prepared.pack.bytes)}) indo para a pasta de downloads.${large ? ' O navegador mostra o andamento.' : ''}`)
    } else {
      prepared.list.save()
      toast(`Lista com ${count(prepared.list.songs, 'música', 'músicas')} salva na pasta de downloads.`)
    }
    close()
  }

  return (
    <Dialog
      open={request !== null}
      onOpenChange={(open) => !open && close()}
      title="Exportar para outro aparelho"
      description={request ? `“${request.name}”: ${count(request.songs.length, 'música', 'músicas')}.` : undefined}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            Cancelar
          </Button>
          <Button variant="primary" disabled={!prepared || (full && nothingToPack)} onClick={save}>
            Exportar
          </Button>
        </>
      }
    >
      {failed ? (
        <p className="text-danger">Não foi possível preparar a exportação. Feche e tente de novo.</p>
      ) : (
        <>
          <fieldset className="space-y-2.5">
            <legend className="sr-only">O que levar</legend>
            <Option value="lista" selected={!full} onSelect={(exportKind) => update({ exportKind })} title="Só a lista" size={prepared ? formatBytes(prepared.list.bytes) : null}>
              Um arquivo pequeno com os links, as letras e as playlists. O outro aparelho baixa as músicas de novo e prepara cada uma.
            </Option>
            <Option value="completo" selected={full} onSelect={(exportKind) => update({ exportKind })} title="Músicas completas" size={prepared ? formatBytes(prepared.pack.bytes) : null}>
              Leva junto o áudio ou o vídeo, a letra como está, a voz separada e o guia de notas. No outro aparelho é só abrir: entra tudo pronto para cantar, sem baixar nem esperar.
            </Option>
          </fieldset>

          {prepared && !full && prepared.fromFiles > 0 && (
            <p className="mt-4 text-[13px] text-soft">
              {prepared.fromFiles === 1 ? 'Uma destas músicas veio' : `${prepared.fromFiles} destas músicas vieram`} de arquivo do computador: na lista não há de onde baixar de novo. Em “Músicas
              completas” {prepared.fromFiles === 1 ? 'ela vai' : 'elas vão'} junto.
            </p>
          )}
          {prepared && full && prepared.missing > 0 && (
            <p className="mt-4 text-[13px] text-soft">
              {prepared.missing === 1 ? 'Uma música fica de fora: o arquivo dela' : `${prepared.missing} músicas ficam de fora: o arquivo delas`} não está mais neste navegador.
            </p>
          )}
          {full && <p className="mt-4 text-[13px] text-faint">O pacote contém as músicas em si: é para levar entre os seus aparelhos.</p>}
          {request && request.playlists.length > 1 && <p className="mt-2 text-[13px] text-faint">Nos dois casos, as playlists e os álbuns vão junto.</p>}
        </>
      )}
    </Dialog>
  )
}
