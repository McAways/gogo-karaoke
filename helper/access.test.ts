import { describe, expect, it } from 'vitest'
import { decideAccess, helloAccess, normalizeSite } from './access.ts'

const SITE = 'https://gogo-do-luis.vercel.app'
const sites = [SITE]

describe('quem pode falar com o ajudante', () => {
  it('atende a própria página, com ou sem "Origin"', () => {
    expect(decideAccess({ host: 'localhost:5173', origin: 'http://localhost:5173', 'sec-fetch-site': 'same-origin' }, [])).toEqual({ trusted: true, cors: {} })
    expect(decideAccess({ host: 'localhost:5173', 'sec-fetch-site': 'same-origin' }, [])).toEqual({ trusted: true, cors: {} })
    // Endereço digitado na barra, ou um programa da máquina (sem os cabeçalhos do navegador).
    expect(decideAccess({ host: '127.0.0.1:5175', 'sec-fetch-site': 'none' }, []).trusted).toBe(true)
    expect(decideAccess({ host: 'localhost:5175' }, []).trusted).toBe(true)
  })

  it('atende o endereço autorizado e diz isso ao navegador', () => {
    const access = decideAccess({ host: 'localhost:5175', origin: SITE, 'sec-fetch-site': 'cross-site' }, sites)
    expect(access.trusted).toBe(true)
    expect(access.cors['Access-Control-Allow-Origin']).toBe(SITE)
    expect(access.cors.Vary).toBe('Origin')
    expect(access.cors['Access-Control-Allow-Methods']).toContain('DELETE')
    expect(access.cors['Access-Control-Allow-Private-Network']).toBeUndefined()
    // A consulta de rede local só é respondida quando o navegador pergunta.
    const asked = decideAccess({ host: 'localhost:5175', origin: SITE, 'access-control-request-private-network': 'true' }, sites)
    expect(asked.cors['Access-Control-Allow-Private-Network']).toBe('true')
  })

  it('recusa qualquer outro site, mesmo parecido', () => {
    for (const origin of ['https://outro-site.com', 'https://gogo-do-luis.vercel.app.evil.com', 'http://gogo-do-luis.vercel.app', 'https://GOGO-DO-LUIS.vercel.app:8443', 'null', 'isto não é endereço']) {
      expect(decideAccess({ host: 'localhost:5175', origin, 'sec-fetch-site': 'cross-site' }, sites), origin).toEqual({ trusted: false, cors: {} })
    }
    // Sem lista, ninguém de fora entra.
    expect(decideAccess({ host: 'localhost:5175', origin: SITE }, []).trusted).toBe(false)
  })

  it('recusa o pedido sem "Origin" que o navegador diz ter partido de outro site', () => {
    // É o caso de uma imagem ou de um link montado por outro site apontando para localhost.
    expect(decideAccess({ host: 'localhost:5175', 'sec-fetch-site': 'cross-site' }, sites).trusted).toBe(false)
    expect(decideAccess({ host: 'localhost:5175', 'sec-fetch-site': 'same-site' }, sites).trusted).toBe(false)
  })

  it('recusa outro nome apontando para esta máquina', () => {
    expect(decideAccess({ host: 'ataque.exemplo.com:5175', origin: 'http://ataque.exemplo.com:5175' }, sites).trusted).toBe(false)
    expect(decideAccess({ host: '192.168.0.10:5175' }, sites).trusted).toBe(false)
    expect(decideAccess({}, sites).trusted).toBe(false)
  })

  it('aceita outra porta desta máquina só quando ela está na lista', () => {
    const other = 'http://localhost:5199'
    expect(decideAccess({ host: 'localhost:5175', origin: other }, sites).trusted).toBe(false)
    expect(decideAccess({ host: 'localhost:5175', origin: other }, [other]).trusted).toBe(true)
  })
})

describe('a pergunta que qualquer página pode fazer', () => {
  it('responde a qualquer site se há ajudante e se ele confia no site, e nada além disso', () => {
    const stranger = helloAccess({ host: 'localhost:5175', origin: 'https://outro-site.com' }, sites)
    expect(stranger).toMatchObject({ allowed: false })
    expect(stranger?.cors['Access-Control-Allow-Origin']).toBe('https://outro-site.com')
    expect(stranger?.cors['Access-Control-Allow-Methods']).toBe('GET, OPTIONS')
    expect(helloAccess({ host: 'localhost:5175', origin: SITE }, sites)).toMatchObject({ allowed: true })
    expect(helloAccess({ host: 'localhost:5173', 'sec-fetch-site': 'same-origin' }, [])).toEqual({ allowed: true, cors: {} })
  })

  it('não responde nem isso a outro nome apontando para a máquina', () => {
    expect(helloAccess({ host: 'ataque.exemplo.com', origin: 'http://ataque.exemplo.com' }, sites)).toBeNull()
  })
})

describe('endereços que podem entrar na lista', () => {
  it('guarda só esquema, nome e porta', () => {
    expect(normalizeSite('https://gogo-do-luis.vercel.app/adicionar?x=1')).toBe(SITE)
    expect(normalizeSite('  HTTPS://Gogo-Do-Luis.Vercel.App  ')).toBe(SITE)
    expect(normalizeSite('http://localhost:5199/')).toBe('http://localhost:5199')
  })

  it('recusa http fora da própria máquina e o que não é endereço', () => {
    expect(normalizeSite('http://gogo-do-luis.vercel.app')).toBeNull()
    expect(normalizeSite('ftp://exemplo.com')).toBeNull()
    expect(normalizeSite('gogo-do-luis.vercel.app')).toBeNull()
    expect(normalizeSite('')).toBeNull()
  })
})
