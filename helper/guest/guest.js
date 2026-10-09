// Página do convidado da sala. JavaScript puro, servido direto pelo ajudante (sem build):
// o celular lê o tom da voz e manda para o host, que é quem pontua. Aqui a pessoa vê a letra
// andando palavra por palavra e a pista de tom com a própria voz, como na tela grande.

const $ = (id) => document.getElementById(id)
const screens = { entrar: $('tela-entrar'), microfone: $('tela-microfone'), palco: $('tela-palco') }

function show(screen) {
  for (const [name, element] of Object.entries(screens)) element.hidden = name !== screen
}

const NOTE_NAMES = ['Dó', 'Dó#', 'Ré', 'Ré#', 'Mi', 'Fá', 'Fá#', 'Sol', 'Sol#', 'Lá', 'Lá#', 'Si']
const noteName = (midi) => {
  const rounded = Math.round(midi)
  return `${NOTE_NAMES[((rounded % 12) + 12) % 12]}${Math.floor(rounded / 12) - 1}`
}

const REFUSALS = {
  'nome-em-uso': 'Já tem alguém na sala com esse nome. Escolha outro.',
  'nome-invalido': 'Escreva um nome para entrar.',
  'sem-host': 'Quem comanda as músicas não está com o app aberto. Você entra sozinho assim que ele voltar.',
  'sala-cheia': 'A sala está cheia.',
}

// ---------- estado ----------

// O identificador deixa este aparelho retomar o próprio nome se a conexão cair.
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`)

let deviceId = sessionStorage.getItem('gogo:id')
if (!deviceId) {
  deviceId = newId()
  sessionStorage.setItem('gogo:id', deviceId)
}

/** Canal aberto com a sala: { send(mensagem), close() }. */
let channel = null
/**
 * ws = WebSocket, o caminho normal. http = eventos e requisições comuns, para o celular que
 * recusa WebSocket com o certificado feito em casa. "?via=http" no endereço força o segundo.
 */
const forcedVia = new URLSearchParams(location.search).get('via')
let via = forcedVia === 'http' ? 'http' : 'ws'
let failures = 0
let name = sessionStorage.getItem('gogo:nome') ?? ''
let joined = false
let micOn = false
/** Diferença entre o relógio do host e o deste aparelho, em ms. */
let clockOffset = 0
let bestPing = Infinity

/**
 * O que o host disse por último sobre a música.
 * lines: [início, fim, texto, [[início, fim, palavra, colada], ...]]
 * notes: [início, fim, nota MIDI], as barras da pista de tom
 */
const stage = { phase: 'aguardando', lines: [], notes: [], latency: 0, tolerance: 1.7, time: 0, at: 0, playing: false }

// ---------- conexão ----------

function send(message) {
  if (channel) channel.send(message)
}

function openWebSocket(on) {
  const socket = new WebSocket(`wss://${location.host}/ws`)
  socket.addEventListener('open', on.open)
  socket.addEventListener('message', (event) => on.message(event.data))
  socket.addEventListener('close', on.close)
  return {
    send(message) {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
    },
    close() {
      socket.close()
    },
  }
}

function openHttp(on) {
  const id = newId()
  const events = new EventSource(`/eventos?c=${id}`)
  let open = false
  let closed = false
  const shut = () => {
    if (closed) return
    closed = true
    open = false
    events.close()
    on.close()
  }
  events.addEventListener('open', () => {
    open = true
    on.open()
  })
  events.addEventListener('message', (event) => on.message(event.data))
  // O EventSource tentaria voltar sozinho, mas a sala trata cada conexão como nova: recomeça do zero.
  events.addEventListener('error', shut)
  return {
    send(message) {
      if (!open) return
      fetch(`/mensagem?c=${id}`, { method: 'POST', body: JSON.stringify(message) }).then(
        (res) => {
          if (res.status === 410) shut()
        },
        () => {},
      )
    },
    close: shut,
  }
}

function setConnection(state) {
  const element = $('conexao')
  element.dataset.estado = state
  element.textContent = state === 'ok' ? 'conectado' : 'reconectando'
}

