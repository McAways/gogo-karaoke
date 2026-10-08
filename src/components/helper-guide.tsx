import { ArrowsClockwiseIcon, CopyIcon } from '@phosphor-icons/react'
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router'
import { appOrigin, forgetHelper, helperPresence, isPublishedApp } from '@/lib/helper'
import type { HelperPresence } from '@/lib/helper'
import { toast } from '@/state/toasts'
import { Button } from './button'
import { cn } from './cn'

/** Onde está o ajudante, visto desta página. `retry` procura de novo, depois de instalar ou iniciar. */
export function useHelperPresence(): { presence: HelperPresence | 'verificando'; retry: () => void } {
  const [presence, setPresence] = useState<HelperPresence | 'verificando'>('verificando')
  const [round, setRound] = useState(0)

  useEffect(() => {
    let live = true
    setPresence('verificando')
    void helperPresence().then((found) => live && setPresence(found))
    return () => {
      live = false
    }
  }, [round])

  const retry = useCallback(() => {
    forgetHelper()
    setRound((value) => value + 1)
  }, [])
  return { presence, retry }
}

/** O comando que autoriza este endereço no ajudante instalado. */
export function allowCommand(): string {
  return `permitir ${appOrigin()}`
}

async function copyCommand(): Promise<void> {
  try {
    await navigator.clipboard.writeText(allowCommand())
    toast('Comando copiado.')
  } catch {
    toast('Não deu para copiar. Selecione o texto e copie à mão.', 'erro')
  }
}

/**
 * Explica o que falta quando uma função depende do ajudante e ele não atendeu.
 * `what` completa a frase "... precisa do ajudante".
 */
export function HelperMissing({ what, presence, onRetry, className }: { what: string; presence: 'ausente' | 'sem-permissao'; onRetry: () => void; className?: string }) {
  const published = isPublishedApp()

  return (
    <div className={cn('rounded-card border border-hairline bg-surface p-6', className)}>
      {presence === 'sem-permissao' ? (
        <>
          <p className="font-semibold">O ajudante deste computador ainda não confia neste endereço.</p>
          <p className="mt-2 text-sm text-soft">Ele está no ar, mas só atende os endereços que você autorizou. Na pasta do ajudante, abra o arquivo “permitir” e informe o endereço deste app, ou rode:</p>
          <code className="numeric mt-3 block overflow-x-auto rounded-field bg-raised px-3 py-2 text-[13px] whitespace-nowrap text-ink">{allowCommand()}</code>
        </>
      ) : published ? (
        <>
          <p className="font-semibold">{what} precisa do ajudante instalado neste computador.</p>
          <p className="mt-2 text-sm text-soft">
            É um programa que roda aqui na máquina e faz o que o navegador não consegue: baixar do YouTube, separar a voz e medir a letra no áudio. Se ele já está instalado, abra o arquivo
            “iniciar” na pasta dele. Se o navegador perguntar se este site pode acessar a rede local, permita: é assim que o site fala com o ajudante.
          </p>
          <p className="mt-2 text-sm text-soft">Sem ele o app continua servindo para cantar: arquivos do computador e pacotes de músicas completas funcionam.</p>
        </>
      ) : (
        <>
          <p className="font-semibold">{what} precisa do ajudante local.</p>
          <p className="mt-2 text-sm text-soft">
            Ele faz parte deste projeto e sobe junto com o app. Na pasta do projeto, rode <code className="numeric text-ink">npm run dev</code> e abra{' '}
            <code className="numeric text-ink">http://localhost:5173</code>. Arquivos do computador funcionam mesmo sem ele.
          </p>
        </>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        <Button size="sm" onClick={onRetry}>
          <ArrowsClockwiseIcon size={16} />
          Procurar de novo
        </Button>
        {presence === 'sem-permissao' && (
          <Button size="sm" variant="ghost" onClick={() => void copyCommand()}>
            <CopyIcon size={16} />
            Copiar comando
          </Button>
        )}
        {presence === 'ausente' && published && (
          <Button asChild size="sm" variant="ghost">
            <Link to="/ajustes#ajudante">Como instalar</Link>
          </Button>
        )}
      </div>
    </div>
  )
}
