import { DesktopIcon, FilmStripIcon, HeadphonesIcon, MoonIcon, MusicNotesIcon, SpeakerHighIcon, SunIcon } from '@phosphor-icons/react'
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@/components/button'
import { Segmented, Slider, Switch } from '@/components/form'
import { allowCommand, useHelperPresence } from '@/components/helper-guide'
import { formatBytes } from '@/lib/format'
import { appOrigin, forgetHelperStatus, helperStatus, installAligner, installSeparator, isPublishedApp, updateDownloader } from '@/lib/helper'
import type { HelperStatus } from '@/lib/helper'
import { requestPersistence, storageInfo } from '@/lib/storage/files'
import type { StorageInfo } from '@/lib/storage/files'
import { askExport } from '@/state/exporting'
import { useLibrary } from '@/state/library'
import { useQueue } from '@/state/queue'
import { songsToResync, useResync } from '@/state/resync'
import { useSettings } from '@/state/settings'
import { toast } from '@/state/toasts'

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="grid gap-x-12 gap-y-5 border-t border-hairline py-9 md:grid-cols-[220px_minmax(0,1fr)]">
      <h2 className="display text-xl">{title}</h2>
      <div className="flex flex-col gap-8">{children}</div>
    </section>
  )
}

function Row({ label, hint, children, htmlFor }: { label: string; hint?: string; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-8 gap-y-3">
      <div className="max-w-[46ch] min-w-0">
        {htmlFor ? (
          <label htmlFor={htmlFor} className="font-semibold">
            {label}
          </label>
        ) : (
          <p className="font-semibold">{label}</p>
        )}
        {hint && <p className="mt-0.5 text-sm text-soft">{hint}</p>}
      </div>
      {children}
    </div>
  )
}

