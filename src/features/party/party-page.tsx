import { CopyIcon, UsersThreeIcon } from '@phosphor-icons/react'
import QRCode from 'qrcode'
import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { Button } from '@/components/button'
import { Field, TextInput } from '@/components/form'
import { HelperMissing, useHelperPresence } from '@/components/helper-guide'
import { MAX_NAME, useParty } from '@/state/party'
import { useSettings } from '@/state/settings'
import { toast } from '@/state/toasts'

/** Código QR do endereço da sala, desenhado nas cores do tema. */
function JoinCode({ url }: { url: string }) {
  const [image, setImage] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    // Sempre escuro sobre claro: é o contraste que as câmeras leem melhor, em qualquer tema.
    QRCode.toDataURL(url, { margin: 2, width: 560, errorCorrectionLevel: 'M', color: { dark: '#14150f', light: '#f6f7f2' } }).then(
      (data) => alive && setImage(data),
      () => alive && setImage(null),
    )
    return () => {
      alive = false
    }
  }, [url])

  return (
    <div className="aspect-square w-full max-w-[320px] overflow-hidden rounded-card bg-[#f6f7f2]">
      {image ? <img src={image} alt={`Código QR para ${url}`} className="size-full" /> : <div className="skeleton size-full" />}
    </div>
  )
}

/** Nome de quem canta no microfone deste computador. Não pode repetir o de um convidado. */
function HostName() {
  const hostName = useSettings((state) => state.hostName)
  const rename = useParty((state) => state.rename)
  const [draft, setDraft] = useState(hostName)
  const [error, setError] = useState<string | null>(null)

  const commit = () => {
    const problem = rename(draft)
    setError(problem)
    if (!problem) setDraft(useSettings.getState().hostName)
  }

  return (
    <Field label="Seu nome no placar" hint="É como você aparece quando canta no microfone deste computador." error={error} className="mt-8 max-w-xs">
      {(props) => (
        <TextInput
          {...props}
          value={draft}
          maxLength={MAX_NAME}
          autoComplete="off"
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur()
          }}
        />
      )}
    </Field>
  )
}

const STEPS = [
  'Conecte o celular na mesma rede Wi-Fi deste computador.',
  'Aponte a câmera para o código ou digite o endereço no navegador.',
  'O navegador vai avisar que a conexão não é particular. Toque em “Avançado” e continue: o aviso aparece porque a sala é só da sua rede.',
  'Escreva seu nome e libere o microfone.',
]

