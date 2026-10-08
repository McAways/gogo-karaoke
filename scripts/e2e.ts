// Uso: npm run test:e2e   (com o app rodando em outro terminal: npm run dev)
//      npm run test:e2e -- --sem-rede   pula as partes que dependem do YouTube e da LRCLIB
//
// Percorre o app num navegador de verdade (o Edge instalado), com um microfone
// simulado. A música de teste é sintética e tem melodia conhecida, então dá para
// afirmar que quem canta as notas certas pontua alto e quem canta as erradas, baixo.
// As capturas de tela ficam em scripts/.e2e/shots.
import assert from 'node:assert/strict'
import type { BrowserContext, Locator, Page } from 'playwright-core'
import { readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { BASE_URL, WORK_DIR, launch, shot, writeMicTrack, writeTestSong, writeTestVideo } from './lib/browser.ts'

const offline = process.argv.includes('--sem-rede')

const song = writeTestSong()
const video = writeTestVideo(song)
const tunedMic = writeMicTrack('mic-afinado.wav', song.melody, song.duration)
// Seis semitons acima: o erro de tom mais distante possível, em qualquer oitava.
const offKeyMic = writeMicTrack('mic-desafinado.wav', song.melody, song.duration, 6)

// Fones e latência zero: o microfone simulado não tem eco nem atraso acústico.
// A separação de voz começa desligada: a música sintética não tem voz de verdade para separar.
const SETTINGS = {
  state: {
    theme: 'dark',
    difficulty: 'normal',
    listenMode: 'fones',
    micDeviceId: null,
    latencyMs: 0,
    volume: 0.9,
    showLane: true,
    downloadKind: 'audio',
    separateOnImport: false,
    vocalLevel: 1,
  },
  version: 1,
}

const GUEST_URL = process.env.GOGO_GUEST_URL ?? 'https://localhost:5174'
// Para testar o app como publicado: a página vem de um endereço e o ajudante instalado atende em outro
// (GOGO_HELPER_URL=http://localhost:5197, por exemplo). Vazio = o ajudante é o próprio servidor do app.
const HELPER_URL = process.env.GOGO_HELPER_URL ?? ''
const HELPER_API = `${HELPER_URL || BASE_URL}/api/helper`

const step = (text: string) => console.log(`\n> ${text}`)
const settle = (page: Page, ms = 700) => page.waitForTimeout(ms)

async function prepare(context: BrowserContext): Promise<void> {
  await context.addInitScript(({ settings, helper }) => {
    if (!localStorage.getItem('gogo:settings')) localStorage.setItem('gogo:settings', JSON.stringify(settings))
    // Diz ao app onde está o ajudante instalado (só no teste do app publicado).
    if (helper) localStorage.setItem('gogo:ajudante', helper)
    // Anota quando o microfone abriu: o Chromium toca o arquivo em laço a partir daí.
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const stream = await original(constraints)
      ;(window as unknown as { __micStart: number }).__micStart = performance.now()
      return stream
    }
  }, { settings: SETTINGS, helper: HELPER_URL })
}

/** Abre a página do convidado num navegador próprio, como se fosse um celular na mesma rede. */
async function openGuest(profile: string, micFile: string, query = ''): Promise<{ context: BrowserContext; page: Page }> {
  const guest = await launch({ profile, micFile, width: 390, height: 844, ignoreHTTPSErrors: true })
  await guest.context.addInitScript(() => {
    // Anota, no relógio da máquina, quando o microfone abriu: os navegadores do teste comparam esse instante entre si.
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const stream = await original(constraints)
      ;(window as unknown as { __micStartWall: number }).__micStartWall = Date.now()
      return stream
    }
  })
  await guest.page.goto(`${GUEST_URL}/${query}`)
  await guest.page.getByRole('heading', { name: 'Entrar na sala' }).waitFor()
  return guest
}

async function joinAs(page: Page, name: string): Promise<void> {
  await page.getByLabel('Seu nome').fill(name)
  await page.getByRole('button', { name: 'Entrar', exact: true }).click()
}

/**
 * Exporta pelo botão ou item de menu dado: abre o diálogo, escolhe entre a lista e as músicas
 * completas e guarda o arquivo que o navegador salvou.
 */
async function exportBy(page: Page, trigger: Locator, what: 'lista' | 'completo', saveName: string, shotName?: string): Promise<{ file: string; suggested: string }> {
  await trigger.click()
  const dialog = page.getByRole('dialog', { name: 'Exportar para outro aparelho' })
  await dialog.getByRole('radio', { name: what === 'lista' ? /^Só a lista/ : /^Músicas completas/ }).check()
  const confirm = dialog.getByRole('button', { name: 'Exportar', exact: true })
  // O botão libera quando o app termina de medir as duas opções.
  await page.waitForFunction(() => {
    const button = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((b) => b.textContent?.trim() === 'Exportar')
    return button !== undefined && !button.disabled
  })
  if (shotName) {
    await settle(page, 300)
    await shot(page, shotName)
  }
  const [download] = await Promise.all([page.waitForEvent('download'), confirm.click()])
  const file = path.join(WORK_DIR, saveName)
  await download.saveAs(file)
  await dialog.waitFor({ state: 'hidden' })
  return { file, suggested: download.suggestedFilename() }
}

/** O que o app pediria para baixar, separar, medir ou buscar letra. Ao abrir um pacote, nada disso pode acontecer. */
const HEAVY_REQUEST = /\/api\/helper\/(download|separate|align|search|info|image|spotify)|lrclib\.net/

/** Espera a importação terminar. Se falhar ou demorar demais, mostra o que a bandeja dizia. */
async function waitImported(page: Page, timeoutMs: number): Promise<void> {
  const tray = page.locator('section[aria-label="Importações"]')
  try {
    await page.waitForFunction(
      () => {
        const text = document.querySelector('section[aria-label="Importações"]')?.textContent ?? ''
        return text.includes('Pronta para cantar') || text.includes('com falha')
      },
      null,
      { timeout: timeoutMs },
    )
  } catch {
    throw new Error(`A importação não terminou em ${timeoutMs / 1000} s. Bandeja: ${(await tray.textContent().catch(() => '')) ?? ''}`)
  }
  const text = (await tray.textContent()) ?? ''
  if (text.includes('com falha')) throw new Error(`A importação falhou. Bandeja: ${text}`)
}

async function waitForMic(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Começar a cantar' }).waitFor()
  await page.waitForFunction(() => {
    const button = [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('Começar a cantar'))
    return button !== undefined && !button.disabled
  })
}

/** Canta a música inteira e devolve os pontos mostrados na tela de resultado. */
async function sing(page: Page, songId: string, label: string): Promise<number> {
  await page.goto(`${BASE_URL}/cantar/${songId}`)
  await waitForMic(page)
  await settle(page)
  await shot(page, `palco-checagem-${label}`)

  // Clica no instante em que o laço do microfone recomeça, para voz e música andarem juntas.
  await page.evaluate(
    (loopMs) =>
      new Promise<void>((resolve) => {
        const elapsed = performance.now() - (window as unknown as { __micStart: number }).__micStart
        setTimeout(() => {
          const button = [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('Começar a cantar'))
          button?.click()
          resolve()
        }, loopMs - (elapsed % loopMs))
      }),
    song.duration * 1000,
  )

  await page.waitForTimeout(6500)
  await shot(page, `palco-cantando-${label}`)

  await page.waitForURL(/\/resultado\/\d+/, { timeout: (song.duration + 30) * 1000 })
  const points = page.locator('[aria-label$=" pontos"]')
  await points.waitFor()
  await page.waitForTimeout(2200)
  await shot(page, `resultado-${label}`, true)
  const text = (await points.getAttribute('aria-label')) ?? ''
  return Number(text.replace(/\D/g, ''))
}

async function importFile(page: Page, file: string): Promise<string> {
  await page.goto(BASE_URL)
  await page.getByRole('heading', { name: 'Biblioteca', exact: true }).waitFor()
  const before = await page.locator('article a[href^="/musica/"]').count()
  await page.goto(`${BASE_URL}/adicionar`)
  await page.locator('input[type=file]').first().setInputFiles(file)
  await page.getByText('Pronta para cantar').first().waitFor({ timeout: 120_000 })
  await page.goto(BASE_URL)
  await page.waitForFunction((count) => document.querySelectorAll('article a[href^="/musica/"]').length > count, before)
  // A biblioteca lista da mais recente para a mais antiga.
  const href = await page.locator('article a[href^="/musica/"]').first().getAttribute('href')
  assert.ok(href, 'a música importada deveria aparecer na biblioteca')
  return href.split('/').pop()!
}

// ---------- 1. Importar, anexar a letra e cantar afinado ----------

step('Abrindo o app com a biblioteca vazia')
let session = await launch({ profile: 'e2e', micFile: tunedMic })
await prepare(session.context)
let page = session.page
await page.goto(BASE_URL)
await page.getByRole('heading', { name: 'Sua biblioteca começa aqui.' }).waitFor()
await settle(page)
await shot(page, 'biblioteca-vazia')