export function SettingsPage() {
  const settings = useSettings()
  const songCount = useLibrary((state) => state.songs.length)

  const [helper, setHelper] = useState<HelperStatus | null | 'checking'>('checking')
  const [updating, setUpdating] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [installingSync, setInstallingSync] = useState(false)
  const resync = useResync()
  /** Quantas músicas ainda estão com a sincronia original. null = contando. */
  const [toResync, setToResync] = useState<number | null>(null)
  const [storage, setStorage] = useState<StorageInfo | null>(null)
  const { presence, retry } = useHelperPresence()
  const published = isPublishedApp()

  useEffect(() => {
    void helperStatus().then(setHelper)
    void storageInfo().then(setStorage, () => setStorage(null))
  }, [])

  const findHelper = () => {
    retry()
    setHelper('checking')
    void helperStatus().then(setHelper)
  }

  // Conta de novo quando a biblioteca muda e a cada música que a sincronia em lote termina.
  useEffect(() => {
    let alive = true
    void songsToResync().then((songs) => alive && setToResync(songs.length))
    return () => {
      alive = false
    }
  }, [songCount, resync.done, resync.running])

  const update = async () => {
    setUpdating(true)
    try {
      const next = await updateDownloader()
      setHelper(next)
      toast(`Downloader atualizado para a versão ${next.ytDlp?.version ?? 'mais recente'}.`)
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Não foi possível atualizar o downloader.', 'erro')
    } finally {
      setUpdating(false)
    }
  }

  const installVoiceSeparator = async () => {
    setInstalling(true)
    try {
      setHelper(await installSeparator())
      forgetHelperStatus()
      toast('Separador de voz instalado.')
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Não foi possível instalar o separador.', 'erro')
    } finally {
      setInstalling(false)
    }
  }

  const installAudioSync = async () => {
    setInstallingSync(true)
    try {
      setHelper(await installAligner())
      forgetHelperStatus()
      toast('Sincronia pelo áudio instalada.')
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Não foi possível instalar a sincronia pelo áudio.', 'erro')
    } finally {
      setInstallingSync(false)
    }
  }

  const protect = async () => {
    const granted = await requestPersistence().catch(() => false)
    setStorage(await storageInfo())
    toast(granted ? 'Biblioteca protegida contra limpeza automática.' : 'O navegador não concedeu a proteção agora. Usar o app com frequência costuma liberar.', granted ? 'ok' : 'erro')
  }

  return (
    <>
      <h1 className="display text-4xl md:text-5xl">Ajustes</h1>

      <div className="mt-10 max-w-[980px]">
        <Group title="Aparência">
          <Row label="Tema" hint="O palco fica sempre escuro, para a letra aparecer bem sobre o vídeo.">
            <Segmented
              label="Tema"
              value={settings.theme}
              onChange={(theme) => settings.update({ theme })}
              options={[
                { value: 'system', label: 'Sistema', icon: <DesktopIcon size={15} weight="fill" /> },
                { value: 'light', label: 'Claro', icon: <SunIcon size={15} weight="fill" /> },
                { value: 'dark', label: 'Escuro', icon: <MoonIcon size={15} weight="fill" /> },
              ]}
            />
          </Row>
        </Group>

        <Group title="Cantar">
          <Row label="Dificuldade" hint="Define quanto o tom pode fugir da nota e quanto você pode adiantar ou atrasar.">
            <Segmented
              label="Dificuldade"
              value={settings.difficulty}
              onChange={(difficulty) => settings.update({ difficulty })}
              options={[
                { value: 'facil', label: 'Fácil' },
                { value: 'normal', label: 'Normal' },
                { value: 'dificil', label: 'Difícil' },
              ]}
            />
          </Row>
          <Row label="Você ouve a música por" hint="Com caixas de som, o navegador tira do microfone a música que vaza. Com fones isso fica desligado e a leitura do tom é mais fiel.">
            <Segmented
              label="Saída de som"
              value={settings.listenMode}
              onChange={(listenMode) => settings.update({ listenMode })}
              options={[
                { value: 'caixas', label: 'Caixas de som', icon: <SpeakerHighIcon size={15} weight="fill" /> },
                { value: 'fones', label: 'Fones', icon: <HeadphonesIcon size={15} weight="fill" /> },
              ]}
            />
          </Row>
          <Row label="Atraso do microfone" hint="Tempo entre o som sair e a sua voz chegar ao app. Aumente se usar caixa ou fone Bluetooth.">
            <div className="flex w-full max-w-72 items-center gap-4">
              <Slider label="Atraso do microfone em milissegundos" value={settings.latencyMs} min={0} max={400} step={10} onChange={(latencyMs) => settings.update({ latencyMs })} />
              <span className="numeric w-16 text-right">{settings.latencyMs} ms</span>
            </div>
          </Row>
          <Row label="Pista de tom" hint="As barras que mostram a melodia e onde a sua voz está." htmlFor="show-lane">
            <Switch id="show-lane" label="Mostrar a pista de tom" checked={settings.showLane} onChange={(showLane) => settings.update({ showLane })} />
          </Row>
        </Group>

        <Group title="Ajudante">
          <div id="ajudante" className="scroll-mt-24">
            <Row
              label={
                presence === 'verificando'
                  ? 'Procurando o ajudante'
                  : presence === 'ok'
                    ? published
                      ? 'No ar neste computador'
                      : 'No ar, junto com o app'
                    : presence === 'sem-permissao'
                      ? 'Instalado, mas não atende este endereço'
                      : 'Não encontrado neste computador'
              }
              hint={
                presence === 'verificando'
                  ? 'Se o navegador perguntar se este site pode acessar a rede local, permita: é assim que ele fala com o ajudante.'
                  : presence === 'ok'
                    ? `É o programa que baixa do YouTube, separa a voz, mede a letra no áudio e abre a sala. ${published ? 'Aqui ele está instalado à parte, só nesta máquina.' : 'Aqui ele sobe junto com o app.'}`
                    : presence === 'sem-permissao'
                      ? `Ele só atende os endereços que você autorizou. Na pasta do ajudante, abra “permitir” e informe ${appOrigin()}, ou rode: ${allowCommand()}`
                      : published
                        ? 'Sem ele o app serve para cantar: arquivos do computador e pacotes de músicas completas. Para baixar e preparar músicas nesta máquina, instale o ajudante.'
                        : 'Abra o app com “npm run dev” na pasta do projeto.'
              }
            >
              {presence !== 'ok' && presence !== 'verificando' && <Button onClick={findHelper}>Procurar de novo</Button>}
            </Row>
          </div>
          {published && presence !== 'ok' && presence !== 'verificando' && (
            <div>
              <p className="font-semibold">Como instalar nesta máquina</p>
              <ol className="mt-2 max-w-[62ch] list-decimal space-y-2 pl-5 text-sm text-soft">
                <li>
                  No computador principal, na pasta do projeto, rode <code className="numeric text-ink">npm run helper:pack</code>. Ele gera a pasta{' '}
                  <code className="numeric text-ink">gogo-ajudante</code>.
                </li>
                <li>
                  Traga essa pasta para cá e abra o arquivo <code className="numeric text-ink">instalar</code>. Ele confere o Node e o ffmpeg, baixa o que falta e pergunta o endereço deste app:{' '}
                  <code className="numeric text-ink">{appOrigin()}</code>
                </li>
                <li>
                  Daí em diante, o arquivo <code className="numeric text-ink">iniciar</code> sobe o ajudante. A instalação oferece subir junto com o Windows.
                </li>
              </ol>
            </div>
          )}
        </Group>

        <Group title="Voz original">
          <Row
            label="Separador de voz"
            hint={
              helper === 'checking'
                ? 'Verificando o ajudante.'
                : helper === null
                  ? 'Precisa do ajudante deste computador. Veja “Ajudante”, acima.'
                  : helper.separator?.installed
                    ? 'Instalado. Separa cada música em voz e instrumental em alguns segundos.'
                    : 'Baixa um motor de cerca de 60 MB para a pasta do projeto. Com ele dá para tirar a voz original, e o guia de notas e a letra ficam mais precisos.'
            }
          >
            {helper !== 'checking' && helper !== null && !helper.separator?.installed && (
              <Button disabled={installing || !helper.ffmpeg} onClick={() => void installVoiceSeparator()}>
                {installing ? 'Instalando' : 'Instalar'}
              </Button>
            )}
          </Row>
          <Row label="Separar ao adicionar" hint="Cada música nova passa pelo separador antes de ficar pronta. Desligado, dá para separar uma a uma na página da música." htmlFor="separate-on-import">
            <Switch id="separate-on-import" label="Separar a voz ao adicionar músicas" checked={settings.separateOnImport} onChange={(separateOnImport) => settings.update({ separateOnImport })} />
          </Row>
          <Row label="Volume da voz original" hint="Quanto do cantor da gravação fica no palco. No zero toca só o instrumental. Também dá para mudar durante a música.">
            <div className="flex w-full max-w-72 items-center gap-4">
              <Slider label="Volume da voz original" value={settings.vocalLevel} onChange={(vocalLevel) => settings.update({ vocalLevel })} />
              <span className="numeric w-16 text-right">{Math.round(settings.vocalLevel * 100)}%</span>
            </div>
          </Row>
        </Group>

        <Group title="Letra">
          <Row
            label="Sincronia pelo áudio"
            hint={
              helper === 'checking'
                ? 'Verificando o ajudante.'
                : helper === null
                  ? 'Precisa do ajudante deste computador. Veja “Ajudante”, acima.'
                  : helper.aligner?.installed
                    ? 'Instalada. Mede na voz de cada gravação o instante de cada palavra, em vez de confiar na sincronia feita para outra versão da música.'
                    : 'Baixa cerca de 300 MB para a pasta do projeto. Com isso a letra acompanha a voz de cada gravação, palavra por palavra, mesmo quando o vídeo tem pausas que a letra original não tem.'
            }
          >
            {helper !== 'checking' && helper !== null && !helper.aligner?.installed && (
              <Button disabled={installingSync || !helper.ffmpeg} onClick={() => void installAudioSync()}>
                {installingSync ? 'Instalando' : 'Instalar'}
              </Button>
            )}
          </Row>
          <Row
            label="Medir quando a letra vier sem sincronia"
            hint="Se a música só tiver a letra em texto, o app mede os tempos no áudio depois de separar a voz (perto de um minuto a mais). Letra que já vem sincronizada fica como veio: aí a medição só acontece quando você pede, no botão abaixo ou na página da música."
            htmlFor="align-when-unsynced"
          >
            <Switch
              id="align-when-unsynced"
              label="Medir a letra no áudio quando ela vier sem sincronia"
              checked={settings.alignWhenUnsynced}
              onChange={(alignWhenUnsynced) => settings.update({ alignWhenUnsynced })}
            />
          </Row>
          {helper !== 'checking' && helper?.aligner?.installed && (
            <Row
              label="Músicas que já estão na biblioteca"
              hint={
                resync.running
                  ? `Sincronizando ${Math.min(resync.done + 1, resync.total)} de ${resync.total}${resync.current ? `: ${resync.current}` : ''}. Pode sair desta tela, o trabalho continua.`
                  : toResync === null
                    ? 'Contando as músicas.'
                    : toResync === 0
                      ? 'Todas as letras já foram medidas no áudio.'
                      : `${toResync} ${toResync === 1 ? 'música ainda está' : 'músicas ainda estão'} com a sincronia original. Cada uma leva de um a dois minutos; as que não têm a voz separada são separadas antes.${resync.skipped > 0 ? ` Na última rodada, ${resync.skipped} ${resync.skipped === 1 ? 'ficou' : 'ficaram'} como estava: o modelo não reconheceu a letra na voz.` : ''}`
              }
            >
              {resync.running ? (
                <Button onClick={resync.stop}>Parar depois desta</Button>
              ) : (
                <Button disabled={!toResync} onClick={() => void resync.start()}>
                  Sincronizar todas
                </Button>
              )}
            </Row>
          )}
        </Group>

        <Group title="Downloads">
          <Row label="Formato padrão" hint="Áudio é mais leve. Vídeo mostra o clipe atrás da letra e ocupa cerca de dez vezes mais espaço.">
            <Segmented
              label="Formato padrão"
              value={settings.downloadKind}
              onChange={(downloadKind) => settings.update({ downloadKind })}
              options={[
                { value: 'audio', label: 'Áudio', icon: <MusicNotesIcon size={15} weight="fill" /> },
                { value: 'video', label: 'Vídeo', icon: <FilmStripIcon size={15} weight="fill" /> },
              ]}
            />
          </Row>
          <Row
            label="Downloader"
            hint={
              helper === 'checking'
                ? 'Verificando o ajudante.'
                : helper === null
                  ? 'Precisa do ajudante deste computador. Veja “Ajudante”, acima.'
                  : helper.ytDlp
                    ? `yt-dlp ${helper.ytDlp.version}. Se os downloads começarem a falhar, atualize: o YouTube muda com frequência.`
                    : 'O yt-dlp ainda não foi instalado.'
            }
          >
            <Button disabled={helper === 'checking' || helper === null || updating} onClick={() => void update()}>
              {updating ? 'Atualizando' : helper && helper !== 'checking' && !helper.ytDlp ? 'Instalar' : 'Atualizar'}
            </Button>
          </Row>
          {helper && helper !== 'checking' && !helper.ffmpeg && (
            <Row label="ffmpeg não encontrado" hint="Sem ele os vídeos vêm em 360p. Instale o ffmpeg e deixe-o no PATH para baixar em 720p. O áudio não é afetado.">
              <span />
            </Row>
          )}
        </Group>

        <Group title="Armazenamento">
          <Row
            label={storage ? `${formatBytes(storage.usage)} em uso` : 'Espaço em uso'}
            hint={
              storage
                ? `${songCount} ${songCount === 1 ? 'música guardada' : 'músicas guardadas'} neste navegador, de um limite de ${formatBytes(storage.quota)}.`
                : 'O navegador não informou o espaço usado.'
            }
          >
            <span />
          </Row>
          <Row
            label={storage?.persisted ? 'Biblioteca protegida' : 'Biblioteca sem proteção'}
            hint={
              storage?.persisted
                ? 'O navegador não vai apagar as músicas sozinho quando o disco ficar cheio.'
                : 'Com pouco espaço em disco o navegador pode limpar os dados deste site. Limpar o histórico do navegador também apaga a biblioteca.'
            }
          >
            {!storage?.persisted && <Button onClick={() => void protect()}>Proteger</Button>}
          </Row>
          <Row
            label="Levar para outro aparelho"
            hint="Dois jeitos, à sua escolha na hora: só a lista (um arquivo pequeno; o outro aparelho baixa as músicas de novo) ou as músicas completas (um pacote maior; chegam prontas para cantar). No outro aparelho, abra o arquivo em Adicionar música."
          >
            <Button disabled={songCount === 0} onClick={() => askExport('Minha biblioteca', useLibrary.getState().songs, useQueue.getState().playlists)}>
              Exportar a biblioteca
            </Button>
          </Row>
        </Group>

        <Group title="Sobre">
          <p className="max-w-[62ch] text-soft">
            O Gogó roda inteiro nesta máquina. As músicas ficam guardadas no navegador, a análise de melodia e a pontuação acontecem aqui, e nada é enviado
            para fora. As letras vêm do LRCLIB, um banco aberto mantido pela comunidade.
          </p>
          <p className="max-w-[62ch] text-soft">
            Baixar do YouTube é para uso pessoal. Quem baixa é o ajudante, que roda no seu computador e só atende os endereços que você autorizou; o site em si não baixa nada. Não distribua os arquivos baixados.
          </p>
        </Group>
      </div>
    </>
  )
}
