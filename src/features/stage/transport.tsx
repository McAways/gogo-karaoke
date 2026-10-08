import {
  ArrowCounterClockwiseIcon,
  CornersInIcon,
  CornersOutIcon,
  MinusIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  SpeakerHighIcon,
  UserSoundIcon,
} from '@phosphor-icons/react'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { Button, IconButton, Tooltip } from '@/components/button'
import { cn } from '@/components/cn'
import { Slider } from '@/components/form'
import { formatDuration, formatOffset } from '@/lib/format'
import { useSettings } from '@/state/settings'
import type { StageSession } from './session'

export const OFFSET_STEP = 0.1

function useFullscreen(): [boolean, () => void] {
  const [active, setActive] = useState(() => document.fullscreenElement !== null)

  useEffect(() => {
    const onChange = () => setActive(document.fullscreenElement !== null)
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  const toggle = () => {
    if (document.fullscreenElement) void document.exitFullscreen()
    else void document.documentElement.requestFullscreen().catch(() => {})
  }
  return [active, toggle]
}

/** exato = a música tem faixas separadas. aproximado = truque de cancelar o centro. nenhum = nem isso (mono). */
export type VocalControl = 'exato' | 'aproximado' | 'nenhum'

/** Controles do palco: posição, tocar, atraso da letra, voz original e volume. */
export function Transport({
  session,
  vocalControl,
  onOffset,
  onFinish,
  className,
}: {
  session: StageSession
  vocalControl: VocalControl
  onOffset: (offset: number) => void
  onFinish: () => void
  className?: string
}) {
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot)
  const volume = useSettings((state) => state.volume)
  const vocalLevel = useSettings((state) => state.vocalLevel)
  const update = useSettings((state) => state.update)

  const [time, setTime] = useState(0)
  const [dragging, setDragging] = useState<number | null>(null)
  const [fullscreen, toggleFullscreen] = useFullscreen()

  // A posição só precisa andar algumas vezes por segundo na tela.
  useEffect(() => {
    let last = 0
    return session.onFrame((frame) => {
      const now = performance.now()
      if (now - last < 250) return
      last = now
      setTime(frame.time)
    })
  }, [session])

  useEffect(() => session.setVolume(volume), [session, volume])
  useEffect(() => session.setVocalLevel(vocalControl === 'nenhum' ? 1 : vocalLevel), [session, vocalLevel, vocalControl])

  const voiceOff = vocalLevel < 0.05
  const voiceLabel =
    vocalControl === 'nenhum'
      ? 'Gravação mono e sem separação: não dá para tirar a voz'
      : `${voiceOff ? 'Voltar a voz original' : 'Tirar a voz original'}${vocalControl === 'aproximado' ? ' (aproximado: música não separada)' : ''}`

  const duration = session.duration
  const shown = dragging ?? time

  return (
    <footer className={cn('px-5 pb-5 transition-opacity duration-500 md:px-10 md:pb-7', className)}>
      <div className="flex items-center gap-3">
        <span className="numeric w-11 text-sm text-soft">{formatDuration(shown)}</span>
        <Slider
          label="Posição na música"
          value={shown}
          max={Math.max(1, duration)}
          step={0.1}
          onChange={setDragging}
          onCommit={(value) => {
            session.seek(value)
            setTime(value)
            setDragging(null)
          }}
        />
        <span className="numeric w-11 text-right text-sm text-soft">{formatDuration(duration)}</span>
      </div>

      <div className="mt-2.5 flex flex-wrap items-center gap-x-1.5 gap-y-2.5 md:gap-x-2.5">
        <Tooltip label={snapshot.playing ? 'Pausar (espaço)' : 'Tocar (espaço)'}>
          <button
            type="button"
            aria-label={snapshot.playing ? 'Pausar' : 'Tocar'}
            onClick={() => session.toggle()}
            className="flex size-14 shrink-0 items-center justify-center rounded-full bg-ink text-canvas transition-transform duration-200 ease-expo hover:scale-105 active:scale-95"
          >
            {snapshot.playing ? <PauseIcon size={24} weight="fill" /> : <PlayIcon size={24} weight="fill" />}
          </button>
        </Tooltip>
        <IconButton label="Recomeçar (R)" onClick={() => session.restart()}>
          <ArrowCounterClockwiseIcon size={20} />
        </IconButton>

        <div className="order-last flex w-full items-center justify-between rounded-full border border-hairline bg-canvas/50 sm:order-none sm:ml-1 sm:w-auto sm:justify-start">
          <IconButton label="Letra mais cedo ( [ )" size="sm" className="size-10" onClick={() => onOffset(snapshot.offset - OFFSET_STEP)}>
            <MinusIcon size={16} weight="bold" />
          </IconButton>
          <span className="flex min-w-24 flex-col items-center px-1 leading-tight">
            <span className="text-[11px] font-semibold text-faint">Atraso da letra</span>
            <span className="numeric text-sm">{formatOffset(snapshot.offset)}</span>
          </span>
          <IconButton label="Letra mais tarde ( ] )" size="sm" className="size-10" onClick={() => onOffset(snapshot.offset + OFFSET_STEP)}>
            <PlusIcon size={16} weight="bold" />
          </IconButton>
        </div>

        <IconButton
          label={voiceLabel}
          aria-pressed={voiceOff}
          disabled={vocalControl === 'nenhum'}
          variant={voiceOff && vocalControl !== 'nenhum' ? 'primary' : 'ghost'}
          onClick={() => update({ vocalLevel: voiceOff ? 1 : 0 })}
        >
          <UserSoundIcon size={20} weight={voiceOff ? 'regular' : 'fill'} />
        </IconButton>
        {vocalControl !== 'nenhum' && (
          <div className="hidden w-24 lg:block">
            <Slider label="Volume da voz original" value={vocalLevel} onChange={(value) => update({ vocalLevel: value })} />
          </div>
        )}

        <div className="ml-1 hidden w-36 items-center gap-2.5 md:flex">
          <SpeakerHighIcon size={20} className="shrink-0 text-soft" />
          <Slider label="Volume" value={volume} onChange={(value) => update({ volume: value })} />
        </div>

        <div className="ml-auto flex items-center gap-1.5">
          <span className="hidden sm:block">
            <IconButton label={fullscreen ? 'Sair da tela cheia (F)' : 'Tela cheia (F)'} onClick={toggleFullscreen}>
              {fullscreen ? <CornersInIcon size={20} /> : <CornersOutIcon size={20} />}
            </IconButton>
          </span>
          <Button size="sm" onClick={onFinish}>
            Encerrar
          </Button>
        </div>
      </div>
    </footer>
  )
}