export function PartyPage() {
  const { status, error, urls, guests, open, close } = useParty()
  const [chosen, setChosen] = useState(0)
  const helper = useHelperPresence()
  const url = urls[Math.min(chosen, urls.length - 1)]

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url)
      toast('Endereço copiado.')
    } catch {
      toast('Não deu para copiar. Selecione o endereço e copie à mão.', 'erro')
    }
  }

  if (status !== 'aberta') {
    return (
      <section className="grid min-h-[62dvh] items-center gap-10 md:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] md:gap-16">
        <div>
          <h1 className="display text-5xl text-balance md:text-6xl">Cantar junto, cada um com a sua nota.</h1>
          <p className="mt-6 max-w-[52ch] text-lg text-soft">
            Cada pessoa entra pelo próprio celular, na mesma rede Wi-Fi. O celular ouve a voz de quem está com ele e manda a afinação para cá. A música continua saindo
            só deste computador.
          </p>
          {helper.presence === 'ausente' || helper.presence === 'sem-permissao' ? (
            // Quem abre a sala na rede é o ajudante: sem ele não há onde os celulares entrarem.
            <HelperMissing what="A sala" presence={helper.presence} onRetry={helper.retry} className="mt-8 max-w-[56ch]" />
          ) : (
            <>
              {error && <p className="mt-4 text-danger">{error}</p>}
              <Button variant="primary" size="lg" className="mt-8" disabled={status === 'abrindo' || helper.presence === 'verificando'} onClick={() => void open()}>
                <UsersThreeIcon size={20} weight="fill" />
                {status === 'abrindo' ? 'Abrindo a sala' : 'Abrir a sala'}
              </Button>
            </>
          )}
        </div>
        <div className="rounded-card border border-hairline bg-surface p-7">
          <p className="font-semibold">Como fica na prática</p>
          <p className="mt-2 text-soft">
            Quem canta segura o celular por perto, como seguraria um microfone. Pode cantar no microfone da caixa de som ao mesmo tempo: o celular só serve para medir o tom.
          </p>
          <p className="mt-4 text-soft">Você continua escolhendo as músicas e controlando a fila. Os convidados só cantam.</p>
          <p className="mt-4 text-sm text-faint">
            Na primeira vez, o Windows pode perguntar se o Node pode usar a rede. É preciso permitir em redes privadas para os celulares conseguirem entrar.
          </p>
        </div>
      </section>
    )
  }

  return (
    <>
      <div className="flex flex-wrap items-end gap-x-4 gap-y-4">
        <h1 className="display text-4xl md:text-5xl">Sala aberta</h1>
        <div className="ml-auto flex flex-wrap gap-2">
          <Button variant="ghost" onClick={() => void close()}>
            Fechar a sala
          </Button>
          <Button asChild variant="primary">
            <Link to="/">Escolher a música</Link>
          </Button>
        </div>
      </div>

      <div className="mt-8 grid gap-x-14 gap-y-12 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)_minmax(0,1fr)]">
        <section aria-label="Endereço da sala">
          {url ? (
            <>
              <JoinCode url={url} />
              <p className="numeric mt-4 text-lg break-all">{url}</p>
              <Button size="sm" className="mt-3" onClick={() => void copy()}>
                <CopyIcon size={16} />
                Copiar endereço
              </Button>
              {urls.length > 1 && (
                <p className="mt-3 text-sm text-soft">
                  Este computador tem mais de uma rede. Se o celular não abrir, tente{' '}
                  {urls.map((other, index) =>
                    index === chosen ? null : (
                      <button key={other} type="button" onClick={() => setChosen(index)} className="numeric font-semibold text-accent-ink underline underline-offset-4">
                        {other.replace('https://', '')}
                      </button>
                    ),
                  )}
                  .
                </p>
              )}
            </>
          ) : (
            <p className="text-danger">Este computador não está em nenhuma rede. Conecte no Wi-Fi e abra a sala de novo.</p>
          )}
        </section>

        <section aria-labelledby="steps-heading">
          <h2 id="steps-heading" className="display text-2xl">
            Para entrar
          </h2>
          <ol className="mt-5 space-y-4">
            {STEPS.map((text, index) => (
              <li key={index} className="flex gap-4">
                <span className="numeric w-5 shrink-0 text-right text-faint">{index + 1}</span>
                <span className="text-soft">{text}</span>
              </li>
            ))}
          </ol>
        </section>

        <section aria-labelledby="guests-heading">
          <h2 id="guests-heading" className="display text-2xl">
            Na sala
            <span className="numeric ml-3 text-lg text-faint">{guests.length}</span>
          </h2>
          {guests.length === 0 ? (
            <p className="mt-5 text-soft">Ninguém entrou ainda. Os nomes aparecem aqui assim que cada pessoa entrar.</p>
          ) : (
            <ul className="mt-5 flex flex-wrap gap-2">
              {guests.map((guest) => (
                <li key={guest} className="rounded-full border border-hairline bg-raised px-4 py-2 font-semibold">
                  {guest}
                </li>
              ))}
            </ul>
          )}
          <p className="mt-6 text-sm text-faint">Cada nome só pode ser usado por uma pessoa. A pontuação de cada um aparece no palco e no resultado.</p>
          <HostName />
        </section>
      </div>
    </>
  )
}
