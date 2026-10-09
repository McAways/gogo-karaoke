/**
 * O mínimo de zip de que o app precisa: acrescentar um arquivo a um zip que já existe.
 *
 * Serve ao pacote do ajudante. O zip publicado é o mesmo para qualquer endereço; na hora do
 * download o app anota nele o próprio endereço, e o instalador o autoriza sem perguntar.
 */
const LOCAL_FILE = 0x04034b50
const INDEX_ENTRY = 0x02014b50
const END_OF_INDEX = 0x06054b50
/** 1º de janeiro de 2026, no formato de data do zip: a mesma data dos arquivos do pacote. */
const DATE = ((2026 - 1980) << 9) | (1 << 5) | 1

let table: Uint32Array | null = null

function crc32(data: Uint8Array): number {
  table ??= Uint32Array.from({ length: 256 }, (_, index) => {
    let value = index
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    return value >>> 0
  })
  let crc = 0xffffffff
  for (const byte of data) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/**
 * Acrescenta um arquivo, sem compressão, a um zip pronto. O que já estava no zip fica byte a
 * byte como estava: o arquivo novo entra antes do índice, e o índice ganha uma linha.
 */
export function appendToZip(zip: Uint8Array, name: string, data: Uint8Array): Uint8Array<ArrayBuffer> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
  // O registro final são os últimos 22 bytes, ou um pouco antes quando o zip tem comentário.
  let end = zip.length - 22
  while (end >= 0 && view.getUint32(end, true) !== END_OF_INDEX) end--
  if (end < 0) throw new Error('Esse arquivo não é um zip.')
  const count = view.getUint16(end + 10, true)
  const indexSize = view.getUint32(end + 12, true)
  const indexStart = view.getUint32(end + 16, true)

  const path = new TextEncoder().encode(name)
  const sum = crc32(data)

  const local = new DataView(new ArrayBuffer(30))
  local.setUint32(0, LOCAL_FILE, true)
  local.setUint16(4, 20, true)
  local.setUint16(6, 0x0800, true) // nomes em UTF-8
  local.setUint16(12, DATE, true)
  local.setUint32(14, sum, true)
  local.setUint32(18, data.length, true)
  local.setUint32(22, data.length, true)
  local.setUint16(26, path.length, true)

  const entry = new DataView(new ArrayBuffer(46))
  entry.setUint32(0, INDEX_ENTRY, true)
  entry.setUint16(4, (3 << 8) | 20, true) // "feito no Unix", como o resto do pacote
  entry.setUint16(6, 20, true)
  entry.setUint16(8, 0x0800, true)
  entry.setUint16(14, DATE, true)
  entry.setUint32(16, sum, true)
  entry.setUint32(20, data.length, true)
  entry.setUint32(24, data.length, true)
  entry.setUint16(28, path.length, true)
  entry.setUint32(38, (0o100644 << 16) >>> 0, true) // arquivo comum, sem permissão de executar
  entry.setUint32(42, indexStart, true) // o arquivo novo começa onde o índice começava

  const tail = new DataView(new ArrayBuffer(22))
  tail.setUint32(0, END_OF_INDEX, true)
  tail.setUint16(8, count + 1, true)
  tail.setUint16(10, count + 1, true)
  tail.setUint32(12, indexSize + entry.byteLength + path.length, true)
  tail.setUint32(16, indexStart + local.byteLength + path.length + data.length, true)

  const parts = [zip.subarray(0, indexStart), new Uint8Array(local.buffer), path, data, zip.subarray(indexStart, indexStart + indexSize), new Uint8Array(entry.buffer), path, new Uint8Array(tail.buffer)]
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}