function connect() {
  let opened = false
  const mine = (via === 'http' ? openHttp : openWebSocket)({
    open() {
      if (channel !== mine) return
      opened = true
      failures = 0
      setConnection('ok')
      bestPing = Infinity
      send({ t: 'ping', c: Date.now() })
      if (name) send({ t: 'join', name, id: deviceId })
    },
    message(data) {
      try {
        handle(JSON.parse(data))
      } catch {
        // Mensagem que não é JSON: ignora.
      }
    },
    close() {
      if (channel !== mine) return
      channel = null
      joined = false
      setConnection('caiu')
      // Duas tentativas seguidas que nem chegaram a abrir: experimenta o outro jeito de conversar.
      if (!opened && !forcedVia && ++failures >= 2) {
        via = via === 'ws' ? 'http' : 'ws'
        failures = 0
      }
      setTimeout(connect, 1500)
    },
  })
  channel = mine
}

function handle(message) {
  if (message.t === 'pong') {
    // O acerto de relógio feito na ida e volta mais rápida é o mais confiável.
    const now = Date.now()
    const roundTrip = now - message.c
    if (roundTrip <= bestPing) {
      bestPing = roundTrip
      clockOffset = message.s - (message.c + roundTrip / 2)
    }
    return
  }

  if (message.t === 'joined') {
    joined = true
    name = message.name
    sessionStorage.setItem('gogo:nome', name)
    $('quem').textContent = name
    $('saudacao').textContent = `Olá, ${name}`
    return show(micOn ? 'palco' : 'microfone')
  }

  if (message.t === 'refused') {
    joined = false
    if (message.reason === 'sem-host' && name) {
      // Quem comanda as músicas ainda não voltou: guarda o nome e tenta de novo em instantes.
      setTimeout(() => {
        if (!joined && name) send({ t: 'join', name, id: deviceId })
      }, 2000)
      const waiting = $('erro-nome')
      waiting.textContent = REFUSALS['sem-host']
      waiting.hidden = false
      return
    }
    name = ''
    sessionStorage.removeItem('gogo:nome')
    const error = $('erro-nome')
    error.textContent = REFUSALS[message.reason] ?? 'Não deu para entrar na sala.'
    error.hidden = false
    return show('entrar')
  }

  if (message.t === 'state') {
    stage.phase = message.phase
    stage.lines = Array.isArray(message.lines) ? message.lines : []
    stage.notes = Array.isArray(message.notes) ? message.notes : []
    stage.latency = typeof message.latency === 'number' ? message.latency : 0
    stage.tolerance = typeof message.tolerance === 'number' ? message.tolerance : 1.7
    resetLyrics()

    if (message.phase === 'cantando' && message.song) {
      $('titulo').textContent = message.song.title
      $('artista').textContent = message.song.artist || ''
      $('pista').hidden = stage.notes.length === 0
      sizeLane()
      // `resume`: a mesma música continua (só a letra foi reajustada), então a nota fica.
      if (!message.resume) {
        stage.playing = false
        trail.length = 0
        $('pontos').textContent = '0'
        $('posicao').textContent = ''
      }
      return
    }

    stage.playing = false
    $('pista').hidden = true
    const notice = $('linha-atual')
    notice.classList.add('aviso')

    if (message.phase === 'resultado') {
      const ranked = [...(Array.isArray(message.results) ? message.results : [])].sort((a, b) => b.points - a.points)
      const mine = ranked.findIndex((entry) => entry.name === name)
      $('titulo').textContent = message.song?.title || 'Fim da música'
      $('artista').textContent = 'Fim da música'
      if (mine < 0) {
        $('pontos').textContent = '0'
        $('posicao').textContent = 'Você não cantou nesta música.'
        return
      }
      $('pontos').textContent = ranked[mine].points.toLocaleString('pt-BR')
      // A colocação já vai em destaque logo acima: aqui fica só entre quantas pessoas foi.
      $('posicao').textContent = ranked.length > 1 ? `entre ${ranked.length} pessoas` : ''
      if (ranked.length > 1) {
        notice.textContent = mine === 0 ? 'A maior nota da rodada' : `${mine + 1}º lugar`
        $('linha-seguinte').textContent = mine === 0 ? '' : `${ranked[0].name} ficou na frente, com ${ranked[0].points.toLocaleString('pt-BR')}.`
      }
      return
    }

    $('titulo').textContent = message.phase === 'sem-host' ? 'Quem comanda as músicas saiu da sala' : 'Aguardando a próxima música'
    $('artista').textContent = message.phase === 'sem-host' ? 'Assim que voltar, a sala continua.' : ''
    return
  }

  if (message.t === 'tick') {
    stage.time = message.time
    stage.at = message.at
    stage.playing = message.playing
    return
  }

  if (message.t === 'scores' && Array.isArray(message.list)) {
    const ranked = [...message.list].sort((a, b) => b.points - a.points)
    const mine = ranked.findIndex((entry) => entry.name === name)
    if (mine < 0) return
    $('pontos').textContent = ranked[mine].points.toLocaleString('pt-BR')
    $('posicao').textContent = ranked.length > 1 ? `${mine + 1}º de ${ranked.length}` : ''
  }
}

