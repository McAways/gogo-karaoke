# Gogó

Karaoke para uso próprio, rodando na sua máquina: biblioteca de músicas, álbuns e
playlists, letra sincronizada e preenchida palavra a palavra, pontuação pela afinação,
opção de tirar a voz original, fila de músicas, sala para cantar em grupo pela rede de
casa e exportação para levar as músicas de um aparelho para outro.

Quase tudo acontece no navegador. A parte fora dele é um ajudante que sobe junto com
o app e cuida do que o navegador não consegue: baixar do YouTube, separar a voz do
instrumental, medir a letra no áudio, ler playlists do Spotify e abrir a sala para os
celulares.

## Como rodar

Requisitos: Node 22 ou mais novo. Para baixar vídeo (não só áudio) e para separar a
voz, `ffmpeg` no PATH.

```
npm install
npm run dev
```

Abra `http://localhost:5173` no Chrome ou no Edge.

Na primeira vez, se a busca no YouTube pedir, clique em "Instalar agora" (ou rode
`npm run ytdlp:update`): isso baixa o `yt-dlp` para `helper/bin`.

## Como usar

1. **Adicionar música**: busque pelo nome, cole um link do YouTube ou arraste um
   arquivo de áudio ou vídeo para a janela.
2. O app baixa, guarda no navegador, procura a letra sincronizada e analisa a
   melodia sozinho. O painel no canto mostra o andamento.
3. **Cantar**: ligue o microfone, diga se ouve por caixas de som ou fones e comece.
4. No fim aparece a nota, o acerto e o desempenho verso a verso.

Atalhos no palco: `espaço` toca e pausa, `[` e `]` adiantam e atrasam a letra,
setas voltam e avançam 5 s, `R` recomeça, `F` tela cheia.

### Tirar a voz original

Em Ajustes, "Voz original", clique em **Instalar** (baixa cerca de 60 MB, uma vez só).
A partir daí cada música nova é separada em duas faixas, voz e instrumental, o que leva
uns 15 segundos por música. No palco, o botão de voz liga e desliga a voz original, e
o controle ao lado deixa só um pouco dela como apoio.

Músicas que já estavam na biblioteca não são separadas sozinhas: abra a página da
música e use "Separar a voz". Sem a separação o botão ainda funciona, com um truque
bem mais fraco (cancelar o centro do estéreo), e aparece marcado como aproximado.

A separação também melhora o resto: o guia de notas passa a sair só da voz, e o app
confere a letra contra o canto para escolher a sincronia que encaixa.

### Letra sincronizada pelo áudio

A letra que vem do banco de letras foi sincronizada por outra pessoa, para a gravação
do álbum, e só marca o começo de cada linha. Em clipe com pausa a mais, entrada
atrasada ou nota segurada, ela sai do tempo. A sincronia pelo áudio resolve isso
medindo, na voz da sua gravação, o instante de cada palavra.

Em Ajustes, "Letra", clique em **Instalar** (cerca de 300 MB, uma vez só). A medição
leva perto de um minuto por música e só acontece em dois casos:

