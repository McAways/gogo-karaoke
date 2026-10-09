import { ArrowsClockwiseIcon, CopyIcon, DownloadSimpleIcon } from '@phosphor-icons/react'
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router'
import { saveAs } from '@/lib/export'
import { formatBytes } from '@/lib/format'
import { HELPER_PACKAGE_FILE, appOrigin, forgetHelper, helperPackage, helperPackageFile, helperPresence, isPublishedApp } from '@/lib/helper'
import type { HelperPackage, HelperPresence } from '@/lib/helper'
import { toast } from '@/state/toasts'
import { Button } from './button'
import { cn } from './cn'
import { Segmented } from './form'

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

async function copyCommand(command = allowCommand()): Promise<void> {
  try {
    await navigator.clipboard.writeText(command)
    toast('Comando copiado.')
  } catch {
    toast('Não deu para copiar. Selecione o texto e copie à mão.', 'erro')
  }
}

/** O pacote do ajudante que este endereço oferece. undefined = ainda perguntando; null = não oferece. */
export function useHelperPackage(): HelperPackage | null | undefined {
  const [pack, setPack] = useState<HelperPackage | null | undefined>(undefined)
  useEffect(() => {
    let live = true
    void helperPackage().then((found) => live && setPack(found))
    return () => {
      live = false
    }
  }, [])
  return pack
}

/** Baixa o pacote do ajudante oferecido por este endereço. Não aparece quando o app foi publicado sem ele. */
export function HelperDownload({ size = 'md', variant = 'primary' }: { size?: 'sm' | 'md'; variant?: 'primary' | 'secondary' }) {
  const pack = useHelperPackage()
  const [busy, setBusy] = useState(false)
  if (!pack) return null

  const download = async () => {
    setBusy(true)
    try {
      saveAs(await helperPackageFile(), HELPER_PACKAGE_FILE)
      toast('Ajudante baixado. Extraia o zip e abra o arquivo “instalar”.')
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Não deu para baixar o ajudante.', 'erro')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Button size={size} variant={variant} disabled={busy} onClick={() => void download()}>
      <DownloadSimpleIcon size={16} weight="bold" />
      Baixar o ajudante
    </Button>
  )
}

type System = 'windows' | 'mac'

const detectSystem = (): System => (typeof navigator !== 'undefined' && /win/i.test(navigator.platform || navigator.userAgent) ? 'windows' : 'mac')

/**
 * Passo a passo para instalar o ajudante nesta máquina com o pacote que este endereço oferece.
 * `updating` troca o começo: o ajudante já existe aqui e só precisa do pacote novo por cima.
 */
export function HelperInstallGuide({ updating = false }: { updating?: boolean }) {
  const pack = useHelperPackage()
  const [system, setSystem] = useState<System>(detectSystem)
  const origin = appOrigin()
  // Baixado pelo Terminal, o pacote não leva a marca de "veio da internet" que faz o macOS barrar o instalador.
  const terminal = `curl -fsSL "${origin}/${HELPER_PACKAGE_FILE}" -o /tmp/${HELPER_PACKAGE_FILE} && unzip -oq /tmp/${HELPER_PACKAGE_FILE} -d "$HOME" && sh "$HOME/gogo-ajudante/instalar.command" --site=${origin}`
  const file = (name: string) => <code className="numeric text-ink">{name}</code>

  if (pack === undefined) return null
  if (pack === null) {
    return (
      <div>
        <p className="font-semibold">Como instalar nesta máquina</p>
        <ol className="mt-2 max-w-[62ch] list-decimal space-y-2 pl-5 text-sm text-soft">
          <li>
            No computador principal, na pasta do projeto, rode {file('npm run helper:pack')}. Ele gera a pasta {file('gogo-ajudante')}.
          </li>
          <li>
            Traga essa pasta para cá e abra o arquivo {file('instalar')} (no Mac, {file('instalar.command')}). Ele baixa sozinho o que a máquina não tiver, inclusive o Node e o ffmpeg, e pergunta o
            endereço deste app: {file(origin)}
          </li>
          <li>Daí em diante, o arquivo {file('iniciar')} sobe o ajudante. A instalação oferece subir junto com o Windows.</li>
        </ol>
      </div>
    )
  }

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-x-8 gap-y-3">
        <p className="font-semibold">{updating ? 'Como atualizar nesta máquina' : 'Como instalar nesta máquina'}</p>
        <Segmented
          label="Sistema deste computador"
          value={system}
          onChange={setSystem}
          options={[
            { value: 'windows', label: 'Windows' },
            { value: 'mac', label: 'Mac' },
          ]}
        />
      </div>
      <ol className="mt-3 max-w-[62ch] list-decimal space-y-3 pl-5 text-sm text-soft">
        <li>
          <p>
            Baixe o ajudante ({formatBytes(pack.bytes)}). {updating && 'Antes de continuar, feche a janela do ajudante que está aberta.'}
          </p>
          <div className="mt-2">
            <HelperDownload size="sm" />
          </div>
        </li>
        {system === 'windows' ? (
          <li>
            Extraia o zip (botão direito, “Extrair tudo”){updating && ', por cima da pasta antiga,'} e abra o arquivo {file('instalar')}. Se aparecer “O Windows protegeu o computador”, clique em “Mais
            informações” e em “Executar assim mesmo”.
          </li>
        ) : (
          <li>
            <p>
              Abra o zip{updating && ', leve o conteúdo para cima da pasta antiga'} e, na pasta {file('gogo-ajudante')}, abra {file('instalar.command')}. Se o macOS disser que não pode abrir, vá em Ajustes do
              Sistema, Privacidade e Segurança, e clique em “Abrir Mesmo Assim”.
            </p>
            <p className="mt-2">Ou, no lugar dos passos 1 e 2, cole isto no Terminal. Ele baixa o ajudante para a sua pasta pessoal e abre o instalador:</p>
            <code className="numeric mt-2 block overflow-x-auto rounded-field bg-raised px-3 py-2 text-[13px] whitespace-nowrap text-ink">{terminal}</code>
            <Button size="sm" variant="ghost" className="mt-1.5 -ml-2" onClick={() => void copyCommand(terminal)}>
              <CopyIcon size={16} />
              Copiar comando
            </Button>
          </li>
        )}
        <li>
          O instalador baixa sozinho o que a máquina não tiver (o Node, o ffmpeg e o downloader) e já autoriza este endereço. Quando terminar, abra {file(system === 'windows' ? 'iniciar' : 'iniciar.command')},
          deixe a janela aberta e clique em “Procurar de novo”.
        </li>
      </ol>
    </div>
  )
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
          <>
            <HelperDownload size="sm" />
            <Button asChild size="sm" variant="ghost">
              <Link to="/ajustes#ajudante">Como instalar</Link>
            </Button>
          </>
        )}
      </div>
    </div>
  )
}
