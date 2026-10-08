import { ArrowLeftIcon, HeadphonesIcon, MicrophoneIcon, MicrophoneStageIcon, SpeakerHighIcon } from '@phosphor-icons/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { Button, IconButton } from '@/components/button'
import { Segmented } from '@/components/form'
import { MicError, listMicrophones, microphonePermission } from '@/lib/audio/mic'
import type { MicInput } from '@/lib/audio/mic'
import { formatList, noteName } from '@/lib/format'
import type { Song } from '@/lib/types'
import { useSettings } from '@/state/settings'

type MicState = 'idle' | 'starting' | 'ready' | 'negado' | 'ausente' | 'outro'

const MIC_PROBLEM: Record<'negado' | 'ausente' | 'outro', string> = {
  negado: 'O navegador bloqueou o microfone. Clique no cadeado ao lado do endereço, libere o microfone e recarregue a página.',
  ausente: 'Nenhum microfone encontrado. Conecte um e tente de novo.',
  outro: 'O microfone não abriu. Feche outros programas que possam estar usando e tente de novo.',
}

const SCORING_NOTE = {
  melodia: 'A pontuação compara o seu tom com as barras da pista. Cantar uma oitava acima ou abaixo vale igual.',
  presenca: 'Esta música está sem guia de melodia, então a pontuação conta só se você canta no tempo certo.',
  nenhum: 'Sem letra sincronizada nem guia de melodia, dá para tocar mas não para pontuar.',
}

/**
 * Checagem antes de cantar. O clique em "Ligar microfone" ou "Começar" é o gesto que
 * o navegador exige para liberar o áudio, por isso o contexto de áudio nasce aqui.
 */