step('Importando a música de teste (arquivo de áudio)')
await page.locator('input[type=file]').setInputFiles(song.songPath)
await page.getByText('Pronta para cantar').waitFor({ timeout: 90_000 })
await settle(page)
await shot(page, 'biblioteca-apos-importar')
const href = await page.locator('article a[href^="/musica/"]').first().getAttribute('href')
assert.ok(href, 'a música importada deveria aparecer na biblioteca')
const songId = href.split('/').pop()!

step('Página da música: guia de melodia e importação da letra')
await page.goto(`${BASE_URL}/musica/${songId}`)
await page.getByText('Guia extraído do áudio').waitFor({ timeout: 30_000 })
const guide = (await page.getByText(/\d+ notas\. Acerta/).textContent()) ?? ''
console.log(`  ${guide}`)
assert.equal(Number(/(\d+) notas/.exec(guide)?.[1]), song.melody.length, 'o guia deveria ter uma nota para cada nota da melodia de teste')
await page.locator('input[type=file][accept*=".lrc"]').setInputFiles({ name: 'letra.lrc', mimeType: 'text/plain', buffer: Buffer.from(song.lrc, 'utf8') })
await page.getByText('Sincronizada por linha').waitFor()
await settle(page)
await shot(page, 'musica', true)

step('Cantando afinado')
const tuned = await sing(page, songId, 'afinado')
console.log(`  pontos: ${tuned}`)
await session.context.close()

// ---------- 2. Mesma música, cantada fora do tom ----------

step('Cantando desafinado (mesma biblioteca, outro microfone)')
session = await launch({ profile: 'e2e', micFile: offKeyMic, fresh: false })
await prepare(session.context)
page = session.page
const offKey = await sing(page, songId, 'desafinado')
console.log(`  pontos: ${offKey}`)

// ---------- 3. Controles do palco, sem microfone ----------

step('Palco sem pontuar: atalhos, atraso da letra e modo caixas de som')
await page.goto(`${BASE_URL}/cantar/${songId}`)
await waitForMic(page)
await page.getByRole('radio', { name: 'Caixas de som' }).click()
await waitForMic(page)
console.log('  microfone reabriu com cancelamento de eco')
await page.getByRole('radio', { name: 'Fones' }).click()
await waitForMic(page)

await page.getByRole('button', { name: 'Tocar sem pontuar' }).click()
await page.getByRole('button', { name: 'Pausar' }).waitFor()
const offsetLabel = page.getByText('Atraso da letra').locator('xpath=following-sibling::span')
assert.equal(await offsetLabel.textContent(), '0,0 s')
await page.keyboard.press(']')
await page.keyboard.press(']')
assert.equal(await offsetLabel.textContent(), '+0,2 s', 'a tecla ] deveria atrasar a letra em 0,1 s por toque')

// Clica no botão de mais atraso (o foco fica nele) e confere que o espaço pausa em vez de repetir o clique.
await page.mouse.move(600, 500)
await page.getByRole('button', { name: /Letra mais tarde/ }).click()
assert.equal(await offsetLabel.textContent(), '+0,3 s')
await page.keyboard.press('Space')
await page.getByRole('button', { name: 'Tocar', exact: true }).waitFor()
assert.equal(await offsetLabel.textContent(), '+0,3 s', 'o espaço deveria pausar, não repetir o botão que está com o foco')
await settle(page, 400)
await shot(page, 'palco-pausado')
await page.keyboard.press('Space')
await page.getByRole('button', { name: 'Pausar' }).waitFor()
for (let i = 0; i < 3; i++) await page.keyboard.press('[')
assert.equal(await offsetLabel.textContent(), '0,0 s')

await page.getByRole('button', { name: 'Encerrar' }).click()
await page.waitForURL(new RegExp(`/musica/${songId}$`))
console.log('  encerrar sem microfone volta para a página da música, sem nota')
// O histórico é lido do IndexedDB depois que a página abre.
await page.locator('a[href^="/resultado/"]').first().waitFor()
const scoresInHistory = await page.locator('a[href^="/resultado/"]').count()
assert.equal(scoresInHistory, 2, 'o histórico deveria ter as duas apresentações pontuadas')

// ---------- 3b. Palco aberto com a análise ainda em andamento ----------

// O app só expõe o estado no modo de desenvolvimento (ver src/main.tsx).
const devMode = await page.evaluate(() => '__gogo' in window)
if (devMode) {
  step('Palco aberto antes de a análise terminar')
  const setMelody = (status: 'pending' | 'ready') =>
    page.evaluate(
      async ([id, value]) => {
        const { useLibrary } = (window as unknown as { __gogo: { useLibrary: typeof import('../src/state/library.ts').useLibrary } }).__gogo
        await useLibrary.getState().patch(id, { melody: value as 'pending' | 'ready' })
      },
      [songId, status],
    )
  await setMelody('pending')
  // Navegação pelo próprio app (sem recarregar), como quem clica em "Cantar" logo depois de importar.
  await page.locator(`a[href="/cantar/${songId}"]`).first().click()
  await page.getByText('Analisando a melodia desta música.').waitFor()
  await page.waitForTimeout(1500)
  assert.equal(await page.getByRole('button', { name: 'Começar a cantar' }).isDisabled(), true, 'não deveria deixar começar sem o guia de notas')
  await setMelody('ready')
  await waitForMic(page)
  console.log('  o botão de começar só libera quando a análise termina')
}

// ---------- 4. Vídeo local ----------

let videoId: string | null = null
if (video) {
  step('Importando um vídeo (capa tirada de um quadro, vídeo atrás da letra)')
  videoId = await importFile(page, video)
  await page.goto(`${BASE_URL}/musica/${videoId}`)
  await page.getByText('Guia extraído do áudio').waitFor({ timeout: 30_000 })
  await page.locator('main img').first().waitFor()
  console.log('  capa gerada a partir do vídeo')
  await page.goto(`${BASE_URL}/cantar/${videoId}`)
  await page.getByRole('button', { name: 'Tocar sem pontuar' }).click()
  await page.getByRole('button', { name: 'Pausar' }).waitFor()
  await page.mouse.move(700, 450)
  await page.waitForTimeout(2500)
  await shot(page, 'palco-video')
} else {
  console.log('\n> ffmpeg não encontrado: a parte de vídeo foi pulada')
}

// ---------- 4b. Fila e playlists ----------

step('Fila: montar, reordenar, salvar como playlist e cantar em sequência')
await page.setViewportSize({ width: 1440, height: 900 })
await page.goto(BASE_URL)
await page.getByRole('heading', { name: 'Biblioteca', exact: true }).waitFor()
const queueButtons = page.getByRole('button', { name: /^Pôr .+ na fila$/ })
const inLibrary = await queueButtons.count()
// Com uma música só, ela entra duas vezes: a fila aceita repetição.
await queueButtons.nth(0).click()
await queueButtons.nth(inLibrary > 1 ? 1 : 0).click()
await page.getByRole('link', { name: /^Fila\s*2$/ }).first().click()
await page.getByRole('heading', { name: 'Fila', exact: true }).waitFor()
const rows = page.locator('section[aria-label="Músicas na fila"] ol > li')
assert.equal(await rows.count(), 2)

const firstBefore = (await rows.nth(0).locator('p').first().textContent()) ?? ''
await rows.nth(1).getByRole('button', { name: 'Subir na fila' }).click()
await page.waitForTimeout(500)
const firstAfter = (await rows.nth(0).locator('p').first().textContent()) ?? ''
if (inLibrary > 1) assert.notEqual(firstAfter, firstBefore, 'subir a segunda música deveria trocar a ordem')

await page.getByLabel('Salvar a fila atual como').fill('Teste da fila')
await page.getByRole('button', { name: 'Salvar', exact: true }).click()
await page.getByText('Teste da fila', { exact: true }).waitFor()
await page.getByLabel('Salvar a fila atual como').fill('teste da FILA')
await page.getByRole('button', { name: 'Salvar', exact: true }).click()
await page.getByText('Já existe uma playlist com esse nome.').waitFor()
await settle(page, 300)
await shot(page, 'fila', true)

await page.getByRole('button', { name: 'Esvaziar' }).click()
await page.getByText('A fila está vazia').waitFor()
await page.getByRole('button', { name: 'Pôr na fila' }).click()
assert.equal(await rows.count(), 2, 'a playlist deveria devolver as duas músicas para a fila')

await page.getByRole('link', { name: 'Começar a fila' }).click()
await page.getByRole('button', { name: 'Tocar sem pontuar' }).click()
await page.getByRole('button', { name: 'Pausar' }).waitFor()
await page.mouse.move(600, 500)
await page.getByRole('button', { name: 'Encerrar' }).click()
// Sem nota para mostrar e com fila: volta para a fila, já sem a música que acabou de tocar.
await page.waitForURL(`${BASE_URL}/fila`)
await rows.first().waitFor()
assert.equal(await rows.count(), 1, 'a música que começou a tocar deveria ter saído da fila')
console.log('  ordem trocada, playlist salva e recarregada, e a música tocada saiu da fila')
await page.getByRole('button', { name: 'Esvaziar' }).click()
await page.getByRole('button', { name: /Excluir a playlist/ }).click()

// ---------- 4c. Sala: host e dois convidados, cada um com a sua nota ----------