/** Posição da música agora, em segundos, pelo último aviso do host e pelo relógio acertado. */
function songTime() {
  if (!stage.playing) return stage.time
  return stage.time + (Date.now() + clockOffset - stage.at) / 1000
}

// ---------- letra ----------

/** A linha continua em destaque por este tempo depois de acabar. */
const LINGER = 0.5
/** Pausas a partir deste tamanho ganham contagem regressiva. */
const COUNTDOWN_FROM = 4
let shownFocus = -2
let shownSinging = null
let wordEls = []
let lastFill = []
let lastCount = ''

function resetLyrics() {
  shownFocus = -2
  shownSinging = null
  wordEls = []
  lastFill = []
  lastCount = ''
  for (const id of ['linha-anterior', 'linha-atual', 'linha-seguinte', 'linha-depois', 'contagem']) $(id).textContent = ''
  $('linha-atual').classList.remove('aviso', 'esperando')
}

/** Palavras de uma linha. Host antigo manda a linha sem as palavras: aí a linha inteira vira uma só. */
const wordsOf = (line) => (Array.isArray(line[3]) && line[3].length > 0 ? line[3] : [[line[0], line[1], line[2], 0]])

function drawLyrics(now) {
  const lines = stage.lines
  if (lines.length === 0) return

  let started = -1
  for (let i = 0; i < lines.length; i++) {
    if (lines[i][0] <= now) started = i
    else break
  }
  const singing = started >= 0 && now <= lines[started][1] + LINGER
  // Fora de uma linha, o foco já fica na próxima: é ela que a pessoa precisa ler.
  const focus = singing ? started : Math.min(lines.length - 1, started + 1)

  if (focus !== shownFocus || singing !== shownSinging) {
    if (focus !== shownFocus) {
      const current = $('linha-atual')
      current.textContent = ''
      wordEls = wordsOf(lines[focus]).map((word, k) => {
        if (k > 0 && !word[3]) current.append(' ')
        const span = document.createElement('span')
        span.className = 'palavra'
        span.textContent = word[2]
        current.append(span)
        return span
      })
      lastFill = []
      $('linha-anterior').textContent = focus > 0 ? lines[focus - 1][2] : ''
      $('linha-seguinte').textContent = lines[focus + 1]?.[2] ?? ''
      $('linha-depois').textContent = lines[focus + 2]?.[2] ?? ''
    }
    $('linha-atual').classList.toggle('esperando', !singing)
    if (!singing) {
      for (const span of wordEls) span.style.setProperty('--p', '0')
      lastFill = []
    }
    shownFocus = focus
    shownSinging = singing
  }

  if (singing) {
    const words = wordsOf(lines[focus])
    for (let k = 0; k < words.length; k++) {
      const [start, end] = words[k]
      const p = now <= start ? 0 : now >= end ? 1 : (now - start) / (end - start)
      // Só toca na página quando o valor muda de verdade.
      if (Math.abs(p - (lastFill[k] ?? -1)) > 0.01) {
        lastFill[k] = p
        wordEls[k]?.style.setProperty('--p', p.toFixed(2))
      }
    }
  }

  // Pausa longa antes da linha: mostra quanto falta para entrar.
  const wait = singing ? 0 : lines[focus][0] - now
  const count = wait >= 1 && lines[focus][0] - (focus > 0 ? lines[focus - 1][1] : 0) >= COUNTDOWN_FROM ? `entra em ${Math.ceil(wait)} s` : ''
  if (count !== lastCount) {
    lastCount = count
    $('contagem').textContent = count
  }
}

