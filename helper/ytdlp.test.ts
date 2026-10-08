import { EventEmitter } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DOWNLOAD_TRIES, HelperError, download } from './ytdlp.ts'
import type { DownloadProgress } from './ytdlp.ts'

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }))

interface Outcome {
  code: number
  stderr?: string
  stdout?: string
}

/** Um yt-dlp de mentira: escreve o que foi pedido e fecha com o código dado. */
function fakeChild(outcome: Outcome) {
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), pid: 4242, exitCode: null as number | null, kill: vi.fn() })
  queueMicrotask(() => {
    if (outcome.stdout) child.stdout.emit('data', Buffer.from(outcome.stdout))
    if (outcome.stderr) child.stderr.emit('data', Buffer.from(outcome.stderr))
    child.exitCode = outcome.code
    child.emit('close', outcome.code)
  })
  return child
}

const REFUSED: Outcome = { code: 1, stderr: 'ERROR: [youtube] abc: HTTP Error 403: Forbidden\n' }
const THROTTLED: Outcome = { code: 1, stderr: "ERROR: [youtube] abc: Video unavailable. This content isn't available, try again later.\n" }
const FINE: Outcome = { code: 0, stdout: 'GOGO|500|1000|NA|NA|NA|140\n' }

/** As chamadas que abriram o downloader (no Windows, cancelar também chama o taskkill). */
const launches = () => mocks.spawn.mock.calls.filter((call) => call[0] === 'yt-dlp').length

describe('download: novas tentativas', () => {
  let dir: string
  let progress: DownloadProgress[]

  const start = (outcomes: Outcome[]) => {
    let call = 0
    mocks.spawn.mockImplementation((bin: string) => (bin === 'yt-dlp' ? fakeChild(outcomes[Math.min(call++, outcomes.length - 1)]) : fakeChild({ code: 0 })))
    return download({ bin: 'yt-dlp', ffmpeg: null, url: 'https://www.youtube.com/watch?v=abc', kind: 'audio', dir, onProgress: (p) => progress.push(p) })
  }

  beforeEach(async () => {
    vi.useFakeTimers()
    mocks.spawn.mockReset()
    progress = []
    dir = await mkdtemp(path.join(os.tmpdir(), 'gogo-ytdlp-'))
    // O que o yt-dlp deixaria na pasta depois de baixar.
    await writeFile(path.join(dir, 'media.m4a'), 'audio')
    await writeFile(path.join(dir, 'media.info.json'), JSON.stringify({ id: 'abc', title: 'Uma música', duration: 200, channel: 'Canal' }))
  })

  afterEach(async () => {
    vi.useRealTimers()
    await rm(dir, { recursive: true, force: true })
  })

  it('baixa na terceira tentativa quando as duas primeiras falham', async () => {
    const job = start([REFUSED, REFUSED, FINE])
    const settled = job.done.then((file) => file, (err: unknown) => err)
    await vi.advanceTimersByTimeAsync(60_000)
    const file = await settled
    expect(file).toMatchObject({ ext: 'm4a', mime: 'audio/mp4', info: { id: 'abc', title: 'Uma música' } })
    expect(launches()).toBe(3)
    // Quem espera fica sabendo de cada nova tentativa.
    expect([...new Set(progress.map((p) => p.attempt))]).toEqual([2, 3])
  })

  it(`desiste depois de ${DOWNLOAD_TRIES} tentativas e conta o motivo`, async () => {
    const job = start([REFUSED])
    const settled = job.done.then((file) => file, (err: unknown) => err)
    await vi.advanceTimersByTimeAsync(60_000)
    const error = await settled
    expect(error).toBeInstanceOf(HelperError)
    expect((error as HelperError).message).toMatch(/recusou o download \(403\)/)
    expect(launches()).toBe(DOWNLOAD_TRIES)
  })

  it('espera entre uma tentativa e outra, cada vez mais', async () => {
    const job = start([REFUSED])
    job.done.catch(() => {})
    await vi.advanceTimersByTimeAsync(0)
    expect(launches()).toBe(1)
    // 2 s antes da segunda.
    await vi.advanceTimersByTimeAsync(1900)
    expect(launches()).toBe(1)
    await vi.advanceTimersByTimeAsync(200)
    expect(launches()).toBe(2)
    // 4 s antes da terceira (a segunda começou aos 2 s).
    await vi.advanceTimersByTimeAsync(3800)
    expect(launches()).toBe(2)
    await vi.advanceTimersByTimeAsync(200)
    expect(launches()).toBe(3)
    // Não há quarta.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(launches()).toBe(3)
  })

  it('repete também o "vídeo indisponível", que é o que o YouTube responde quando limita o ritmo', async () => {
    const job = start([THROTTLED, FINE])
    const settled = job.done.then((file) => file, (err: unknown) => err)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(await settled).toMatchObject({ ext: 'm4a' })
    expect(launches()).toBe(2)
  })

  it.each([
    ['ERROR: [youtube] abc: This video is unavailable', /não está disponível no YouTube/],
    ['ERROR: [youtube] abc: Private video. Sign in if you\'ve been granted access to this video', /não está disponível no YouTube/],
    ["ERROR: [youtube] abc: Video unavailable. This content isn't available, try again later.", /limitando os downloads/],
    ['ERROR: [youtube] abc: Unable to download webpage: <urlopen error [Errno 11001] getaddrinfo failed>', /Sem conexão com o YouTube/],
    ['ERROR: [youtube] abc: Sign in to confirm your age. This video may be inappropriate for some users.', /restrição de idade/],
    ['ERROR: [youtube] abc: Sign in to confirm you’re not a bot. Use --cookies-from-browser or --cookies for the authentication.', /muitos pedidos deste endereço/],
    ['ERROR: [youtube] abc: This video is available to members of this channel only. Join this channel to get access', /exige login/],
    ['ERROR: unable to download video data: HTTP Error 403: Forbidden', /recusou o download \(403\)/],
  ])('explica a falha em português: %s', async (stderr, expected) => {
    const job = start([{ code: 1, stderr: `${stderr}\n` }])
    const settled = job.done.then((file) => file, (err: unknown) => err)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(((await settled) as HelperError).message).toMatch(expected)
    expect(launches()).toBe(DOWNLOAD_TRIES)
  })

  it('não tenta de novo depois de cancelado', async () => {
    const job = start([REFUSED])
    const settled = job.done.then((file) => file, (err: unknown) => err)
    await vi.advanceTimersByTimeAsync(500)
    expect(launches()).toBe(1)
    job.cancel()
    await vi.advanceTimersByTimeAsync(60_000)
    const error = await settled
    expect(error).toBeInstanceOf(HelperError)
    expect((error as HelperError).status).toBe(499)
    expect(launches()).toBe(1)
  })

  it('não insiste quando o downloader nem abre', async () => {
    mocks.spawn.mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), pid: undefined, exitCode: null, kill: vi.fn() })
      queueMicrotask(() => child.emit('error', new Error('ENOENT')))
      return child
    })
    const job = download({ bin: 'yt-dlp', ffmpeg: null, url: 'https://www.youtube.com/watch?v=abc', kind: 'audio', dir, onProgress: () => {} })
    const settled = job.done.then((file) => file, (err: unknown) => err)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(((await settled) as HelperError).status).toBe(500)
    expect(launches()).toBe(1)
  })
})
