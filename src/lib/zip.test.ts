import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { crc32, inflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { appendToZip } from './zip'

interface Entry {
  name: string
  text: string
  /** Permissão no estilo do Unix (0o755, 0o644). */
  mode: number
}

/** Lê um zip pelo índice, como um programa de extrair faria, e confere a soma de cada arquivo. */
function read(zip: Uint8Array): Entry[] {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
  const end = zip.length - 22
  expect(view.getUint32(end, true)).toBe(0x06054b50)
  const entries: Entry[] = []
  let at = view.getUint32(end + 16, true)
  for (let i = 0; i < view.getUint16(end + 10, true); i++) {
    expect(view.getUint32(at, true)).toBe(0x02014b50)
    const method = view.getUint16(at + 10, true)
    const packedSize = view.getUint32(at + 20, true)
    const nameSize = view.getUint16(at + 28, true)
    const local = view.getUint32(at + 42, true)
    const name = new TextDecoder().decode(zip.subarray(at + 46, at + 46 + nameSize))

    expect(view.getUint32(local, true)).toBe(0x04034b50)
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true)
    const packed = zip.subarray(start, start + packedSize)
    const data = method === 8 ? inflateRawSync(packed) : packed
    expect(crc32(data)).toBe(view.getUint32(at + 16, true))
    expect(data.length).toBe(view.getUint32(at + 24, true))

    entries.push({ name, text: new TextDecoder().decode(data), mode: (view.getUint32(at + 38, true) >>> 16) & 0o777 })
    at += 46 + nameSize + view.getUint16(at + 30, true) + view.getUint16(at + 32, true)
  }
  expect(at).toBe(view.getUint32(end + 16, true) + view.getUint32(end + 12, true))
  return entries
}

const bytes = (text: string) => new TextEncoder().encode(text)
/** Um zip sem nenhum arquivo é só o registro final. */
const EMPTY = new Uint8Array([0x50, 0x4b, 0x05, 0x06, ...new Array<number>(18).fill(0)])

describe('acrescentar um arquivo a um zip', () => {
  it('monta um zip válido a partir de um vazio, um arquivo por vez', () => {
    const one = appendToZip(EMPTY, 'pasta/endereço.txt', bytes('https://meu-gogo.vercel.app\n'))
    const two = appendToZip(one, 'pasta/outro.txt', bytes(''))
    expect(read(two)).toEqual([
      { name: 'pasta/endereço.txt', text: 'https://meu-gogo.vercel.app\n', mode: 0o644 },
      { name: 'pasta/outro.txt', text: '', mode: 0o644 },
    ])
  })

  it('recusa o que não é zip', () => {
    expect(() => appendToZip(bytes('isto não é um zip, nem de longe'), 'a.txt', bytes('a'))).toThrow('não é um zip')
  })

  // O pacote publicado é gerado por "npm run helper:pack"; helper/package.test.ts cobra que ele exista e esteja em dia.
  const published = path.resolve(import.meta.dirname, '../../public/gogo-ajudante.zip')
  it.skipIf(!existsSync(published))('o pacote do ajudante segue inteiro depois de receber o endereço do app', () => {
    const original = new Uint8Array(readFileSync(published))
    const before = read(original)
    const after = read(appendToZip(original, 'gogo-ajudante/endereco-do-app.txt', bytes('https://meu-gogo.vercel.app\n')))

    expect(after.slice(0, -1)).toEqual(before)
    expect(after.at(-1)).toEqual({ name: 'gogo-ajudante/endereco-do-app.txt', text: 'https://meu-gogo.vercel.app\n', mode: 0o644 })
    // O que faz o macOS abrir o instalador com dois cliques continua lá.
    expect(after.find((entry) => entry.name === 'gogo-ajudante/instalar.command')?.mode).toBe(0o755)
    expect(after.find((entry) => entry.name === 'gogo-ajudante/instalar.cmd')?.text).toContain('helper\\install.ts')
  })
})