// ---------- pista de tom ----------

/** Segundos de passado e de futuro visíveis. */
const PAST = 1.2
const FUTURE = 2.8
const MIN_SPAN = 11
/** Buraco máximo (s de música) que a linha da voz atravessa sem se partir. */
const BRIDGE = 0.3
/** Salto (semitons) a partir do qual é outra nota: a linha se parte. */
const LEAP = 5
/** Sem leitura por até este tempo (s), a marca da voz fica onde estava. Depois apaga aos poucos. */
const HOLD = 0.25
const FADE = 0.3
/** Rastro da voz: { t: posição na música em que foi cantado, midi }. */
const trail = []
/** Relógio (performance.now) da última leitura de voz. */
let heardAt = -Infinity
const lane = { canvas: $('pista'), context: $('pista').getContext('2d'), width: 0, height: 0, low: 55, high: 67, settled: false }
const palette = (() => {
  const styles = getComputedStyle(document.documentElement)
  const accent = styles.getPropertyValue('--accent').trim() || '#c9f24a'
  const ink = styles.getPropertyValue('--ink').trim() || '#f4f4ee'
  // O degradê da linha da voz precisa das cores com transparência, qualquer que seja o formato delas.
  const toRgb = (color) => {
    const probe = document.createElement('canvas').getContext('2d')
    probe.fillStyle = color
    probe.fillRect(0, 0, 1, 1)
    const [red, green, blue] = probe.getImageData(0, 0, 1, 1).data
    return `${red}, ${green}, ${blue}`
  }
  return { accent, ink, accentRgb: toRgb(accent), inkRgb: toRgb(ink) }
})()

function sizeLane() {
  const { canvas, context } = lane
  if (canvas.hidden) return
  const ratio = Math.min(2, window.devicePixelRatio || 1)
  lane.width = canvas.clientWidth
  lane.height = canvas.clientHeight
  canvas.width = Math.round(lane.width * ratio)
  canvas.height = Math.round(lane.height * ratio)
  context.setTransform(ratio, 0, 0, ratio, 0, 0)
  lane.settled = false
}
window.addEventListener('resize', sizeLane)

/** Diferença em semitons ignorando a oitava, entre -6 e 6. */
const chromaDiff = (sung, target) => ((((sung - target) % 12) + 18) % 12) - 6

/** Nota do guia que está tocando em `t`, ou null. */
function noteAt(t) {
  const notes = stage.notes
  let lo = 0
  let hi = notes.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (notes[mid][1] <= t) lo = mid + 1
    else hi = mid
  }
  return lo < notes.length && notes[lo][0] <= t ? notes[lo] : null
}