step('Sala: abrir, entrar com dois celulares simulados e recusar nome repetido')
// Uma execução anterior interrompida pode ter deixado a sala aberta no ajudante.
await fetch(`${HELPER_API}/party/stop`, { method: 'POST' })
await page.goto(`${BASE_URL}/sala`)
await page.getByRole('button', { name: 'Abrir a sala' }).click()
await page.getByRole('heading', { name: 'Sala aberta' }).waitFor({ timeout: 30_000 })
await page.getByRole('img', { name: /Código QR/ }).waitFor()
const roomAddress = (await page.locator('section[aria-label="Endereço da sala"] p').first().textContent()) ?? ''
console.log(`  endereço mostrado aos convidados: ${roomAddress}`)
assert.match(roomAddress, /^https:\/\/\d+\.\d+\.\d+\.\d+:\d+$/, 'a sala deveria mostrar um endereço https da rede local')

// A Ana, que precisa de precisão para tirar nota alta, entra pelo caminho de reserva (requisições
// comuns em vez de WebSocket), o que alguns celulares exigem. O Beto entra pelo caminho normal.
const ana = await openGuest('e2e-ana', tunedMic, '?via=http')
const beto = await openGuest('e2e-beto', offKeyMic)
await joinAs(ana.page, 'Ana')
await ana.page.getByRole('heading', { name: 'Olá, Ana' }).waitFor()

// Mesmo nome com outra caixa, acento e espaços: é a mesma pessoa para a sala.
await joinAs(beto.page, '  ANÁ ')
await beto.page.getByText('Já tem alguém na sala com esse nome.').waitFor()
// O nome de quem comanda as músicas também está ocupado.
await joinAs(beto.page, 'anfitriao')
await beto.page.waitForTimeout(700)
assert.ok(await beto.page.getByRole('heading', { name: 'Entrar na sala' }).isVisible(), 'o nome do host não deveria ser aceito para um convidado')
assert.ok(await beto.page.getByText('Já tem alguém na sala com esse nome.').isVisible())
await shot(beto.page, 'convidado-nome-repetido')
await joinAs(beto.page, 'Beto')
await beto.page.getByRole('heading', { name: 'Olá, Beto' }).waitFor()
console.log('  "  ANÁ " e "anfitriao" foram recusados; "Beto" entrou')

await shot(ana.page, 'convidado-microfone')
await ana.page.getByRole('button', { name: 'Ligar microfone' }).click()
await ana.page.getByText('Aguardando a próxima música').waitFor()
const anaMicStart = await ana.page.evaluate(() => (window as unknown as { __micStartWall: number }).__micStartWall)
// O microfone do Beto abre quando o laço do da Ana recomeça: os dois cantam juntos, ele seis semitons fora.
await beto.page.evaluate(
  ([micStart, loopMs]) =>
    new Promise<void>((resolve) => {
      setTimeout(() => {
        document.getElementById('ligar-mic')?.click()
        resolve()
      }, loopMs - ((Date.now() - micStart) % loopMs))
    }),
  [anaMicStart, song.duration * 1000],
)
await beto.page.getByText('Aguardando a próxima música').waitFor()

const guestList = page.locator('section[aria-labelledby="guests-heading"]')
await guestList.getByText('Ana', { exact: true }).waitFor()
await guestList.getByText('Beto', { exact: true }).waitFor()
await page.getByRole('link', { name: /^Sala\s*2$/ }).first().waitFor()

// O host não pode trocar o próprio nome por um que já está na sala.
const hostNameField = page.getByLabel('Seu nome no placar')
await hostNameField.fill('beto')
await hostNameField.press('Enter')
await page.getByText('Já tem alguém na sala com esse nome.').waitFor()
await hostNameField.fill('Luis')
await hostNameField.press('Enter')
await page.getByText('Já tem alguém na sala com esse nome.').waitFor({ state: 'detached' })
await settle(page, 400)
await shot(page, 'sala', true)
console.log('  os dois aparecem na tela do host, que não consegue usar o nome de um convidado')

step('Sala: os três cantam a mesma música, cada um com a sua nota')
await page.goto(`${BASE_URL}/cantar/${songId}`)
await waitForMic(page)
await page.getByText('Na sala: Ana e Beto.').waitFor()
await settle(page, 400)
await shot(page, 'sala-checagem')

// Começa no instante em que o laço do microfone da Ana recomeça: é ela quem canta afinado.
await page.evaluate(
  ([micStart, loopMs]) =>
    new Promise<void>((resolve) => {
      setTimeout(() => {
        const button = [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('Começar a cantar'))
        button?.click()
        resolve()
      }, loopMs - ((Date.now() - micStart) % loopMs))
    }),
  [anaMicStart, song.duration * 1000],
)

await ana.page.getByText('Rua da Voz').waitFor()
await page.waitForTimeout(7000)
await page.mouse.move(700, 450)
await settle(page, 300)
await shot(page, 'sala-palco')
await shot(ana.page, 'convidado-cantando')
const liveBoard = await page.locator('aside[aria-label="Placar da sala"] li').allTextContents()
console.log(`  placar aos 7 s: ${liveBoard.join(' | ')}`)
assert.equal(liveBoard.length, 3, 'o placar do palco deveria ter os dois convidados e o host')
assert.match(liveBoard[0], /Ana/, 'quem canta afinado deveria estar na frente')
const anaLive = Number(((await ana.page.locator('#pontos').textContent()) ?? '').replace(/\D/g, ''))
assert.ok(anaLive > 0, 'o celular da Ana deveria mostrar a nota dela subindo')
assert.notEqual((await ana.page.locator('#linha-atual').textContent()) ?? '', '', 'o celular deveria mostrar a letra que está sendo cantada')

await page.waitForURL(/\/resultado\/\d+/, { timeout: (song.duration + 30) * 1000 })
await page.getByRole('heading', { name: 'Placar da rodada' }).waitFor()
await page.waitForTimeout(2200)
await shot(page, 'sala-resultado', true)
const roundRows = await page.locator('section[aria-labelledby="round-heading"] li').evaluateAll((items) =>
  items.map((item) => {
    const [, who, points] = [...item.querySelectorAll('span')].map((span) => span.textContent ?? '')
    return { who, points: Number(points.replace(/\D/g, '')) }
  }),
)
console.log(`  rodada: ${roundRows.map((row) => `${row.who} ${row.points}`).join(', ')}`)
assert.deepEqual(roundRows.map((row) => row.who).sort(), ['Ana', 'Beto', 'Luis'], 'a rodada deveria ter uma nota para cada pessoa')
const byName = Object.fromEntries(roundRows.map((row) => [row.who, row.points]))
assert.equal(roundRows[0].who, 'Ana', 'a Ana deveria ter vencido a rodada')
assert.ok(byName.Ana >= 7000, `a convidada afinada deveria passar de 7000 pontos (fez ${byName.Ana})`)
assert.ok(byName.Beto <= 2500, `o convidado desafinado deveria ficar abaixo de 2500 pontos (fez ${byName.Beto})`)
// A nota do host não é conferida aqui: o microfone simulado dele abriu num ponto qualquer do laço,
// então canta notas de outro trecho da música. O que importa é que ele tem a própria nota.
// A tela abre no resultado de quem venceu.
await page.getByText('1º lugar de 3').waitFor()

await ana.page.getByText('A maior nota da rodada').waitFor()
await beto.page.getByText(/Ana ficou na frente/).waitFor()
const anaFinal = Number(((await ana.page.locator('#pontos').textContent()) ?? '').replace(/\D/g, ''))
assert.equal(anaFinal, byName.Ana, 'o celular da Ana deveria mostrar a mesma nota que o host gravou')
await shot(ana.page, 'convidado-resultado')
await shot(beto.page, 'convidado-resultado-segundo')

await page.goto(`${BASE_URL}/musica/${songId}`)
await page.locator('a[href^="/resultado/"]').first().waitFor()
const historyText = (await page.locator('section[aria-labelledby="history-heading"]').textContent()) ?? ''
for (const who of ['Ana', 'Beto', 'Luis']) assert.ok(historyText.includes(`${who},`), `o histórico deveria dizer que ${who} cantou`)
console.log('  cada pessoa ganhou a própria nota, no host, no celular e no histórico')

step('Sala: fechar')
await page.goto(`${BASE_URL}/sala`)
await page.getByRole('button', { name: 'Fechar a sala' }).click()
await page.getByRole('button', { name: 'Abrir a sala' }).waitFor()
await ana.page.getByText('reconectando').waitFor({ timeout: 15_000 })
console.log('  sala fechada: os celulares perdem a conexão')
await ana.context.close()
await beto.context.close()

// ---------- 4d. Lista de músicas: exportar e abrir de volta ----------

step('Lista de músicas: exportar a biblioteca e abrir o arquivo de volta')
await page.goto(`${BASE_URL}/ajustes`)
const exportButton = page.getByRole('button', { name: 'Exportar a biblioteca' })
await exportButton.waitFor()
const exported = await exportBy(page, exportButton, 'lista', 'lista-exportada.json')
const listFile = exported.file
const listData = JSON.parse(readFileSync(listFile, 'utf8')) as { app: string; songs: Array<{ title: string; source: { type: string }; lyrics?: { lines: unknown[] } }>; playlists: unknown[] }
console.log(`  arquivo ${exported.suggested}: ${listData.songs.length} músicas, ${listData.songs.filter((s) => s.lyrics).length} com letra`)
assert.equal(listData.app, 'gogo-karaoke')
assert.ok(listData.songs.some((s) => s.title === 'Rua da Voz' && (s.lyrics?.lines.length ?? 0) === 6), 'a lista deveria levar a música de teste com as seis linhas da letra')