export function PreStage({
  song,
  mode,
  analyzing,
  guests,
  getMic,
  onBegin,
}: {
  song: Song
  mode: 'melodia' | 'presenca' | 'nenhum'
  /** A melodia ainda está sendo extraída: começar agora deixaria a apresentação sem guia de notas. */
  analyzing: boolean
  /** Quem está na sala agora. Cada um pontua pelo próprio celular. */
  guests: string[]
  getMic: () => MicInput
  onBegin: (withMic: boolean) => void
}) {
  const listenMode = useSettings((state) => state.listenMode)
  const difficulty = useSettings((state) => state.difficulty)
  const micDeviceId = useSettings((state) => state.micDeviceId)
  const update = useSettings((state) => state.update)

  const [micState, setMicState] = useState<MicState>('idle')
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const meter = useRef<HTMLDivElement>(null)
  const readout = useRef<HTMLSpanElement>(null)
  const canScore = mode !== 'nenhum' || analyzing
  // Com convidados, começar sem o microfone daqui ainda vale nota para eles.
  const shared = canScore && guests.length > 0

  const enable = useCallback(
    async (deviceId: string | null, listen: typeof listenMode) => {
      setMicState('starting')
      try {
        await getMic().start(deviceId, listen)
        setDevices(await listMicrophones())
        setMicState('ready')
      } catch (err) {
        setMicState(err instanceof MicError ? err.reason : 'outro')
      }
    },
    [getMic],
  )

  // Se o microfone já foi autorizado antes, liga sozinho.
  useEffect(() => {
    if (!canScore) return
    let alive = true
    void microphonePermission().then((state) => {
      if (alive && state === 'granted') void enable(micDeviceId, listenMode)
    })
    return () => {
      alive = false
    }
    // Só na montagem: as trocas de microfone e de modo são tratadas nos próprios controles.
  }, [])

  // Medidor e leitura da nota: atualizados direto no DOM, fora do React.
  useEffect(() => {
    if (micState !== 'ready') return
    let raf = 0
    let shown = 0
    let lastText = ''
    const tick = () => {
      raf = requestAnimationFrame(tick)
      const sample = getMic().read()
      // Sobe rápido e desce devagar, como um medidor de verdade.
      shown = sample.level > shown ? sample.level : shown * 0.92
      if (meter.current) meter.current.style.transform = `scaleX(${shown.toFixed(3)})`
      const text = sample.midi !== null ? noteName(sample.midi) : ''
      if (text !== lastText && readout.current) {
        lastText = text
        readout.current.textContent = text || 'cante algo'
      }
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [micState, getMic])

  const problem = micState === 'negado' || micState === 'ausente' || micState === 'outro' ? MIC_PROBLEM[micState] : null

  return (
    <div className="relative flex h-full flex-col overflow-y-auto px-5 pt-4 pb-10 md:px-[7vw] md:pt-6">
      <IconButton label="Voltar" className="self-start bg-canvas/40" onClick={() => history.back()}>
        <ArrowLeftIcon size={20} />
      </IconButton>

      <div className="my-auto max-w-[680px] pt-8">
        <h1 className="display line-clamp-3 text-5xl text-balance md:text-6xl xl:text-7xl">{song.title}</h1>
        {song.artist && <p className="mt-3 text-xl text-soft">{song.artist}</p>}

        {canScore && (
          <div className="mt-10 flex flex-col gap-7">
            <div>
              <p className="text-[13px] font-semibold text-soft">Microfone</p>
              {micState === 'idle' && (
                <Button className="mt-2.5" onClick={() => void enable(micDeviceId, listenMode)}>
                  <MicrophoneIcon size={18} weight="fill" />
                  Ligar microfone
                </Button>
              )}
              {micState === 'starting' && <div className="skeleton mt-3 h-2 w-full max-w-md rounded-full" />}
              {micState === 'ready' && (
                <div className="mt-3 max-w-md">
                  <div className="h-2 overflow-hidden rounded-full bg-ink/15">
                    <div ref={meter} className="h-full origin-left scale-x-0 rounded-full bg-accent" />
                  </div>
                  <p className="mt-2 flex items-start justify-between gap-4 text-sm text-soft">
                    <span>O medidor deve se mexer quando você canta.</span>
                    <span ref={readout} className="numeric whitespace-nowrap text-ink">
                      cante algo
                    </span>
                  </p>
                  {devices.length > 1 && (
                    <div className="mt-4 flex flex-col gap-2">
                      <label htmlFor="mic-device" className="text-[13px] font-semibold text-soft">
                        Entrada
                      </label>
                      <select
                        id="mic-device"
                        value={micDeviceId ?? ''}
                        onChange={(event) => {
                          const next = event.target.value || null
                          update({ micDeviceId: next })
                          void enable(next, listenMode)
                        }}
                        className="h-11 w-full rounded-field border border-hairline bg-surface px-3 text-[15px] text-ink"
                      >
                        <option value="">Padrão do sistema</option>
                        {devices.map((device) => (
                          <option key={device.deviceId} value={device.deviceId}>
                            {device.label || 'Microfone'}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                </div>
              )}
              {problem && (
                <div className="mt-2.5 max-w-md">
                  <p className="text-sm text-danger">{problem}</p>
                  <Button size="sm" className="mt-3" onClick={() => void enable(micDeviceId, listenMode)}>
                    Tentar de novo
                  </Button>
                </div>
              )}
            </div>

            <div className="flex flex-wrap gap-x-10 gap-y-6">
              <div>
                <p className="mb-2.5 text-[13px] font-semibold text-soft">Você ouve a música por</p>
                <Segmented
                  label="Saída de som"
                  value={listenMode}
                  onChange={(value) => {
                    update({ listenMode: value })
                    if (micState === 'ready') void enable(micDeviceId, value)
                  }}
                  options={[
                    { value: 'caixas', label: 'Caixas de som', icon: <SpeakerHighIcon size={15} weight="fill" /> },
                    { value: 'fones', label: 'Fones', icon: <HeadphonesIcon size={15} weight="fill" /> },
                  ]}
                />
              </div>
              <div>
                <p className="mb-2.5 text-[13px] font-semibold text-soft">Dificuldade</p>
                <Segmented
                  label="Dificuldade"
                  value={difficulty}
                  onChange={(value) => update({ difficulty: value })}
                  options={[
                    { value: 'facil', label: 'Fácil' },
                    { value: 'normal', label: 'Normal' },
                    { value: 'dificil', label: 'Difícil' },
                  ]}
                />
              </div>
            </div>
          </div>
        )}

        {shared && (
          <p className="mt-9 max-w-[58ch]">
            <span className="font-semibold">Na sala: {formatList(guests)}.</span>{' '}
            <span className="text-soft">{guests.length === 1 ? 'A nota dela vem do próprio celular.' : 'A nota de cada pessoa vem do próprio celular.'}</span>
          </p>
        )}

        <p className={shared ? 'mt-3 max-w-[58ch] text-soft' : 'mt-9 max-w-[58ch] text-soft'}>
          {analyzing ? 'Analisando a melodia desta música. Leva alguns segundos, e é ela que mostra as notas na pista.' : SCORING_NOTE[mode]}{' '}
          {song.lyrics !== 'line' && song.lyrics !== 'word' && (
            <Link to={`/musica/${song.id}/letra`} className="font-semibold text-accent-ink underline underline-offset-4">
              Sincronizar a letra
            </Link>
          )}
        </p>

        <div className="mt-6 flex flex-wrap gap-2">
          {canScore && (
            <Button variant="primary" size="lg" disabled={micState !== 'ready' || analyzing} onClick={() => onBegin(true)}>
              <MicrophoneStageIcon size={20} weight="fill" />
              Começar a cantar
            </Button>
          )}
          <Button variant={canScore ? 'ghost' : 'primary'} size="lg" disabled={shared && analyzing} onClick={() => onBegin(false)}>
            {shared ? 'Começar sem o meu microfone' : 'Tocar sem pontuar'}
          </Button>
        </div>
      </div>
    </div>
  )
}