function drawLane(now) {
  const { context, width, height } = lane
  if (lane.canvas.hidden || width === 0 || height === 0) return
  context.clearRect(0, 0, width, height)

  const notes = stage.notes
  const from = now - PAST
  const to = now + FUTURE
  const px = width / (PAST + FUTURE)
  const x = (t) => (t - from) * px
  const nowX = x(now)

  // Faixa de alturas: acompanha as notas que estão na tela, sem pular a cada frase.
  let low = Infinity
  let high = -Infinity
  for (const note of notes) {
    if (note[1] <= from) continue
    if (note[0] >= to) break
    low = Math.min(low, note[2])
    high = Math.max(high, note[2])
  }
  if (low !== Infinity) {
    const center = (low + high) / 2
    const span = Math.max(MIN_SPAN, high - low + 5)
    const ease = lane.settled ? 0.08 : 1
    lane.low += (center - span / 2 - lane.low) * ease
    lane.high += (center + span / 2 - lane.high) * ease
    lane.settled = true
  }
  const thickness = Math.max(6, Math.min(12, height * 0.08))
  const usable = height - thickness * 2
  const y = (midi) => Math.min(height - thickness * 0.7, Math.max(thickness * 0.7, thickness + (1 - (midi - lane.low) / (lane.high - lane.low)) * usable))

  // Notas do guia.
  context.lineCap = 'round'
  context.lineWidth = thickness
  context.strokeStyle = palette.ink
  for (const note of notes) {
    if (note[1] <= from) continue
    if (note[0] >= to) break
    const x0 = x(note[0]) + thickness / 2
    const x1 = Math.max(x0 + 0.5, x(note[1]) - thickness / 2)
    context.globalAlpha = note[1] <= now ? 0.16 : 0.34
    context.beginPath()
    context.moveTo(x0, y(note[2]))
    context.lineTo(x1, y(note[2]))
    context.stroke()
  }

  // Linha do "agora".
  context.globalAlpha = 0.45
  context.fillStyle = palette.ink
  context.fillRect(nowX - 0.75, 0, 1.5, height)

  // Linha da voz: na oitava mais próxima da nota pedida, em lima quando está no tom. É um traço
  // contínuo por trecho cantado: atravessa os buracos curtos da leitura em vez de piscar.
  const center = (lane.low + lane.high) / 2
  const spots = []
  let first = trail.length
  while (first > 0 && trail[first - 1].t >= from) first--
  for (let i = Math.max(0, first - 1); i < trail.length; i++) {
    const point = trail[i]
    const before = spots[spots.length - 1]
    const joined = before !== undefined && point.t - before.t <= BRIDGE
    const target = noteAt(point.t)
    // Fora de uma nota, a voz fica na oitava em que já vinha.
    const near = target ? target[2] : joined ? before.at : center
    let at = near + chromaDiff(point.midi, near)
    // Longe da nota, a meio caminho entre duas oitavas, a "mais próxima" troca a cada tremida
    // da voz e a linha pularia de cima para baixo: aí vale a oitava em que ela já vinha.
    if (target && joined && Math.abs(at - target[2]) > 4.5) {
      const kept = before.at + chromaDiff(point.midi, before.at)
      if (Math.abs(kept - target[2]) <= 7.5) at = kept
    }
    const on = target !== null && Math.abs(at - target[2]) <= stage.tolerance
    const follows = joined && Math.abs(at - before.at) <= LEAP
    spots.push({ t: point.t, at, on, start: !follows, run: joined ? before.run + 1 : 1 })
  }

  const fading = (rgb, strength) => {
    const gradient = context.createLinearGradient(0, 0, nowX, 0)
    gradient.addColorStop(0, `rgba(${rgb}, 0)`)
    gradient.addColorStop(1, `rgba(${rgb}, ${strength})`)
    return gradient
  }
  const onStroke = fading(palette.accentRgb, 1)
  const offStroke = fading(palette.inkRgb, 0.6)
  context.globalAlpha = 1
  context.lineCap = 'round'
  context.lineJoin = 'round'
  context.lineWidth = Math.max(3.5, thickness * 0.5)
  let next = 1
  while (next < spots.length) {
    if (spots[next].start) {
      next++
      continue
    }
    const on = spots[next].on
    context.beginPath()
    context.moveTo(x(spots[next - 1].t), y(spots[next - 1].at))
    for (; next < spots.length && !spots[next].start && spots[next].on === on; next++) context.lineTo(x(spots[next].t), y(spots[next].at))
    context.strokeStyle = on ? onStroke : offStroke
    context.stroke()
  }

  // Cursor: onde a voz está neste instante. Espera um pouco antes de sumir, e some aos poucos.
  // Uma leitura sozinha ainda não é voz.
  const last = spots[spots.length - 1]
  const silent = (performance.now() - heardAt) / 1000
  if (last && last.run >= 2 && silent <= HOLD + FADE) {
    context.globalAlpha = silent <= HOLD ? 1 : 1 - (silent - HOLD) / FADE
    context.fillStyle = last.on ? palette.accent : palette.ink
    context.beginPath()
    context.arc(nowX, y(last.at), thickness * 0.66, 0, Math.PI * 2)
    context.fill()
  }
  context.globalAlpha = 1
}

