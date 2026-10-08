import { create } from 'zustand'
import type { VideoSummary } from '@/lib/helper'
import { importLocalFile, importPackage, importYoutube, mediaKindOf } from '@/lib/importer'
import type { ImportPreset, ImportStage, ImportUpdate, PackageResult } from '@/lib/importer'
import { PACKAGE_EXTENSION, readPackage } from '@/lib/package'
import type { MediaKind, Song } from '@/lib/types'
import { toast } from './toasts'

export interface ImportJob {
  id: string
  title: string
  subtitle: string
  thumbnail?: string
  stage: ImportStage | 'erro'
  progress: number | null
  /** Só enquanto baixa: 2 ou 3 quando a tentativa anterior falhou. */
  attempt?: number
  songId?: string
  note?: string
  error?: string
}

interface JobsStore {
  jobs: ImportJob[]
  /** A promessa termina quando a música está pronta para cantar, e falha se a importação falhar. */
  addYoutube: (video: VideoSummary, kind: MediaKind, preset?: ImportPreset) => Promise<Song>
  /** Devolve quantos arquivos foram recusados por não serem mídia. */
  addFiles: (files: File[]) => number
  /**
   * Abre um pacote de músicas completas. Falha logo, com mensagem para o usuário, se o arquivo
   * não for um pacote; a cópia das músicas segue em segundo plano. Devolve quantas músicas ele tem.
   */
  addPackage: (file: Blob) => Promise<number>
  cancel: (id: string) => void
  dismiss: (id: string) => void
  clearFinished: () => void
}

export const STAGE_LABEL: Record<ImportJob['stage'], string> = {
  baixando: 'Baixando',
  salvando: 'Guardando no navegador',
  letra: 'Procurando a letra',
  separando: 'Separando a voz do instrumental',
  analisando: 'Lendo a melodia',
  conferindo: 'Conferindo a letra pelo áudio',
  sincronizando: 'Sincronizando a letra pelo áudio',
  pronta: 'Pronta para cantar',
  erro: 'Falhou',
}

const controllers = new Map<string, AbortController>()

function packageNote({ added, skipped }: PackageResult): string {
  if (added.length === 0) return skipped === 1 ? 'Essa música já estava na biblioteca.' : `As ${skipped} músicas do pacote já estavam na biblioteca.`
  const arrived = added.length === 1 ? 'Chegou pronta, sem baixar nada.' : `${added.length} músicas chegaram prontas, sem baixar nada.`
  if (skipped === 0) return arrived
  return `${arrived} ${skipped === 1 ? 'Outra já estava' : `Outras ${skipped} já estavam`} na biblioteca.`
}

export const useJobs = create<JobsStore>()((set, get) => {
  const update = (id: string, changes: Partial<ImportJob>) =>
    set((state) => ({ jobs: state.jobs.map((job) => (job.id === id ? { ...job, ...changes } : job)) }))

  const run = <T>(job: ImportJob, task: (report: (u: ImportUpdate) => void, signal: AbortSignal) => Promise<T>): Promise<T> => {
    const controller = new AbortController()
    controllers.set(job.id, controller)
    set((state) => ({ jobs: [job, ...state.jobs] }))

    const result = task((u) => update(job.id, { stage: u.stage, progress: u.progress, attempt: u.attempt, songId: u.songId, note: u.note }), controller.signal)
    result
      .catch((err: unknown) => {
        // Cancelado pelo usuário: o item já saiu da lista.
        if (controller.signal.aborted) return
        update(job.id, { stage: 'erro', progress: null, error: err instanceof Error ? err.message : 'A importação falhou.' })
      })
      .finally(() => controllers.delete(job.id))
    return result
  }

  return {
    jobs: [],

    addYoutube(video, kind, preset) {
      return run(
        { id: crypto.randomUUID(), title: preset?.title || video.title, subtitle: preset?.title ? preset.artist || video.channel : video.channel, thumbnail: video.thumbnail, stage: 'baixando', progress: 0 },
        (report, signal) => importYoutube(video, kind, report, signal, preset),
      )
    },

    addFiles(files) {
      let rejected = 0
      for (const file of files) {
        if (!mediaKindOf(file)) {
          rejected++
          continue
        }
        run({ id: crypto.randomUUID(), title: file.name, subtitle: 'Arquivo do computador', stage: 'salvando', progress: null }, (report, signal) =>
          importLocalFile(file, report, signal),
        )
      }
      return rejected
    },

    async addPackage(file) {
      const pack = await readPackage(file)
      const count = pack.header.songs.length
      run({ id: crypto.randomUUID(), title: pack.header.name, subtitle: count === 1 ? 'Pacote com 1 música' : `Pacote com ${count} músicas`, stage: 'salvando', progress: 0 }, async (report, signal) => {
        const result = await importPackage(pack, report, signal)
        report({ stage: 'pronta', progress: 1, songId: result.added.length === 1 ? result.added[0].id : undefined, note: packageNote(result) })
        return result
        // O erro já aparece no painel: aqui só não pode ficar solto.
      }).catch(() => {})
      return count
    },

    cancel(id) {
      controllers.get(id)?.abort()
      get().dismiss(id)
    },

    dismiss(id) {
      set((state) => ({ jobs: state.jobs.filter((job) => job.id !== id) }))
    },

    clearFinished() {
      set((state) => ({ jobs: state.jobs.filter((job) => job.stage !== 'pronta' && job.stage !== 'erro') }))
    },
  }
})

export function isRunning(job: ImportJob): boolean {
  return job.stage !== 'pronta' && job.stage !== 'erro'
}

/** Abre um pacote de músicas completas e avisa o que está acontecendo. false quando o arquivo não serve. */
export async function openPackage(file: Blob): Promise<boolean> {
  try {
    const count = await useJobs.getState().addPackage(file)
    toast(count === 1 ? 'Abrindo o pacote: 1 música.' : `Abrindo o pacote: ${count} músicas.`)
    return true
  } catch (err) {
    toast(err instanceof Error ? err.message : 'Não deu para abrir esse pacote.', 'erro')
    return false
  }
}

/** Importa os arquivos e avisa quando algum foi recusado. Usado por todas as entradas de arquivo. */
export function importFiles(all: File[]): void {
  // Um pacote de músicas completas solto na janela é aberto como pacote, não como música.
  const isPack = (file: File) => file.name.toLowerCase().endsWith(`.${PACKAGE_EXTENSION}`)
  for (const file of all.filter(isPack)) void openPackage(file)
  const files = all.filter((file) => !isPack(file))
  if (files.length === 0) return

  const rejected = useJobs.getState().addFiles(files)
  const accepted = files.length - rejected
  if (accepted > 0) toast(accepted === 1 ? 'Importando 1 arquivo.' : `Importando ${accepted} arquivos.`)
  if (rejected > 0) {
    toast(rejected === 1 ? 'Um arquivo não é áudio nem vídeo e ficou de fora.' : `${rejected} arquivos não são áudio nem vídeo e ficaram de fora.`, 'erro')
  }
}
