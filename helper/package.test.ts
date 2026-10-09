import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { stampOf } from '../scripts/helper-stamp.ts'

const ROOT = path.resolve(import.meta.dirname, '..')
const REGENERATE = 'rode "npm run helper:pack" e commite public/gogo-ajudante.zip e public/gogo-ajudante.json'

// O app publicado oferece para baixar o zip que está em public/. Ele é gerado à mão e commitado,
// então pode ficar para trás: quem baixasse instalaria um ajudante velho para um app novo.
describe('pacote do ajudante publicado com o app', () => {
  it('foi gerado com o código de agora', () => {
    const info = path.join(ROOT, 'public', 'gogo-ajudante.json')
    expect(existsSync(info), `falta o pacote do ajudante em public/: ${REGENERATE}`).toBe(true)

    const { versao, bytes } = JSON.parse(readFileSync(info, 'utf8')) as { versao: string; bytes: number }
    expect(versao, `o ajudante mudou depois que o pacote de public/ foi gerado: ${REGENERATE}`).toBe(stampOf(ROOT))
    expect(readFileSync(path.join(ROOT, 'public', 'gogo-ajudante.zip')).length, `o zip e a ficha dele não batem: ${REGENERATE}`).toBe(bytes)
  })
})