function frame() {
  requestAnimationFrame(frame)
  if (stage.phase !== 'cantando') return
  const now = songTime()
  drawLyrics(now)
  // A voz ouvida agora foi cantada sobre o som de `latency` segundos atrás: a pista anda nesse relógio.
  drawLane(now - stage.latency)
}

// ---------- microfone e tom ----------

const WINDOW = 2048
const MIN_HZ = 70
const MAX_HZ = 1100
const MIN_CLARITY = 0.85
/** Para continuar mostrando uma nota que já vinha soando, basta bem menos nitidez. */
const KEEP_CLARITY = 0.68
let analyser = null
let sampleRate = 48000
const samples = new Float32Array(WINDOW)
const nsdf = new Float32Array(WINDOW)
let floorDb = -70
/** Relógio (performance.now) da última leitura exigente, e a nota que vinha soando. */
let sureAt = -Infinity
let note = 0
let level = 0
let lastNote = ''
/** Leituras ainda não enviadas: [instante no relógio do host, nota MIDI ou null]. */
let outbox = []

/**
 * Tom pelo método de McLeod: mede, para cada atraso, o quanto o sinal se parece com ele
 * mesmo deslocado. O primeiro pico forte dá o período. Devolve [hertz, clareza de 0 a 1].
 */
function detectPitch() {
  const minLag = Math.floor(sampleRate / MAX_HZ)
  const maxLag = Math.min(WINDOW >> 1, Math.ceil(sampleRate / MIN_HZ))
  let highest = 0
  for (let lag = minLag - 1; lag <= maxLag + 1; lag++) {
    let same = 0
    let energy = 0
    for (let i = 0; i < WINDOW - lag; i++) {
      const a = samples[i]
      const b = samples[i + lag]
      same += a * b
      energy += a * a + b * b
    }
    nsdf[lag] = energy > 0 ? (2 * same) / energy : 0
    if (lag >= minLag && lag <= maxLag && nsdf[lag] > highest) highest = nsdf[lag]
  }
  if (highest < KEEP_CLARITY) return [0, highest]

  // Primeiro máximo local perto do maior: evita cair numa oitava abaixo.
  for (let lag = minLag; lag <= maxLag; lag++) {
    const value = nsdf[lag]
    if (value < highest * 0.93 || value < nsdf[lag - 1] || value < nsdf[lag + 1]) continue
    const curve = nsdf[lag - 1] - 2 * value + nsdf[lag + 1]
    const shift = curve < 0 ? (0.5 * (nsdf[lag - 1] - nsdf[lag + 1])) / curve : 0
    return [sampleRate / (lag + shift), value]
  }
  return [0, highest]
}