// Uma lista com uma música que já está aqui, uma que veio de arquivo e não está, e uma entrada quebrada.
const craftedFile = path.join(WORK_DIR, 'lista-montada.json')
writeFileSync(
  craftedFile,
  JSON.stringify({
    app: 'gogo-karaoke',
    kind: 'lista',
    version: 1,
    name: 'Lista de teste',
    songs: [listData.songs.find((s) => s.title === 'Rua da Voz'), { title: 'Música Que Não Existe Aqui', artist: 'Ninguém', duration: 100, source: { type: 'file', name: 'x.mp3' } }, { title: '' }],
    playlists: [{ name: 'Veio da lista', songs: [0, 1] }],
  }),
)
await page.goto(`${BASE_URL}/adicionar`)
await page.getByLabel('Arquivo exportado em outro aparelho').setInputFiles(craftedFile)
await page.waitForURL(`${BASE_URL}/adicionar/lista`)
await page.getByRole('heading', { name: 'Lista de teste' }).waitFor()
const listRows = page.locator('main ol > li')
assert.equal(await listRows.count(), 2, 'a entrada quebrada deveria ter ficado de fora')
await listRows.nth(0).getByText('Já estava na biblioteca.').waitFor()
await listRows.nth(1).getByText(/Veio de um arquivo do computador/).waitFor()
// O menu de cima leva à lista de qualquer tela, com a conta do que ainda não está na biblioteca.
await page.getByRole('navigation', { name: 'Principal' }).getByRole('link', { name: /^Para baixar\s*1$/ }).first().waitFor()
await settle(page, 300)
await shot(page, 'lista', true)

// A lista fica guardada: recarregar a página não a perde.
await page.reload()
await page.getByRole('heading', { name: 'Lista de teste' }).waitFor()
// A playlist que veio no arquivo foi montada com a música que já estava na biblioteca.
await page.goto(`${BASE_URL}/fila`)
await page.getByText('Veio da lista', { exact: true }).waitFor()
await page.getByRole('button', { name: /Excluir a playlist Veio da lista/ }).click()
await page.goto(`${BASE_URL}/adicionar`)
await page.getByText('Lista em andamento: Lista de teste').waitFor()
await page.getByRole('link', { name: /Abrir a lista/ }).click()
await page.getByRole('button', { name: 'Descartar a lista' }).click()
await page.getByRole('button', { name: 'Descartar', exact: true }).click()
await page.getByRole('heading', { name: 'Nenhuma lista aberta.' }).waitFor()
assert.equal(await page.getByRole('link', { name: /^Para baixar/ }).count(), 0, 'sem lista, o atalho do menu deveria sumir')
console.log('  exportada, reaberta, guardada entre recargas, playlist montada e lista descartada')

// ---------- 4e. Biblioteca: álbuns e playlists, menu do cartão, exportar ----------

step('Biblioteca: aba de álbuns e playlists, menu do cartão e exportar')
await page.goto(BASE_URL)
await page.getByRole('heading', { name: 'Biblioteca', exact: true }).waitFor()
await page.getByRole('radio', { name: 'Álbuns e playlists' }).click()
await page.getByText('Nenhuma playlist nem álbum ainda.').waitFor()
assert.match(page.url(), /aba=colecoes/, 'a aba deveria ficar no endereço, para o botão de voltar cair nela')
await page.getByRole('radio', { name: 'Músicas' }).click()

// Pelo menu do cartão: criar uma playlist com a música.
const cardTitle = ((await page.locator('article h3').first().textContent()) ?? '').trim()
const cardMenu = page.getByRole('button', { name: `Mais ações para ${cardTitle}` })
await cardMenu.click()
await page.getByRole('menuitem', { name: 'Adicionar a uma playlist' }).click()
const playlistDialog = page.getByRole('dialog')
await playlistDialog.getByLabel('Nome da playlist nova').fill('Minhas favoritas')
await playlistDialog.getByRole('button', { name: 'Criar' }).click()
await page.getByText(/entrou na playlist nova/).waitFor()

// Pelo menu do cartão: a lista de uma música só.
await cardMenu.click()
const oneExport = await exportBy(page, page.getByRole('menuitem', { name: 'Exportar esta música' }), 'lista', 'lista-uma-musica.json')
const oneData = JSON.parse(readFileSync(oneExport.file, 'utf8')) as { songs: Array<{ title: string }>; playlists: unknown[] }
assert.equal(oneData.songs.length, 1, 'a lista do cartão deveria ter só aquela música')
assert.equal(oneData.songs[0].title, cardTitle)

// Pelo botão do menu de cima: tudo, com as playlists.
const wholeExport = await exportBy(page, page.getByRole('button', { name: 'Exportar', exact: true }), 'lista', 'lista-biblioteca.json')
const wholeData = JSON.parse(readFileSync(wholeExport.file, 'utf8')) as { songs: unknown[]; playlists: Array<{ name: string }> }
const inLibraryNow = await page.locator('article').count()
assert.equal(wholeData.songs.length, inLibraryNow, 'a lista da biblioteca deveria ter todas as músicas')
assert.ok(wholeData.playlists.some((p) => p.name === 'Minhas favoritas'), 'a lista da biblioteca deveria levar as playlists')

// A playlist aparece na aba, e a página dela faz o que promete.
await page.getByRole('radio', { name: 'Álbuns e playlists' }).click()
await page.getByRole('heading', { name: /^Playlists/ }).waitFor()
await settle(page, 400)
await shot(page, 'biblioteca-colecoes', true)
await page.getByRole('link', { name: 'Abrir Minhas favoritas' }).click()
await page.waitForURL(/\/colecao\/p-/)
await page.getByRole('heading', { name: 'Minhas favoritas' }).waitFor()
assert.equal(await page.locator('main ol > li').count(), 1)
const collectionExport = await exportBy(page, page.getByRole('button', { name: 'Exportar playlist' }), 'lista', 'lista-playlist.json')
const collectionData = JSON.parse(readFileSync(collectionExport.file, 'utf8')) as { name: string; songs: unknown[]; playlists: Array<{ name: string }> }
assert.equal(collectionData.name, 'Minhas favoritas')
assert.equal(collectionData.songs.length, 1)
await settle(page, 300)
await shot(page, 'colecao', true)

