/**
 * Arquivos de mídia e capas ficam no OPFS (Origin Private File System): uma pasta
 * privada do site dentro do navegador. Aguenta arquivos grandes sem carregá-los na
 * memória e não precisa de servidor.
 */
/** listas = a lista de músicas para baixar que está em andamento (ver src/state/batch.ts). */
export type Folder = 'media' | 'covers' | 'listas'

async function folder(name: Folder): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory()
  return root.getDirectoryHandle(name, { create: true })
}

export function storageSupported(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.storage && typeof navigator.storage.getDirectory === 'function'
}

export async function saveBlob(dir: Folder, name: string, blob: Blob): Promise<void> {
  const handle = await (await folder(dir)).getFileHandle(name, { create: true })
  const writable = await handle.createWritable()
  try {
    await writable.write(blob)
    await writable.close()
  } catch (err) {
    await writable.abort().catch(() => {})
    throw err
  }
}

/** Grava um stream direto no disco e devolve o total de bytes. */
export async function saveStream(
  dir: Folder,
  name: string,
  stream: ReadableStream<Uint8Array>,
  onProgress?: (bytes: number) => void,
): Promise<number> {
  const handle = await (await folder(dir)).getFileHandle(name, { create: true })
  const writable = await handle.createWritable()
  const reader = stream.getReader()
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      // Cópia para um ArrayBuffer comum: o tipo do chunk pode vir sobre um SharedArrayBuffer.
      await writable.write(new Uint8Array(value))
      total += value.byteLength
      onProgress?.(total)
    }
    await writable.close()
    return total
  } catch (err) {
    await writable.abort().catch(() => {})
    await removeFile(dir, name)
    throw err
  }
}

export async function readFile(dir: Folder, name: string): Promise<File> {
  const handle = await (await folder(dir)).getFileHandle(name)
  return handle.getFile()
}

export async function removeFile(dir: Folder, name: string): Promise<void> {
  try {
    await (await folder(dir)).removeEntry(name)
  } catch {
    // Já não existia: nada a fazer.
  }
}

export interface StorageInfo {
  usage: number
  quota: number
  /** true quando o navegador prometeu não apagar os dados sob pressão de espaço. */
  persisted: boolean
}

export async function storageInfo(): Promise<StorageInfo> {
  const [estimate, persisted] = await Promise.all([navigator.storage.estimate(), navigator.storage.persisted()])
  return { usage: estimate.usage ?? 0, quota: estimate.quota ?? 0, persisted }
}

export async function requestPersistence(): Promise<boolean> {
  if (await navigator.storage.persisted()) return true
  return navigator.storage.persist()
}

const urlCache = new Map<string, Promise<string | null>>()

/** URL de objeto para uma capa. Fica em cache até `forgetCover`. */
export function coverUrl(name: string): Promise<string | null> {
  let pending = urlCache.get(name)
  if (!pending) {
    pending = readFile('covers', name).then(
      (file) => URL.createObjectURL(file),
      () => null,
    )
    urlCache.set(name, pending)
  }
  return pending
}

export function forgetCover(name: string): void {
  const pending = urlCache.get(name)
  urlCache.delete(name)
  void pending?.then((url) => url && URL.revokeObjectURL(url))
}