- **Quando você pede**: "Sincronizar pelo áudio", na página da música ("Voltar à
  sincronia anterior" desfaz), ou **"Sincronizar todas"**, em Ajustes, que passa pelas
  músicas da biblioteca uma a uma (separando a voz das que ainda não têm). Dá para sair
  da tela, o trabalho continua.
- **Quando a música só tem a letra em texto**, sem os tempos: aí o app mede sozinho,
  logo depois de separar a voz, porque sem isso a letra ficaria parada na tela. Vale ao
  adicionar a música e ao trocar a letra por uma só de texto. Dá para desligar em
  Ajustes, "Medir quando a letra vier sem sincronia".

Letra que já vem sincronizada do banco fica como veio, sem esperar a medição. A
medição precisa da voz separada (ver "Tirar a voz original"). Onde a voz tem muito
efeito e o modelo não a reconhece, vale a sincronia original daquela linha. Sem letra
nenhuma não há o que medir: o app encaixa um texto no áudio, não transcreve o canto.

O modelo usado (MMS, da Meta) tem licença só para uso não comercial.

### Biblioteca: músicas, álbuns e playlists

A biblioteca tem duas abas. **Músicas** mostra tudo, uma a uma. **Álbuns e playlists**
mostra os conjuntos:

- **Playlists**: as que você montou. Para criar uma, abra o menu de uma música (os três
  pontos no cartão) e escolha "Adicionar a uma playlist", ou salve a fila na tela da
  fila.
- **Álbuns**: os que vieram inteiros de um link do Spotify, e os que o app junta
  sozinho quando há duas ou mais músicas do mesmo álbum.

Clicar num álbum ou playlist abre a página dele, com as músicas na ordem e os botões
"Cantar agora" (põe o conjunto na frente da fila e abre a primeira), "Pôr na fila",
"Exportar" e "Excluir". Excluir uma playlist não apaga as músicas.

### Fila e playlists

O botão de fila na biblioteca e na página da música põe a música no fim da fila. Em
**Fila** dá para reordenar, tirar, salvar a fila como playlist e recarregar uma
playlist salva. Ao terminar uma música, a tela de resultado oferece a próxima.

### Cantar em grupo (sala)

1. No computador que toca as músicas, abra **Sala** e clique em "Abrir a sala".
2. Cada pessoa aponta a câmera do celular para o código (ou digita o endereço), com o
   celular **na mesma rede Wi-Fi**.
3. O navegador do celular avisa que a conexão não é particular. É esperado: a sala usa
   um certificado feito na sua máquina. Toque em "Avançado" e continue.
4. Cada um escreve um nome (não pode repetir) e libera o microfone.

Daí em diante quem comanda é o computador: ele escolhe as músicas e toca o som. O
celular serve de sensor: ele ouve a voz de quem está com ele e manda só a afinação.
Segure o celular perto da boca, como um microfone. Dá para cantar no microfone da
caixa de som ao mesmo tempo.

Na tela do celular aparecem a letra, preenchida palavra por palavra, a pista de tom
com as notas da melodia e um ponto mostrando onde a voz da pessoa está, e a nota dela.

No palco aparece o placar ao vivo, e no fim cada pessoa tem a própria nota. Só entra
no resultado quem cantou.

Na primeira vez o Windows pergunta se o Node pode usar a rede: permita em redes
privadas, senão os celulares não chegam.

### Link do Spotify: playlist, álbum ou música

Cole o link no campo de busca de "Adicionar música":

- **Playlist pública ou álbum**: o app lê o nome e as faixas e abre uma lista. Para cada
  faixa ele procura no YouTube a gravação com o mesmo nome, artista e duração; dá para
  baixar uma a uma, todas de uma vez ou trocar o vídeo escolhido. As músicas entram na
  aba "Álbuns e playlists" da biblioteca: a playlist com o nome da do Spotify, o álbum
  com o nome dele e o do artista.
- **Uma música só**: o link vira uma busca comum pelo nome e pelo artista dela.

Link de artista ou de podcast não é lido. O som nunca vem do Spotify, só a lista. A
página pública mostra no máximo 100 faixas.

### Baixar uma lista inteira

Vale para a lista do Spotify e para o arquivo de lista de outro aparelho. "Baixar as que
faltam" baixa **três músicas ao mesmo tempo**: quando uma termina, a próxima começa.
Os downloads correm juntos; separar a voz e medir a letra, que usam o processador
inteiro, entram numa fila e rodam um por vez.

**Um download que falha é tentado de novo, até três vezes**, com uma pausa entre as
tentativas. O painel de importações mostra "tentativa 2 de 3" quando isso acontece. Só
depois da terceira a música aparece como falha, com os botões "Tentar de novo" e "Trocar
vídeo" (para quando o vídeo saiu do ar). A busca do vídeo de cada faixa também é tentada
três vezes.

Enquanto houver música da lista por baixar, o menu de cima mostra "Para baixar" com a
conta do que falta: é o atalho para a lista, de qualquer tela. A lista fica guardada,
então dá para fechar o app e continuar depois.

### Levar músicas para outro aparelho

"Exportar" abre uma escolha, e quem decide é você:

- **Só a lista**: um arquivo pequeno (`.json`) com de onde veio cada música, a letra já
  sincronizada e as playlists. O outro aparelho baixa as músicas de novo e prepara cada
  uma. Serve quando lá há internet e tempo.
- **Músicas completas**: um pacote (`.gogo`) com o áudio ou o vídeo, a capa, a letra como
  está, a voz separada e o guia de notas. No outro aparelho as músicas entram **prontas
  para cantar**: nada é baixado, separado, analisado nem medido. O pacote pesa o que as
  músicas pesam, e o diálogo mostra o tamanho antes de exportar.

O botão está em mais de um lugar, conforme o que você quer levar:

- **Tudo**: "Exportar", no menu de cima (em tela estreita, na biblioteca), ou "Exportar a
  biblioteca", em Ajustes.
- **Uma música só**: no menu do cartão dela (os três pontos), "Exportar esta música".
- **Um álbum ou uma playlist**: o botão de exportar no cartão dele, "Exportar álbum" ou
  "Exportar playlist" na página dele, ou o ícone de exportar na tela da fila.

No outro aparelho: "Adicionar música", "Abrir arquivo exportado", ou solte o pacote na
janela do app. O app reconhece sozinho se é a lista ou o pacote.

- Música que já está na biblioteca do outro aparelho é pulada, nos dois casos.
- Playlists e álbuns chegam montados. Se já existe uma playlist com o mesmo nome, o
  pacote acrescenta nela o que falta, sem tirar o que estava.
- Notas e histórico de quem cantou não viajam.
- Na lista, música que veio de um arquivo do computador aparece, mas não tem de onde ser
  baixada: precisa ser adicionada de novo à mão, ou trocada por um vídeo do YouTube. No
  pacote ela vai junto, como as outras.
- O pacote contém as músicas em si: é para levar entre os seus aparelhos.

## Usar em outras máquinas

O app tem duas metades. A que canta (biblioteca, palco, pontuação, letras) roda inteira
no navegador e pode ser publicada como um site. A que prepara as músicas (baixar do
YouTube, separar a voz, medir a letra no áudio, abrir a sala) é o **ajudante**, um
programa que roda no computador. Dá para combinar as duas de três jeitos:

| Onde | Como abre | O que faz |
|---|---|---|
| Computador principal | `npm run dev` e `localhost:5173` | Tudo. O ajudante sobe junto com o app |
| Outra máquina, só para cantar | O endereço publicado | Canta a partir de pacotes de "Músicas completas" e de arquivos do computador |
| Outra máquina, para baixar também | O endereço publicado, com o ajudante instalado nela | Tudo |

### Publicar o app

O projeto já traz o `vercel.json` (as páginas internas abrem por endereço direto) e o
`.vercelignore` (não sobe `helper/bin`, onde ficam os programas baixados e as
configurações desta máquina).

1. Na pasta do projeto: `npx vercel` (pede login na primeira vez) e, para a versão
   definitiva, `npx vercel --prod`. Pelo Git também funciona, desde que o projeto esteja
   num repositório próprio e privado.
2. Anote o endereço definitivo que o Vercel der (o de produção): é ele que cada ajudante
   vai autorizar. As pré-visualizações do Vercel têm cada uma um endereço diferente, e o
   ajudante não atende a elas.

Só o app é publicado. O site não baixa nada: quem baixa é o ajudante, no computador de
quem usa. Para ver como fica sem publicar: `npm run build` e `npm run serve:publicado`
(abre em `http://localhost:4173`).

### Instalar o ajudante em outra máquina

1. No computador principal: `npm run helper:pack -- --site=https://seu-endereco.vercel.app`.
   Sai a pasta `dist-helper/gogo-ajudante` (e um `.zip` dela), já autorizando o seu endereço.
2. Leve a pasta para a outra máquina (para um Mac, leve o `.zip`: ele guarda a permissão
   de executar). A máquina não precisa ter nada instalado, só internet.
3. Abra o arquivo **instalar** (no Mac, `instalar.command`). Ele baixa sozinho o que
   faltar: o Node, só para dentro da pasta e sem mexer no sistema, as dependências, o
   ffmpeg e o downloader. No Windows, pergunta também se o ajudante deve subir junto com
   o sistema.
4. Abra o arquivo **iniciar** (no Mac, `iniciar.command`) e deixe a janela aberta. Depois
   abra o endereço do app no Chrome ou no Edge. Na primeira vez o navegador pergunta se o
   site pode acessar a rede local: permita. É assim que o site fala com o ajudante.

No Mac, se o sistema disser que não pode abrir o arquivo, clique nele com o botão direito
e escolha Abrir. Os arquivos do Mac ainda não foram rodados num Mac de verdade; os do
Windows foram testados numa máquina simulada sem Node e sem ffmpeg. Para desinstalar,
apague a pasta: tudo o que foi baixado fica dentro dela.

Em Ajustes, "Ajudante", o app diz se achou o ajudante e, se não achou, o que falta.

### O que é bom saber

- **Cada endereço tem a sua biblioteca.** O que está em `localhost:5173` não aparece no
  endereço publicado, nem no mesmo computador. Para levar: "Exportar", "Músicas
  completas", e abra o pacote do outro lado.
- **O ajudante só atende o próprio computador e os endereços autorizados nele.** Qualquer
  outro site que tente falar com ele é recusado. A lista só muda por comando dado na
  própria máquina: o arquivo **permitir**, ou `npm run helper -- permitir <endereço>`.
  `npm run helper -- sites` mostra a lista, e `... esquecer <endereço>` tira um.
- **No computador principal** também dá para usar o endereço publicado: `npm run helper`
  sobe o mesmo ajudante sozinho, depois de autorizar o endereço como acima.
- O ajudante instalado atende na porta 5175. A sala continua na 5174.
- A separação de voz e a sincronia pelo áudio são instaladas de dentro do app, em cada
  máquina, como sempre.

## Quando algo não sai como esperado

| Sintoma | O que fazer |
|---|---|
| Download falha ou dá erro 403 | O app já tenta três vezes sozinho (o painel mostra "tentativa 2 de 3"). Se continuar, Ajustes, Downloader, **Atualizar**: o YouTube muda com frequência. Baixando muitas músicas seguidas, o YouTube às vezes passa a recusar por um tempo: espere alguns minutos e use "Tentar de novo". |
| Letra um pouco adiantada ou atrasada | Use o "Atraso da letra" no palco. O valor fica salvo por música. |
| Letra sai do tempo no meio da música | Instale a sincronia pelo áudio (Ajustes, "Letra") e use "Sincronizar pelo áudio" na página da música. Ela acompanha pausas e entradas que a letra original não tem. |
| Letra totalmente fora de tempo | É a sincronia de outra versão da música. Na página da música, "Buscar letra" mostra as outras, cada uma com a hora em que a voz entra. |
| A busca não mostra o vídeo que eu queria | O filtro "Só vídeos com letra" esconde os que não têm letra conhecida. Desligue o filtro ou clique em "Mostrar todos". Link colado nunca é escondido. |
| O link do Spotify não abre | Playlist precisa ser pública; álbum e música abrem sempre. Se nada abrir, o Spotify pode ter mudado a página: adicione as músicas pela busca. |
| Letra parada na tela | É uma letra só de texto. Com a sincronia pelo áudio instalada e a voz separada, "Sincronizar pelo áudio" mede os tempos. Senão, troque por uma sincronizada em "Buscar letra", ou marque os tempos no editor. |
| Não achou a letra | Na página da música: confira nome e artista em "Editar dados" e busque de novo, importe um `.lrc`, ou cole o texto e marque os tempos no editor. |
| Pontuação baixa mesmo cantando certo | Teste com fones, e ajuste o "Atraso do microfone" em Ajustes (Bluetooth pede 150 ms ou mais). |
| Biblioteca apareceu vazia | Confira se o endereço é `localhost:5173`. Em outra porta o navegador mostra outra biblioteca. |
| O app publicado não acha o ajudante | Confira se a janela do "iniciar" está aberta naquele computador. No Chrome ou no Edge, clique no ícone ao lado do endereço e veja se o acesso à rede local está permitido para o site. Depois, em Ajustes, "Ajudante", use "Procurar de novo". |
| "Instalado, mas não atende este endereço" | O endereço do app mudou ou não foi autorizado naquele computador. Na pasta do ajudante, abra o arquivo "permitir" e informe o endereço que aparece em Ajustes. |
| O pacote exportado não abre | "O pacote está incompleto" quer dizer que a cópia do arquivo foi interrompida (pen drive tirado antes da hora, envio cortado): copie de novo. Se faltar espaço no navegador do outro aparelho, o app avisa e as músicas que já entraram ficam. |
| Quero a pontuação mais precisa possível | Importe o `.txt` do UltraStar da música: ele traz as notas anotadas à mão. |
| Ainda dá para ouvir a voz original | A separação reduz bastante, mas não zera. Em algumas gravações sobra um resto. |
| O celular não abre o endereço da sala | Confira se está no mesmo Wi-Fi do computador e se o Windows liberou o Node no firewall (redes privadas). Rede de visitantes costuma isolar os aparelhos. |
| O celular entrou mas a nota não sobe | O medidor "Sua voz" precisa se mexer quando a pessoa canta. Chegue o celular mais perto da boca e confira se o microfone foi liberado para o site. |
| O celular mostra "reconectando" | A tela apagou ou o Wi-Fi caiu. Ele volta sozinho com o mesmo nome. |
| O celular fica em "reconectando" logo depois de abrir a página | Espere uns 5 segundos. A página tenta um segundo jeito de conversar com a sala, feito para celulares que recusam o primeiro. |
| Reiniciei o app com a sala aberta | Se a aba do navegador continuou aberta, ela reabre a sala sozinha. Se você fechou a aba, clique em "Abrir a sala" de novo. Nos dois casos os celulares voltam com o mesmo nome. |

## Onde ficam os dados

As músicas, capas, letras e notas ficam no próprio navegador (OPFS e IndexedDB),
presas ao endereço em que o app foi aberto: `http://localhost:5173` no computador
principal, o endereço publicado nas outras máquinas. Limpar os dados do site apaga a
biblioteca. Em Ajustes dá para pedir ao navegador que proteja esses dados.

## Comandos

| Comando | Para quê |
|---|---|
| `npm run dev` | Abre o app em modo de desenvolvimento |
| `npm start` | Gera a versão de produção e a serve na mesma porta |
| `npm test` | Testes de lógica (letras, extração de melodia, pontuação) |
| `npm run test:e2e` | Teste no navegador com microfone simulado, inclusive a sala com dois convidados. Precisa do app rodando. Com `-- --sem-rede` pula o que depende do YouTube |
| `npm run typecheck` | Checagem de tipos |
| `npm run ytdlp:update` | Baixa ou atualiza o `yt-dlp` |
| `npm run helper` | Sobe o ajudante sozinho, para o app publicado (porta 5175). Com `-- permitir <endereço>`, `-- esquecer <endereço>` ou `-- sites`, cuida da lista de endereços autorizados |
| `npm run helper:pack` | Monta em `dist-helper` a pasta do ajudante para levar a outra máquina |
| `npm run serve:publicado` | Serve a versão de produção como um site estático, sem o ajudante embutido, para ver como fica publicada |

## Como funciona, em resumo

- **Letras**: vêm do [LRCLIB](https://lrclib.net), um banco aberto. A busca usa
  artista, título e duração: a letra com a mesma duração da gravação é a que encaixa.
- **Preenchimento palavra a palavra**: quando a fonte só tem o tempo de cada linha,
  as palavras são distribuídas por sílabas dentro dela. Com `.lrc` "enhanced" ou
  UltraStar, o tempo de cada palavra é o real.
- **Pontuação**: o tom do microfone é comparado, quadro a quadro, com um guia de
  melodia extraído do próprio áudio da música. Cantar uma oitava acima ou abaixo
  vale igual. O guia acerta cerca de nove notas em dez, então 90% de acerto já dá
  nota máxima.
- **Voz original**: um modelo de separação roda no ajudante e entrega duas faixas.
  No palco tocam as duas juntas, e tirar a voz é só baixar o volume de uma delas.
- **Sala**: o ajudante abre um segundo servidor, na porta 5174, que entrega só a
  página do convidado. O celular mede o tom e manda para o computador, que pontua
  cada pessoa contra o mesmo guia.
- **Sincronia pelo áudio**: um modelo acústico ouve a voz separada e dá, 50 vezes por
  segundo, a chance de cada letra estar sendo cantada. O app encaixa o texto da letra
  nisso. As linhas que o modelo ouve com clareza servem de âncora para as outras.

## Uso pessoal

Baixar do YouTube fere os termos do serviço e a cópia de música protegida é zona
cinzenta na lei. O app foi feito para uso seu: as músicas ficam no navegador de cada
máquina e nada é enviado para fora. O site publicado não baixa nada; quem baixa é o
ajudante, que roda no seu computador e só atende a própria página e os endereços que
você autorizou. Não distribua os arquivos baixados, e não ofereça o seu endereço
publicado, com o ajudante, como um serviço para outras pessoas.

A sala é a única parte que aceita conexões de outros aparelhos, e só enquanto está
aberta. Quem entra por ela recebe apenas a página do convidado: a biblioteca e o
downloader continuam acessíveis só no próprio computador. Use em rede de confiança.