function sample() {
  if (!analyser) return
  analyser.getFloatTimeDomainData(samples)
  let sum = 0
  for (let i = 0; i < WINDOW; i++) sum += samples[i] * samples[i]
  const db = 20 * Math.log10(Math.max(Math.sqrt(sum / WINDOW), 1e-7))
  const [hz, clarity] = detectPitch()
  const inRange = hz >= MIN_HZ && hz <= MAX_HZ
  const tonal = inRange && clarity >= MIN_CLARITY

  // O piso de ruído só sobe com som sem tom (a música do ambiente): uma nota longa não o empurra.
  if (db < floorDb) floorDb = db
  else if (!tonal) floorDb += Math.min(0.1, (db - floorDb) * 0.04)
  const singing = tonal && db > Math.max(-52, floorDb + 8)
  const raw = inRange ? 69 + 12 * Math.log2(hz / 440) : null
  // Esta é a leitura exigente: é a que vai para o host e vale ponto.
  const midi = singing ? Math.round(raw * 100) / 100 : null

  // Para o desenho, a nota que vinha soando continua valendo quando só perde nitidez (consoante,
  // vibrato, fim do fôlego), na oitava de antes. Sem isso a marca da voz pisca.
  const clock = performance.now()
  let shown = midi
  if (midi !== null) {
    sureAt = clock
    note = midi
  } else if (raw !== null && clock - sureAt <= 400 && clarity >= KEEP_CLARITY && db > Math.max(-52, floorDb + 4)) {
    const step = chromaDiff(raw, note)
    if (Math.abs(step) <= 3) {
      note += step
      shown = note
    }
  }
  if (shown !== null) heardAt = clock

  const target = Math.min(1, Math.max(0, (db + 60) / 54))
  level = target > level ? target : level * 0.85
  $('nivel').style.transform = `scaleX(${level.toFixed(3)})`
  // O nome da nota também espera um pouco antes de voltar ao "cante algo".
  const text = shown !== null ? noteName(shown) : clock - heardAt < 400 && lastNote ? lastNote : 'cante algo'
  if (text !== lastNote) {
    lastNote = text
    $('nota').textContent = text
  }

  if (joined && stage.phase === 'cantando' && stage.playing) {
    // A janela analisada termina agora; o som dela é, em média, de meio tamanho de janela atrás.
    const half = WINDOW / sampleRate / 2
    outbox.push([Math.round(Date.now() + clockOffset - half * 1000), midi])
    if (shown !== null) {
      trail.push({ t: songTime() - stage.latency - half, midi: shown })
      if (trail.length > 160) trail.splice(0, trail.length - 160)
    }
  }
}

function flush() {
  if (outbox.length === 0) return
  send({ t: 'pitch', s: outbox })
  outbox = []
}

async function enableMic() {
  const button = $('ligar-mic')
  const error = $('erro-mic')
  button.disabled = true
  error.hidden = true
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      // Sem os filtros de chamada de voz: eles achatam notas longas e atrapalham a leitura do tom.
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
    })
    const context = new AudioContext()
    await context.resume()
    sampleRate = context.sampleRate
    const highpass = context.createBiquadFilter()
    highpass.type = 'highpass'
    highpass.frequency.value = 60
    analyser = context.createAnalyser()
    analyser.fftSize = WINDOW
    analyser.smoothingTimeConstant = 0
    context.createMediaStreamSource(stream).connect(highpass).connect(analyser)

    micOn = true
    setInterval(sample, 40)
    setInterval(flush, 120)
    // Tela apagada = microfone parado. Pede para o aparelho ficar aceso enquanto a sala está aberta.
    navigator.wakeLock?.request('screen').catch(() => {})
    show('palco')
    sizeLane()
  } catch (err) {
    button.disabled = false
    error.textContent =
      err && err.name === 'NotAllowedError'
        ? 'O microfone foi bloqueado. Libere o microfone para este site nas configurações do navegador e tente de novo.'
        : 'Não deu para abrir o microfone deste aparelho.'
    error.hidden = false
  }
}

// ---------- início ----------

$('form-entrar').addEventListener('submit', (event) => {
  event.preventDefault()
  const typed = $('nome').value.replace(/\s+/g, ' ').trim()
  const error = $('erro-nome')
  if (!typed) {
    error.textContent = REFUSALS['nome-invalido']
    error.hidden = false
    return
  }
  error.hidden = true
  name = typed
  send({ t: 'join', name, id: deviceId })
})

$('ligar-mic').addEventListener('click', () => void enableMic())
$('nome').value = name
setInterval(() => send({ t: 'ping', c: Date.now() }), 3000)
connect()
frame()
