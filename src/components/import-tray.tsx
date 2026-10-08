import { CaretDownIcon, CheckIcon, MicrophoneStageIcon, WarningIcon, XIcon } from '@phosphor-icons/react'
import { AnimatePresence, motion } from 'motion/react'
import { useState } from 'react'
import { Link } from 'react-router'
import { DOWNLOAD_TRIES } from '@/lib/helper'
import { STAGE_LABEL, isRunning, useJobs } from '@/state/jobs'
import type { ImportJob } from '@/state/jobs'
import { Button, IconButton } from './button'
import { cn } from './cn'

function JobRow({ job }: { job: ImportJob }) {
  const cancel = useJobs((state) => state.cancel)
  const dismiss = useJobs((state) => state.dismiss)
  const running = isRunning(job)
  const percent = job.progress === null ? null : Math.round(job.progress * 100)

  return (
    <motion.li
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, x: 16 }}
      transition={{ type: 'spring', stiffness: 420, damping: 36 }}
      className="flex items-start gap-3 py-3"
    >
      <div className="relative mt-0.5 aspect-video w-16 shrink-0 overflow-hidden rounded-[10px] bg-raised">
        {job.thumbnail && <img src={job.thumbnail} alt="" className="size-full object-cover" />}
      </div>

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold">{job.title}</p>
        <p className={cn('mt-0.5 text-[13px]', job.stage === 'erro' ? 'text-danger' : 'text-soft')}>
          {job.stage === 'erro' ? job.error : STAGE_LABEL[job.stage]}
          {job.stage === 'baixando' && (job.attempt ?? 1) > 1 && `, tentativa ${job.attempt} de ${DOWNLOAD_TRIES}`}
          {running && percent !== null && <span className="numeric ml-1.5 text-faint">{percent}%</span>}
        </p>
        {job.stage === 'pronta' && job.note && <p className="mt-1 text-[13px] text-faint">{job.note}</p>}

        {running && (
          <div className="mt-2 h-1 overflow-hidden rounded-full bg-ink/12" role="progressbar" aria-valuenow={percent ?? undefined} aria-valuemin={0} aria-valuemax={100}>
            {percent === null ? (
              <div className="skeleton h-full w-full" />
            ) : (
              <div className="h-full origin-left rounded-full bg-accent transition-transform duration-300 ease-expo" style={{ transform: `scaleX(${job.progress})` }} />
            )}
          </div>
        )}

        {job.stage === 'pronta' && job.songId && (
          <Button asChild variant="primary" size="sm" className="mt-2.5">
            <Link to={`/cantar/${job.songId}`}>
              <MicrophoneStageIcon size={16} weight="fill" />
              Cantar
            </Link>
          </Button>
        )}
      </div>

      <IconButton label={running ? 'Cancelar' : 'Dispensar'} size="sm" onClick={() => (running ? cancel(job.id) : dismiss(job.id))}>
        <XIcon size={16} />
      </IconButton>
    </motion.li>
  )
}

/** Painel flutuante com as importações em andamento. Acompanha o usuário entre as telas. */
export function ImportTray() {
  const jobs = useJobs((state) => state.jobs)
  const clearFinished = useJobs((state) => state.clearFinished)
  const [open, setOpen] = useState(true)

  if (jobs.length === 0) return null

  const running = jobs.filter(isRunning).length
  const failed = jobs.filter((job) => job.stage === 'erro').length
  const summary = running > 0 ? `${running} em andamento` : failed > 0 ? `${failed} com falha` : 'Tudo pronto'

  return (
    <section
      aria-label="Importações"
      className="fixed right-4 bottom-20 z-30 w-[min(calc(100vw-2rem),380px)] overflow-hidden rounded-card border border-hairline bg-surface shadow-[var(--shadow)] md:bottom-6"
    >
      <header className="flex items-center gap-3 py-2 pr-2 pl-5">
        <span className="flex size-6 items-center justify-center text-accent-ink">
          {running > 0 ? (
            <span className="size-3 animate-pulse rounded-full bg-accent" />
          ) : failed > 0 ? (
            <WarningIcon size={18} weight="fill" className="text-danger" />
          ) : (
            <CheckIcon size={18} weight="bold" />
          )}
        </span>
        <h2 className="flex-1 text-sm font-semibold">
          Importações <span className="font-normal text-soft">{summary}</span>
        </h2>
        {running === 0 && (
          <Button variant="ghost" size="sm" onClick={clearFinished}>
            Limpar
          </Button>
        )}
        <IconButton label={open ? 'Recolher' : 'Expandir'} size="sm" onClick={() => setOpen(!open)} aria-expanded={open}>
          <CaretDownIcon size={16} className={cn('transition-transform duration-300 ease-expo', !open && 'rotate-180')} />
        </IconButton>
      </header>

      {open && (
        <ul className="max-h-[46dvh] overflow-y-auto border-t border-hairline px-5">
          <AnimatePresence initial={false}>
            {jobs.map((job) => (
              <JobRow key={job.id} job={job} />
            ))}
          </AnimatePresence>
        </ul>
      )}
    </section>
  )
}