await page.getByRole('button', { name: 'Pôr na fila', exact: true }).click()
await page.getByRole('link', { name: /^Fila\s*1$/ }).first().waitFor()
// "Cantar agora" põe o conjunto na frente da fila e abre o palco na primeira música.
await page.getByRole('button', { name: 'Cantar agora' }).click()
await page.waitForURL(/\/cantar\//)
await page.goBack()
await page.getByRole('heading', { name: 'Minhas favoritas' }).waitFor()
await page.getByRole('link', { name: /^Fila\s*2$/ }).first().waitFor()

await page.getByRole('button', { name: /^Tirar .+ desta playlist$/ }).click()
await page.getByText(/Dá para excluí-la/).waitFor()
await page.getByRole('button', { name: 'Excluir', exact: true }).click()
await page.getByRole('dialog').getByRole('button', { name: 'Excluir', exact: true }).click()
await page.waitForURL(/aba=colecoes/)
await page.getByText('Nenhuma playlist nem álbum ainda.').waitFor()
await page.goto(`${BASE_URL}/fila`)
await page.getByRole('button', { name: 'Esvaziar' }).click()
console.log('  playlist criada pelo cartão, três listas exportadas (uma música, a biblioteca, a playlist), fila e exclusão funcionando')

// ---------- 4f. Pacote com as músicas completas, aberto em outro aparelho ----------

step('Pacote: exportar as músicas completas e abrir em outro aparelho, sem baixar nada')
await page.goto(BASE_URL)
await page.getByRole('heading', { name: 'Biblioteca', exact: true }).waitFor()
const packTitles = (await page.locator('article h3').allTextContents()).map((title) => title.trim())
// Uma playlist vai junto, para conferir que ela chega montada.
await page.getByRole('button', { name: `Mais ações para ${packTitles[0]}` }).click()
await page.getByRole('menuitem', { name: 'Adicionar a uma playlist' }).click()
await page.getByRole('dialog').getByLabel('Nome da playlist nova').fill('Vai no pacote')
await page.getByRole('dialog').getByRole('button', { name: 'Criar' }).click()
await page.getByText(/entrou na playlist nova/).waitFor()

const pack = await exportBy(page, page.getByRole('button', { name: 'Exportar', exact: true }), 'completo', 'biblioteca.gogo', 'exportar-dialogo')
const packBytes = statSync(pack.file).size
assert.match(pack.suggested, /^gogo-minha-biblioteca-\d{4}-\d{2}-\d{2}\.gogo$/)
assert.equal(readFileSync(pack.file).subarray(0, 8).toString('latin1'), 'GOGOPKG1', 'o arquivo deveria ser um pacote do app')
const mediaBytes = statSync(song.songPath).size + (video ? statSync(video).size : 0)
assert.ok(packBytes > mediaBytes, 'o pacote deveria conter os arquivos das músicas inteiros')
console.log(`  pacote ${pack.suggested}: ${(packBytes / 1024 / 1024).toFixed(1)} MB, ${packTitles.length} músicas`)

// O "outro aparelho": outro navegador, com a biblioteca vazia.
const other = await launch({ profile: 'outro-aparelho', micFile: tunedMic })
await prepare(other.context)
const otherHeavy: string[] = []
const otherWorkers: string[] = []
other.page.on('request', (request) => {
  if (HEAVY_REQUEST.test(request.url())) otherHeavy.push(request.url())
})
// A análise da melodia roda num worker: se o guia veio no pacote, nenhum é criado.
other.page.on('worker', (worker) => otherWorkers.push(worker.url()))
await other.page.goto(`${BASE_URL}/adicionar`)
const packStarted = Date.now()
await other.page.getByLabel('Arquivo exportado em outro aparelho').setInputFiles(pack.file)
const otherTray = other.page.locator('section[aria-label="Importações"]')
await otherTray.getByText(/chegaram prontas|Chegou pronta/).waitFor({ timeout: 60_000 })
const packTook = Date.now() - packStarted
await settle(other.page, 300)
await shot(other.page, 'pacote-aberto')

await other.page.goto(BASE_URL)
await other.page.getByRole('heading', { name: 'Biblioteca', exact: true }).waitFor()
const arrived = (await other.page.locator('article h3').allTextContents()).map((title) => title.trim())
assert.deepEqual(arrived, packTitles, 'as músicas deveriam chegar todas, na mesma ordem')
const otherHref = await other.page.locator('article').filter({ hasText: 'Rua da Voz' }).locator('a[href^="/musica/"]').first().getAttribute('href')
const otherId = otherHref!.split('/').pop()!
assert.notEqual(otherId, songId, 'no outro aparelho a música ganha identificador próprio')
await other.page.goto(`${BASE_URL}/musica/${otherId}`)
await other.page.getByText('Guia extraído do áudio').waitFor()
await other.page.getByText('Sincronizada por linha').waitFor()
assert.deepEqual(otherHeavy, [], 'abrir o pacote não deveria baixar, separar, medir nem buscar letra')
assert.deepEqual(otherWorkers, [], 'o guia de notas veio no pacote: nada deveria ser analisado de novo')

// A prova de que chegou tudo certo: quem canta afinado tira nota alta com o guia que veio no pacote.
const otherPoints = await sing(other.page, otherId, 'outro-aparelho')
assert.ok(otherPoints >= 7000, `a música que veio no pacote deveria pontuar como a original (fez ${otherPoints})`)

await other.page.goto(BASE_URL)
await other.page.getByRole('radio', { name: 'Álbuns e playlists' }).click()
await other.page.getByRole('link', { name: 'Abrir Vai no pacote' }).waitFor()

// Abrir o mesmo pacote de novo não duplica nada. Desta vez pela entrada de arquivos comum (a mesma de
// quando se solta o arquivo na janela): o app reconhece o pacote pelo nome e não o trata como música.
await other.page.goto(`${BASE_URL}/adicionar`)
await other.page.locator('input[type=file]').first().setInputFiles(pack.file)
await otherTray.getByText(/já estav(a|am) na biblioteca/).waitFor({ timeout: 30_000 })
await other.page.goto(BASE_URL)
await other.page.getByRole('heading', { name: 'Biblioteca', exact: true }).waitFor()
assert.equal(await other.page.locator('article').count(), packTitles.length, 'abrir o pacote duas vezes não deveria repetir as músicas')
await other.context.close()
console.log(`  ${arrived.length} músicas e a playlist chegaram em ${(packTook / 1000).toFixed(1)} s, sem download, separação, análise nem busca de letra; cantada lá: ${otherPoints} pontos`)

await page.goto(`${BASE_URL}/fila`)
await page.getByRole('button', { name: /Excluir a playlist Vai no pacote/ }).click()

// ---------- 5. Editor de sincronia ----------

step('Editor: colar a letra e marcar as linhas com a barra de espaço')
const editorSong = videoId ?? songId
await page.goto(`${BASE_URL}/musica/${editorSong}/letra`)
await page.getByRole('heading', { name: 'Sincronizar letra' }).waitFor()
if (videoId) {
  await page.getByLabel('Letra da música').fill('Primeira linha do teste\nSegunda linha do teste\nTerceira linha do teste')
  await shot(page, 'editor-texto')
  await page.getByRole('button', { name: 'Continuar para a sincronia' }).click()
  await page.getByRole('button', { name: 'Tocar', exact: true }).click()
  for (let i = 0; i < 3; i++) {
    await page.waitForTimeout(900)
    // O foco ficou no botão de tocar: o espaço precisa marcar a linha, não pausar.
    await page.keyboard.press('Space')
  }
  await page.getByText('3 de 3 linhas com tempo.').waitFor()
  await settle(page, 300)
  await shot(page, 'editor')
  await page.getByRole('button', { name: 'Salvar letra' }).click()
  await page.waitForURL(new RegExp(`/musica/${videoId}$`))
  await page.getByText('Sincronizada por linha').waitFor()
  console.log('  três linhas marcadas e salvas')
} else {
  await settle(page)
  await shot(page, 'editor')
}

// ---------- 6. YouTube e banco de letras (dependem de rede) ----------

// A busca direta no banco de letras carrega um módulo do app pelo endereço, o que só o servidor de
// desenvolvimento permite. Na versão pronta, a mesma busca é exercitada adiante, pela tela.
if (!offline && devMode) {
  step('Banco de letras: busca real a partir do navegador')
  const lyrics = await page.evaluate(async () => {
    const path = '/src/lib/lrclib.ts'
    const api = (await import(/* @vite-ignore */ path)) as typeof import('../src/lib/lrclib.ts')
    const query = { title: 'Evidências', artist: 'Chitãozinho & Xororó', duration: 281 }
    const matches = await api.searchLyrics(query)
    const choice = api.pickAutomatic(matches, query)
    const doc = choice ? await api.recordToDoc(choice.match.record, 'teste', query.duration) : null
    const firstPlain = matches.findIndex((m) => !m.synced)
    return {
      found: matches.length,
      distinct: api.distinctMatches(matches).filter((m) => m.synced).length,
      syncedFirst: firstPlain === -1 || firstPlain > matches.map((m) => m.synced).lastIndexOf(true),
      chosenSynced: choice?.match.synced ?? false,
      confident: choice?.confident ?? false,
      level: doc?.level,
      lines: doc?.lines.length ?? 0,
    }
  })
  console.log(`  ${lyrics.found} registros, ${lyrics.distinct} sincronias distintas; aplicada sozinha: ${lyrics.level}, ${lyrics.lines} linhas`)
  assert.ok(lyrics.syncedFirst, 'nenhuma letra só de texto deveria vir antes de uma sincronizada')
  assert.ok(lyrics.chosenSynced && lyrics.confident && lyrics.level !== 'plain' && lyrics.lines > 20, 'a escolha automática deveria ser uma letra sincronizada')
  assert.ok(lyrics.distinct < lyrics.found, 'as cópias da mesma sincronia deveriam ser agrupadas')
}

if (!offline) {
  step('YouTube: busca pela interface')
  await page.goto(`${BASE_URL}/adicionar`)
  const field = page.getByLabel('Nome da música ou link do vídeo')
  await field.waitFor()
  await page.waitForFunction(() => !document.querySelector<HTMLInputElement>('input[type=search]')?.disabled, null, { timeout: 30_000 })
  await field.fill('Queen Bohemian Rhapsody')
  await page.getByRole('button', { name: 'Buscar' }).click()
  await page.getByRole('button', { name: 'Baixar' }).first().waitFor({ timeout: 60_000 })
  await page.waitForTimeout(3500)
  const results = await page.getByRole('button', { name: 'Baixar' }).count()
  const withLyrics = await page.getByText('letra com esta duração').count()
  const unknown = await page.getByText('sem letra conhecida').count()
  await shot(page, 'adicionar-busca', true)
  const showAllButton = page.getByRole('button', { name: 'Mostrar todos' })
  let total = results
  if (await showAllButton.isVisible()) {
    await showAllButton.click()
    await page.waitForTimeout(300)
    total = await page.getByRole('button', { name: 'Baixar' }).count()
  }
  console.log(`  com o filtro: ${results} vídeos (${withLyrics} com letra da mesma duração); sem o filtro: ${total}`)
  assert.equal(unknown, 0, 'com o filtro ligado não deveria aparecer vídeo sem letra')
  assert.ok(results >= 1 && results <= total, 'o filtro deveria mostrar parte dos vídeos, nunca mais do que a busca trouxe')

  step('Spotify: o link de uma playlist pública vira uma lista de faixas')
  await field.fill('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M')
  await page.getByRole('button', { name: 'Buscar' }).click()
  await page.waitForURL(`${BASE_URL}/adicionar/lista`, { timeout: 60_000 })
  await page.getByText('Playlist do Spotify').waitFor()
  const spotifyName = (await page.getByRole('heading', { level: 1 }).textContent()) ?? ''
  const spotifyTracks = await page.locator('main ol > li').count()
  console.log(`  "${spotifyName}": ${spotifyTracks} faixas`)
  assert.ok(spotifyTracks >= 10, 'a playlist deveria trazer as faixas')
  // Escolher o vídeo de uma faixa à mão: a busca traz candidatos, do mais ao menos parecido.
  await page.locator('main ol > li').first().getByRole('button', { name: 'Escolher vídeo' }).click()
  const chooser = page.getByRole('dialog')
  await chooser.getByRole('button', { name: 'Usar este' }).first().waitFor({ timeout: 60_000 })
  const candidates = await chooser.getByRole('button', { name: 'Usar este' }).count()
  const firstCandidate = (await chooser.locator('li p').first().textContent()) ?? ''
  console.log(`  ${candidates} vídeos candidatos para a primeira faixa; o mais parecido: ${firstCandidate.slice(0, 70)}`)
  await settle(page, 300)
  await shot(page, 'lista-escolher-video')
  await page.keyboard.press('Escape')
  await shot(page, 'lista-spotify', true)
  await page.getByRole('button', { name: 'Descartar a lista' }).click()
  await page.getByRole('button', { name: 'Descartar', exact: true }).click()
  await page.goto(`${BASE_URL}/adicionar`)
  await field.waitFor()
  await page.waitForFunction(() => !document.querySelector<HTMLInputElement>('input[type=search]')?.disabled, null, { timeout: 30_000 })

  step('Spotify: link de álbum vira lista, link de uma música vira busca')
  await field.fill('https://open.spotify.com/intl-pt/album/4m2880jivSbbyEGAKfITCa?si=teste')
  await page.getByRole('button', { name: 'Buscar' }).click()
  await page.waitForURL(`${BASE_URL}/adicionar/lista`, { timeout: 60_000 })
  await page.getByText('Álbum do Spotify').waitFor()
  const albumName = (await page.getByRole('heading', { level: 1 }).textContent()) ?? ''
  const albumTracks = await page.locator('main ol > li').count()
  console.log(`  álbum "${albumName}": ${albumTracks} faixas`)
  assert.match(albumName, /Random Access Memories, de Daft Punk/)
  assert.equal(albumTracks, 13, 'o álbum deveria trazer as treze faixas')
  await page.getByRole('button', { name: 'Descartar a lista' }).click()
  await page.getByRole('button', { name: 'Descartar', exact: true }).click()
  await page.goto(`${BASE_URL}/adicionar`)
  await field.waitFor()
  await page.waitForFunction(() => !document.querySelector<HTMLInputElement>('input[type=search]')?.disabled, null, { timeout: 30_000 })

  await field.fill('https://open.spotify.com/track/11hcBLPtbMp4aQI6zGQLub')
  await page.getByRole('button', { name: 'Buscar' }).click()
  await page.getByRole('button', { name: 'Baixar' }).first().waitFor({ timeout: 60_000 })
  // O campo passa a mostrar o nome da música que o link apontava: é por ele que a busca foi feita.
  const trackQuery = await field.inputValue()
  console.log(`  o link de uma música virou a busca "${trackQuery}", com ${await page.getByRole('button', { name: 'Baixar' }).count()} vídeos`)
  assert.ok(trackQuery.length > 3 && !trackQuery.includes('spotify'), 'o link deveria ter sido trocado pelo nome da música')

  step('YouTube: download real (curta de animação em Creative Commons)')
  await field.fill('https://www.youtube.com/watch?v=YE7VzlLtp-4')
  await page.getByRole('button', { name: 'Buscar' }).click()
  await page.getByText('Big Buck Bunny').first().waitFor({ timeout: 60_000 })
  await page.getByRole('button', { name: 'Baixar' }).click()
  await page.waitForTimeout(1500)
  await shot(page, 'adicionar-baixando')
  await waitImported(page, 240_000)
  await settle(page)
  await shot(page, 'adicionar-pronta')
  await page.goto(BASE_URL)
  await page.getByText('Big Buck Bunny').first().waitFor()
  console.log('  baixada, guardada no navegador e analisada (10 minutos de áudio)')

  step('Tela de escolha da letra: sincronizadas primeiro, uma linha por sincronia')
  const downloaded = await page.locator('article a[href^="/musica/"]').first().getAttribute('href')
  await page.goto(`${BASE_URL}${downloaded}`)
  await page.getByRole('button', { name: 'Editar dados' }).click()
  await page.getByLabel('Música', { exact: true }).fill('Evidências')
  await page.getByLabel('Artista', { exact: true }).fill('Chitãozinho & Xororó')
  await page.getByRole('button', { name: 'Salvar' }).click()
  await page.getByRole('button', { name: 'Buscar letra' }).click()
  const picker = page.getByRole('dialog')
  await picker.getByText(/A voz entra aos/).first().waitFor({ timeout: 90_000 })
  const options = await picker.getByText(/A voz entra aos/).count()
  const order = await picker.evaluate((el) => {
    const text = el.textContent ?? ''
    return { lastSynced: text.lastIndexOf('A voz entra aos'), plain: text.indexOf('Sem sincronia') }
  })
  console.log(`  ${options} sincronias distintas na tela`)
  assert.ok(options >= 2 && options <= 8, 'a tela deveria mostrar poucas opções distintas, não todas as cópias')
  assert.ok(order.plain === -1 || order.plain > order.lastSynced, 'as letras sem sincronia deveriam ficar depois das sincronizadas')
  await settle(page, 400)
  await shot(page, 'musica-escolher-letra')
  await picker.getByRole('button', { name: 'Usar' }).first().click()
  await page.getByText('Sincronizada por linha').waitFor({ timeout: 30_000 })
  await page.getByRole('button', { name: 'Buscar letra' }).click()
  await page.getByRole('dialog').getByText('Em uso').waitFor({ timeout: 90_000 })
  console.log('  a sincronia escolhida fica marcada como em uso')
  await page.keyboard.press('Escape')

  step('Outro aparelho: exportar, apagar a música e baixá-la de novo pela lista')
  const movedId = downloaded!.split('/').pop()!
  await page.goto(`${BASE_URL}/ajustes`)
  const exportAgain = page.getByRole('button', { name: 'Exportar a biblioteca' })
  await exportAgain.waitFor()
  const movedFile = (await exportBy(page, exportAgain, 'lista', 'lista-outro-aparelho.json')).file
  // Mais uma música na lista (licença livre), para as duas baixarem ao mesmo tempo.
  const movedData = JSON.parse(readFileSync(movedFile, 'utf8')) as { songs: unknown[] }
  movedData.songs.push({
    title: 'Code Monkey',
    artist: 'Jonathan Coulton',
    duration: 190,
    mediaKind: 'audio',
    source: { type: 'youtube', url: 'https://www.youtube.com/watch?v=6J-W3mn9N2w', videoId: '6J-W3mn9N2w' },
    lyricOffset: 0,
  })
  writeFileSync(movedFile, JSON.stringify(movedData))
  await page.goto(`${BASE_URL}/musica/${movedId}`)
  await page.getByRole('button', { name: 'Excluir' }).click()
  await page.getByRole('button', { name: 'Excluir música' }).click()
  await page.waitForURL(`${BASE_URL}/`)

  await page.goto(`${BASE_URL}/adicionar`)
  await page.getByLabel('Arquivo exportado em outro aparelho').setInputFiles(movedFile)
  await page.waitForURL(`${BASE_URL}/adicionar/lista`)
  const missing = page.locator('main ol > li').filter({ hasText: 'Evidências' })
  await missing.getByText('Na fila para baixar.').waitFor()
  const other = page.locator('main ol > li').filter({ hasText: 'Code Monkey' })
  await page.getByRole('button', { name: /^Baixar as 2 que faltam$/ }).click()
  // As duas andam juntas: não é uma depois da outra.
  await page.waitForFunction(() => [...document.querySelectorAll('main ol > li')].filter((li) => li.textContent?.includes('Baixando e preparando')).length >= 2, null, { timeout: 60_000 })
  await page.locator('section[aria-label="Importações"]').getByText('2 em andamento').waitFor({ timeout: 30_000 })
  console.log('  as duas músicas da lista ficaram em andamento ao mesmo tempo')
  await missing.getByText('Pronta para cantar.').waitFor({ timeout: 300_000 })
  await other.getByText('Pronta para cantar.').waitFor({ timeout: 300_000 })
  await settle(page, 400)
  await shot(page, 'lista-baixada', true)
  await missing.getByRole('link', { name: 'Abrir' }).click()
  // Nome, artista e letra vieram da lista: nada foi procurado de novo.
  await page.getByRole('heading', { name: 'Evidências' }).waitFor()
  await page.getByText('Sincronizada por linha').waitFor({ timeout: 30_000 })
  console.log('  a música voltou com o nome, o artista e a letra que estavam na lista')
  // A segunda música sai da biblioteca: mais adiante ela é baixada de novo, com a voz separada.
  await page.goto(`${BASE_URL}/adicionar/lista`)
  await other.getByRole('link', { name: 'Abrir' }).click()
  await page.getByRole('heading', { name: 'Code Monkey' }).waitFor()
  await page.getByRole('button', { name: 'Excluir' }).click()
  await page.getByRole('button', { name: 'Excluir música' }).click()
  await page.waitForURL(`${BASE_URL}/`)
  await page.goto(`${BASE_URL}/adicionar/lista`)
  await page.getByRole('button', { name: 'Descartar a lista' }).click()
  await page.getByRole('button', { name: 'Descartar', exact: true }).click()

  step('Download que falha: três tentativas, com aviso no painel')
  // Uma lista cujo vídeo não existe: o YouTube recusa, e o app tem de insistir antes de desistir.
  const deadFile = path.join(WORK_DIR, 'lista-video-inexistente.json')
  writeFileSync(
    deadFile,
    JSON.stringify({
      app: 'gogo-karaoke',
      kind: 'lista',
      version: 1,
      name: 'Lista com vídeo que não existe',
      songs: [{ title: 'Vídeo que não existe', artist: 'Ninguém', duration: 100, mediaKind: 'audio', source: { type: 'youtube', url: 'https://www.youtube.com/watch?v=GoGoNaoExi0', videoId: 'GoGoNaoExi0' }, lyricOffset: 0 }],
      playlists: [],
    }),
  )
  await page.goto(`${BASE_URL}/adicionar`)
  await page.getByLabel('Arquivo exportado em outro aparelho').setInputFiles(deadFile)
  await page.waitForURL(`${BASE_URL}/adicionar/lista`)
  const dead = page.locator('main ol > li').first()
  await dead.getByText('Na fila para baixar.').waitFor()
  const importTray = page.locator('section[aria-label="Importações"]')
  const beganAt = Date.now()
  await page.getByRole('button', { name: /^Baixar a que falta$/ }).click()
  await importTray.getByText(/tentativa 2 de 3/).waitFor({ timeout: 60_000 })
  const secondAt = Date.now() - beganAt
  await shot(page, 'lista-tentativa-2')
  await importTray.getByText(/tentativa 3 de 3/).waitFor({ timeout: 60_000 })
  await dead.getByRole('button', { name: 'Tentar de novo' }).waitFor({ timeout: 60_000 })
  const gaveUpAt = Date.now() - beganAt
  const deadText = ((await dead.locator('p').nth(2).textContent()) ?? '').trim()
  console.log(`  segunda tentativa aos ${(secondAt / 1000).toFixed(1)} s, desistiu aos ${(gaveUpAt / 1000).toFixed(1)} s: "${deadText}"`)
  // Do aviso da segunda tentativa até desistir cabem as duas esperas (2 s e 4 s) e duas tentativas.
  assert.ok(gaveUpAt - secondAt >= 6000, 'o app deveria esperar entre as tentativas antes de desistir')
  assert.match(deadText, /não está disponível no YouTube/, 'a linha deveria dizer por que falhou')
  await importTray.getByText('1 com falha').waitFor()
  // O vídeo da lista saiu do ar: dá para escolher outro no lugar.
  await dead.getByRole('button', { name: 'Trocar vídeo' }).waitFor()
  await page.getByRole('button', { name: 'Descartar a lista' }).click()
  await page.getByRole('button', { name: 'Descartar', exact: true }).click()
}

// ---------- 6b. Música real com separação de voz ----------

const helper = (await (await fetch(`${HELPER_API}/status`)).json().catch(() => null)) as { separator?: { installed: boolean }; aligner?: { installed: boolean }; ffmpeg?: unknown } | null
if (!offline && helper?.separator?.installed && helper.ffmpeg) {
  step('Música real (licença livre) com separação de voz, guia pela voz e letra conferida pelo áudio')
  await page.goto(`${BASE_URL}/ajustes`)
  const separateSwitch = page.getByRole('switch', { name: 'Separar a voz ao adicionar músicas' })
  await separateSwitch.click()
  assert.equal(await separateSwitch.getAttribute('aria-checked'), 'true')

  await page.goto(`${BASE_URL}/adicionar`)
  const link = page.getByLabel('Nome da música ou link do vídeo')
  await page.waitForFunction(() => !document.querySelector<HTMLInputElement>('input[type=search]')?.disabled, null, { timeout: 30_000 })
  // "Code Monkey", de Jonathan Coulton: Creative Commons BY-NC.
  await link.fill('https://www.youtube.com/watch?v=6J-W3mn9N2w')
  await page.getByRole('button', { name: 'Buscar' }).click()
  await page.getByRole('button', { name: 'Baixar' }).waitFor({ timeout: 60_000 })
  await page.getByRole('button', { name: 'Baixar' }).click()
  await page.getByText('Separando a voz do instrumental').waitFor({ timeout: 120_000 })
  await shot(page, 'adicionar-separando')
  await waitImported(page, 300_000)
  const importNote = (await page.locator('section[aria-label="Importações"] li p').last().textContent()) ?? ''
  console.log(`  aviso da importação: ${importNote}`)
  // A letra veio sincronizada do banco: é conferida, mas não medida no áudio por conta própria.
  assert.match(importNote, /conferida com o áudio|sincronia que encaixa/, 'a letra deveria ter sido conferida contra a voz separada, sem ser medida sozinha')

  await page.goto(BASE_URL)
  await page.getByText('Code Monkey').first().waitFor()
  const realHref = await page.locator('article a[href^="/musica/"]').first().getAttribute('href')
  const realId = realHref!.split('/').pop()!
  await page.goto(`${BASE_URL}/musica/${realId}`)
  await page.getByText('Voz separada do instrumental').waitFor({ timeout: 30_000 })
  await page.getByText('Guia tirado da voz separada').waitFor()
  await settle(page)
  await shot(page, 'musica-voz-separada', true)

  if (helper.aligner?.installed) {
    await page.getByText('Sincronizada por linha').waitFor()
    // À mão: o botão da página da música.
    await page.getByRole('button', { name: 'Sincronizar pelo áudio' }).click()
    await page.getByText('Sincronizada pelo áudio', { exact: true }).waitFor({ timeout: 180_000 })
    // Os tempos por palavra têm de estar em ordem, e dentro da música.
    const timing = await page.evaluate(async (id) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('gogo')
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      const doc = await new Promise<{ timing?: string; lines: Array<{ start: number; end: number; words: Array<{ start: number; end: number }> }>; previous?: { lines: Array<{ start: number }>; lyricOffset: number } } | undefined>((resolve, reject) => {
        const request = db.transaction('lyrics').objectStore('lyrics').get(id)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      if (!doc) return null
      let ordered = true
      let last = -1
      for (const line of doc.lines) {
        if (line.start < last - 0.01) ordered = false
        last = line.start
        for (let w = 1; w < line.words.length; w++) if (line.words[w].start < line.words[w - 1].start - 0.01) ordered = false
      }
      const moved = doc.previous ? doc.lines.map((line, i) => Math.abs(line.start - (doc.previous!.lines[i].start + doc.previous!.lyricOffset))).sort((a, b) => a - b) : []
      return { timing: doc.timing, lines: doc.lines.length, ordered, words: doc.lines.reduce((sum, line) => sum + line.words.length, 0), medianMove: moved[moved.length >> 1] ?? null, worstMove: moved[moved.length - 1] ?? null }
    }, realId)
    assert.ok(timing, 'a letra deveria estar guardada')
    console.log(`  letra medida no áudio: ${timing.lines} linhas, ${timing.words} palavras; em relação à sincronia original, metade das linhas mexeu até ${timing.medianMove?.toFixed(2)} s e a que mais mexeu, ${timing.worstMove?.toFixed(2)} s`)
    assert.equal(timing.timing, 'audio')
    assert.ok(timing.ordered, 'linhas e palavras deveriam estar em ordem no tempo')
    assert.ok(timing.medianMove !== null && timing.medianMove < 0.6, 'a sincronia medida não deveria fugir muito da feita à mão nesta gravação')

    await page.getByRole('button', { name: 'Voltar à sincronia anterior' }).click()
    await page.getByText('Sincronizada por linha').waitFor()
    await page.getByRole('button', { name: 'Sincronizar pelo áudio' }).waitFor()
    console.log('  com letra sincronizada, a medição só rodou a pedido; desfazer volta para a sincronia original')

    // Sozinha: quando a letra chega só em texto, sem tempos.
    const plainText = await page.evaluate(async (id) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('gogo')
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      const doc = await new Promise<{ lines: Array<{ text: string }> } | undefined>((resolve, reject) => {
        const request = db.transaction('lyrics').objectStore('lyrics').get(id)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      return (doc?.lines ?? []).map((line) => line.text).join('\n')
    }, realId)
    await page.locator('input[type=file][accept*=".lrc"]').setInputFiles({ name: 'letra.txt', mimeType: 'text/plain', buffer: Buffer.from(plainText, 'utf8') })
    await page.getByText('Sincronizada pelo áudio', { exact: true }).waitFor({ timeout: 180_000 })
    console.log('  letra importada só em texto: os tempos saíram do áudio sem ninguém pedir')
  }

  await page.goto(`${BASE_URL}/cantar/${realId}`)
  await page.getByRole('button', { name: 'Tocar sem pontuar' }).click()
  await page.getByRole('button', { name: 'Pausar' }).waitFor()
  await page.waitForTimeout(8000)
  const tracks = await page.evaluate(() => {
    const [instrumental, vocals] = [...document.querySelectorAll('audio')]
    const video = document.querySelector('video')
    return {
      count: document.querySelectorAll('audio').length,
      playing: !!instrumental && !!vocals && !instrumental.paused && !vocals.paused,
      time: instrumental?.currentTime ?? 0,
      drift: instrumental && vocals ? Math.abs(instrumental.currentTime - vocals.currentTime) : 99,
      originalMuted: video?.muted ?? false,
    }
  })
  console.log(`  aos ${tracks.time.toFixed(1)} s: voz e instrumental a ${(tracks.drift * 1000).toFixed(0)} ms um do outro`)
  assert.equal(tracks.count, 2, 'o palco deveria tocar as duas faixas separadas')
  assert.ok(tracks.playing && tracks.time > 5, 'as duas faixas deveriam estar tocando')
  assert.ok(tracks.drift < 0.06, `voz e instrumental deveriam andar juntos (estão a ${tracks.drift.toFixed(3)} s)`)
  assert.ok(tracks.originalMuted, 'o arquivo original deveria estar mudo quando há faixas separadas')

  await page.mouse.move(600, 500)
  await page.getByRole('button', { name: 'Tirar a voz original' }).click()
  await page.getByRole('button', { name: 'Voltar a voz original' }).waitFor()
  await settle(page, 400)
  await shot(page, 'palco-sem-voz-original')
  await page.getByRole('button', { name: 'Voltar a voz original' }).click()
  console.log('  o botão de voz original liga e desliga a faixa de voz')

  step('Pacote com música de verdade: a voz separada e a letra medida chegam prontas no outro aparelho')
  await page.goto(BASE_URL)
  await page.getByText('Code Monkey').first().waitFor()
  await page.getByRole('button', { name: 'Mais ações para Code Monkey' }).click()
  const realPack = await exportBy(page, page.getByRole('menuitem', { name: 'Exportar esta música' }), 'completo', 'code-monkey.gogo')
  const realBytes = statSync(realPack.file).size

  const there = await launch({ profile: 'outro-aparelho', micFile: tunedMic })
  await prepare(there.context)
  const thereHeavy: string[] = []
  const thereWorkers: string[] = []
  there.page.on('request', (request) => {
    if (HEAVY_REQUEST.test(request.url())) thereHeavy.push(request.url())
  })
  there.page.on('worker', (worker) => thereWorkers.push(worker.url()))
  await there.page.goto(`${BASE_URL}/adicionar`)
  const realStarted = Date.now()
  await there.page.getByLabel('Arquivo exportado em outro aparelho').setInputFiles(realPack.file)
  const thereTray = there.page.locator('section[aria-label="Importações"]')
  await thereTray.getByText('Chegou pronta, sem baixar nada.').waitFor({ timeout: 60_000 })
  const realTook = Date.now() - realStarted
  // Pacote de uma música só: o painel já oferece cantar.
  const thereHref = await thereTray.getByRole('link', { name: 'Cantar' }).getAttribute('href')
  const thereId = thereHref!.split('/').pop()!
  await there.page.goto(`${BASE_URL}/musica/${thereId}`)
  await there.page.getByRole('heading', { name: 'Code Monkey' }).waitFor()
  await there.page.getByText('Voz separada do instrumental').waitFor({ timeout: 30_000 })
  await there.page.getByText('Guia tirado da voz separada').waitFor()
  await there.page.getByText('Sincronizada pelo áudio', { exact: true }).waitFor()
  // A sincronia de antes da medição veio junto: dá para desfazer lá também.
  await there.page.getByRole('button', { name: 'Voltar à sincronia anterior' }).waitFor()
  await there.page.locator('main img').first().waitFor()
  assert.deepEqual(thereHeavy, [], 'abrir o pacote não deveria baixar, separar, medir nem buscar letra ou capa')
  assert.deepEqual(thereWorkers, [], 'o guia de notas veio no pacote: nada deveria ser analisado de novo')

  await there.page.goto(`${BASE_URL}/cantar/${thereId}`)
  await there.page.getByRole('button', { name: 'Tocar sem pontuar' }).click()
  await there.page.getByRole('button', { name: 'Pausar' }).waitFor()
  await there.page.waitForTimeout(6000)
  const thereTracks = await there.page.evaluate(() => {
    const [instrumental, vocals] = [...document.querySelectorAll('audio')]
    return {
      count: document.querySelectorAll('audio').length,
      playing: !!instrumental && !!vocals && !instrumental.paused && !vocals.paused,
      time: instrumental?.currentTime ?? 0,
      drift: instrumental && vocals ? Math.abs(instrumental.currentTime - vocals.currentTime) : 99,
    }
  })
  assert.equal(thereTracks.count, 2, 'no outro aparelho o palco deveria tocar as duas faixas separadas')
  assert.ok(thereTracks.playing && thereTracks.time > 3, 'as duas faixas deveriam estar tocando')
  assert.ok(thereTracks.drift < 0.06, `voz e instrumental deveriam andar juntos (estão a ${thereTracks.drift.toFixed(3)} s)`)
  await there.context.close()
  console.log(`  pacote de ${(realBytes / 1024 / 1024).toFixed(1)} MB aberto em ${(realTook / 1000).toFixed(1)} s: voz separada, guia e letra medida no áudio, sem nenhum pedido ao ajudante nem ao banco de letras`)

  await page.goto(`${BASE_URL}/ajustes`)
  await page.getByRole('switch', { name: 'Separar a voz ao adicionar músicas' }).click()
} else if (!offline) {
  console.log('\n> Separador de voz não instalado: a parte de separação foi pulada')
}

// ---------- 7. Capturas das demais telas, tema claro e celular ----------

step('Capturas: biblioteca, ajustes, tema claro e celular')
await page.goto(BASE_URL)
await page.getByRole('heading', { name: 'Biblioteca', exact: true }).waitFor()
await settle(page, 1200)
await shot(page, 'biblioteca', true)
await page.goto(`${BASE_URL}/adicionar`)
await page.getByRole('heading', { name: 'Adicionar música' }).waitFor()
await settle(page, 2500)
await shot(page, 'adicionar')
await page.goto(`${BASE_URL}/ajustes`)
await page.getByRole('heading', { name: 'Ajustes' }).waitFor()
await settle(page, 2500)
await shot(page, 'ajustes', true)

await page.getByRole('radio', { name: 'Claro' }).click()
await settle(page, 400)
await shot(page, 'ajustes-claro', true)
await page.goto(BASE_URL)
await page.getByRole('heading', { name: 'Biblioteca', exact: true }).waitFor()
await settle(page, 1200)
await shot(page, 'biblioteca-claro', true)
await page.goto(`${BASE_URL}/musica/${songId}`)
await page.getByText('Guia extraído do áudio').waitFor()
await settle(page)
await shot(page, 'musica-claro', true)
await page.locator('a[href^="/resultado/"]').first().click()
await page.locator('[aria-label$=" pontos"]').waitFor()
await settle(page, 2200)
await shot(page, 'resultado-claro', true)
await page.getByRole('button', { name: 'Ver em lista' }).click()
await settle(page, 300)
await shot(page, 'resultado-lista-claro', true)

await page.setViewportSize({ width: 390, height: 844 })
await page.goto(BASE_URL)
await page.getByRole('heading', { name: 'Biblioteca', exact: true }).waitFor()
await settle(page, 1200)
await shot(page, 'celular-biblioteca', true)
await page.goto(`${BASE_URL}/musica/${songId}`)
await page.getByText('Guia extraído do áudio').waitFor()
await settle(page)
await shot(page, 'celular-musica', true)
await page.goto(`${BASE_URL}/cantar/${songId}`)
await waitForMic(page)
await settle(page)
await shot(page, 'celular-palco-checagem')
await page.getByRole('button', { name: 'Tocar sem pontuar' }).click()
await page.getByRole('button', { name: 'Pausar' }).waitFor()
await page.waitForTimeout(3000)
await page.mouse.move(200, 400)
await settle(page, 300)
await shot(page, 'celular-palco')

// ---------- 8. Excluir ----------

if (videoId) {
  step('Excluindo o vídeo de teste')
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`${BASE_URL}/musica/${videoId}`)
  await page.getByRole('button', { name: 'Excluir' }).click()
  await page.getByRole('button', { name: 'Excluir música' }).click()
  await page.waitForURL(`${BASE_URL}/`)
  await page.getByRole('heading', { name: 'Biblioteca', exact: true }).waitFor()
  assert.equal(await page.locator(`a[href="/musica/${videoId}"]`).count(), 0, 'a música excluída não deveria mais aparecer')
  console.log('  excluída da biblioteca')
}
await session.context.close()
// Os perfis de navegador do teste passam de 150 MB: não ficam guardados.
rmSync(path.join(WORK_DIR, 'profiles'), { recursive: true, force: true })

// ---------- Veredito ----------

console.log(`\nAfinado: ${tuned} pontos. Desafinado: ${offKey} pontos.`)
assert.ok(tuned >= 7000, `quem canta as notas certas deveria passar de 7000 pontos (fez ${tuned})`)
assert.ok(offKey <= 2500, `quem canta fora do tom deveria ficar abaixo de 2500 pontos (fez ${offKey})`)
console.log('Teste de ponta a ponta passou.')
