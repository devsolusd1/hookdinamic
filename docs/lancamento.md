# Lançar o Veluno: tudo, em ordem

Para o dono do projeto. Siga de cima para baixo, sem pular. Os comandos são para colar no
**PowerShell**, aberto na pasta do projeto (`C:\Users\John\RafinhaProject\agent-hook-token`).

**Você vai percorrer este documento duas vezes.** A primeira na **devnet**, a rede de teste da
Solana, com SOL de mentira: é o ensaio, e a parte 0 diz o que muda nele. A segunda na
**mainnet**, com SOL de verdade.

**O que já foi ensaiado e o que não foi.** O comando de lançamento, o de criar chaves e o do
guardião foram rodados numa rede local de teste. A publicação do programa foi ensaiada só nessa
rede local. Nada disto foi rodado ainda na devnet nem na mainnet com esta versão. Por isso o
ensaio na devnet vem primeiro, e não é opcional.

As saídas dos comandos aparecem em inglês. Este documento diz o que procurar nelas.

**Uma linha que pode aparecer no começo de qualquer comando, e é normal:**

```
bigint: Failed to load bindings, pure JS will be used (try npm run rebuild?)
```

Não é erro e não precisa fazer nada. O comando continua e funciona igual.

---

## 0. Primeiro de tudo: o ensaio na devnet

É o caminho inteiro, com dinheiro de mentira: este documento, depois `docs/hospedagem.md` e,
por fim, `docs/emergencia.md`. Faça até o fim antes de gastar SOL de verdade. É melhor errar
ali.

### O que muda no ensaio

| Onde | Na devnet |
|---|---|
| A pasta das chaves | `C:\Users\John\veluno-devnet`. Em todo comando deste documento, troque `veluno-mainnet` por `veluno-devnet`. |
| As chaves (parte 2) | **Todas novas**, criadas com o comando da parte 2: as seis de lá, e mais uma, `tesouraria.json`. Nenhuma chave do ensaio é usada depois na mainnet. |
| O SOL (parte 2) | De teste, grátis: em https://faucet.solana.com, peça para o endereço do pagador (2 SOL bastam). Do pagador para os outros, use o comando logo abaixo. |
| O endereço do RPC (partes 4 e 5) | `https://api.devnet.solana.com`. É público e não precisa de conta. |
| Publicar o programa (parte 4) | O mesmo comando, com `veluno-devnet` nos três caminhos e `https://api.devnet.solana.com` no lugar de `COLE_O_RPC_AQUI`. |
| O `launch.json` (parte 5) | `"rpc": "https://api.devnet.solana.com"`. O `"uri"` é o mesmo da mainnet. |
| Lançar (parte 7) | **Sem** `--mainnet`: `npm run launch -- C:\Users\John\veluno-devnet\launch.json --send` |
| O comando do guardião | **Sem** `--mainnet`: só `--send`. |
| O site | Não mexa em `site\config.js`. O site continua como está até o lançamento de verdade. |

Para mandar SOL de teste do pagador para outro endereço, cole este comando trocando
`ENDERECO`. Repita para o guardião, o agente, o keeper e a tesouraria (0,1 SOL para cada um é
de sobra):

```
wsl -e bash -lc 'export PATH=$HOME/.local/share/solana/install/active_release/bin:$PATH; solana transfer ENDERECO 0.1 --url https://api.devnet.solana.com --keypair /mnt/c/Users/John/veluno-devnet/pagador.json --allow-unfunded-recipient'
```

### A ordem do ensaio

1. **Este documento, partes 2 a 7, na devnet.** No fim você tem um token de teste e um
   `token.json` em `C:\Users\John\veluno-devnet`.
2. **`docs/hospedagem.md`**, num projeto da Railway **só para o ensaio** (o que você já criou
   serve). A parte "O ensaio na devnet" de lá diz o que muda. Deixe o serviço rodar de verdade
   por algumas horas e peça a quem programa para fazer algumas compras e vendas no token de
   teste: sem negociação não há taxas, e o keeper não tem o que mostrar.
3. **`docs/emergencia.md`**, o ensaio do guardião (a última parte de lá): pausar, despausar,
   trocar o agente.
4. **Apague o projeto do ensaio na Railway inteiro. O disco dele vai junto.** O serviço da
   mainnet é criado novo e nasce com um disco vazio. Um disco que já viu a devnet guarda o
   diário e as contas do token de teste, e não pode ser apontado para o token de verdade.

O token de teste que já existia na devnet não serve mais: ele é da versão antiga. O ensaio
cria um novo.

---

## 1. O que precisa estar pronto antes da mainnet

Peça a quem programa para confirmar estes três itens. Sem eles, não lance.

1. **Os testes passam** (`npm run test:programs`) e o programa está compilado. A última linha
   desse comando diz `binary: 56752 bytes at ...`. Anote o número: ele aparece de novo na
   parte 4. Se o programa for alterado até o lançamento, o número muda, e vale o que este
   comando mostrar por último.
2. **Esta versão do código está no GitHub** e a imagem do servidor foi construída com ela pelo
   menos uma vez. A Railway constrói o serviço a partir do GitHub; sem o `Dockerfile` desta
   versão lá, ela não consegue.
3. **O arquivo do token está no ar.** Abra no navegador
   `https://www.veluno.li/metadata.json`: tem que aparecer um texto curto com
   `"name": "Veluno"`. Abra também `https://www.veluno.li/veluno.png`: tem que aparecer o
   Veluno. Esses dois arquivos já existem no projeto (`site\metadata.json` e
   `site\veluno.png`), mas só ficam no ar depois que quem programa os envia para o GitHub.
   Carteiras e exploradores leem esse arquivo para mostrar o nome e a imagem do token.

E tenha em mãos estes três:

4. **O ensaio na devnet feito até o fim** (parte 0).
5. **O endereço do RPC do servidor.** Um RPC é a porta por onde os programas falam com a
   Solana. Em helius.dev, crie uma conta e copie o endereço que começa com
   `https://mainnet.helius-rpc.com/?api-key=`. Você vai usá-lo três vezes: para publicar o
   programa (parte 4), no arquivo de lançamento (parte 5) e no servidor.
   - Ele é **segredo**: quem tem o endereço gasta a sua cota.
   - Ele é **outro** que o do site, de preferência de outra conta da Helius. O do site é
     público; se alguém gastar a cota dele, o servidor não pode parar junto.
   - Tem que ser de um provedor que guarda o **histórico completo** da rede (a Helius guarda).
     Com um que apaga blocos antigos, o keeper para e diz que não consegue saber o que
     aconteceu com um pagamento, em vez de arriscar pagar duas vezes.
6. **A tesouraria com um pouco de SOL** (parte 2, "Colocar SOL nas carteiras").

---

## 2. As chaves

Uma "chave" aqui é um arquivo pequeno, com 64 números. Quem tem o arquivo manda na carteira.
Cada chave tem um **endereço**, que é público e pode ser mostrado a qualquer um.

### Quais são

| Arquivo | Para que serve | Onde fica |
|---|---|---|
| `pagador.json` | Paga a publicação do programa e o lançamento. **É também a chave que pode atualizar o programa.** Na mainnet é a carteira `G1PhqQ3esibLyM8q4YHnWSUAvhaVvPwxSsPDusmkKTDx`, que já existe. | **Só no seu computador.** Depois do lançamento, guarde fora dele. |
| `guardiao.json` | O freio de emergência. Pausa e despausa o agente, troca o agente, troca o keeper. Também pode nomear uma chave de app mais tarde e passar o próprio papel para outra chave. | **Só no seu computador, nunca no servidor.** Cópia num pendrive guardado. |
| `agente.json` | A chave com que o agente escreve os éditos. | Vai para o servidor (Railway). |
| `keeper.json` | A chave com que o keeper retira as taxas e paga. | Vai para o servidor (Railway). |
| `programa.json` | Só define o endereço do programa na hora de publicar. Depois não dá poder nenhum. | No seu computador. |
| `buffer.json` | Rascunho usado durante a publicação do programa. | No seu computador. Pode apagar depois. |
| `mint.json` e `curve-config.json` | O comando de lançamento cria sozinho. Definem o endereço do token e da curva. | No seu computador. Não apague até o lançamento terminar. |

E a **tesouraria**: é a carteira `6Zudkofv2WFz2XdAR43cozs7rJavhyn5UmQw7E9QSDph`, a que recebe
a parte da tesouraria. Ela é nova e ainda está vazia. O projeto só usa o **endereço** dela; a
chave fica com você e nunca vai para o servidor. **Não pode ser a carteira do keeper.**

### Regras que valem para sempre

1. `guardiao.json` e `pagador.json` **nunca** vão para o servidor, para o GitHub, para um chat
   ou para um print de tela.
2. Cada chave é uma chave diferente. Não use a mesma para duas funções.
3. Quem tem `pagador.json` pode trocar o programa inteiro por outro. Essa chave vale tanto
   quanto a do guardião. Guarde igual.
4. Se você perder `guardiao.json`, ninguém mais consegue pausar o agente nem trocar chaves.
   Tenha uma cópia fora do computador.

### Criar as chaves

Crie a pasta (fica **fora** do projeto):

```
mkdir C:\Users\John\veluno-mainnet
```

Agora cole este comando. Ele cria **uma** chave e mostra o endereço dela:

```
node -e "const fs=require('fs'),{Keypair}=require('@solana/web3.js'),f=process.argv[1];if(fs.existsSync(f)){console.log('JA EXISTE, nada foi feito: '+f)}else{const k=Keypair.generate();fs.writeFileSync(f,JSON.stringify(Array.from(k.secretKey)));console.log(k.publicKey.toBase58())}" C:\Users\John\veluno-mainnet\guardiao.json
```

Aparece uma linha de letras e números: é o **endereço** do guardião. Anote num bloco de notas,
com o nome ao lado.

Repita o mesmo comando mais quatro vezes, trocando só o nome do arquivo no final:

- `C:\Users\John\veluno-mainnet\agente.json`
- `C:\Users\John\veluno-mainnet\keeper.json`
- `C:\Users\John\veluno-mainnet\programa.json`
- `C:\Users\John\veluno-mainnet\buffer.json`

Se aparecer `JA EXISTE, nada foi feito`, o arquivo já estava lá e não foi tocado. O comando
nunca escreve por cima de uma chave.

**O `pagador.json` da mainnet não é criado aqui.** O pagador é a carteira
`G1PhqQ3esibLyM8q4YHnWSUAvhaVvPwxSsPDusmkKTDx`, que já existe. Coloque na pasta uma cópia do
arquivo de chave dela, com o nome `pagador.json`. Se você tem essa carteira só num aplicativo
(Phantom, por exemplo) e não como arquivo, peça ajuda a quem programa para criar o arquivo.
Não cole a chave em nenhum site. (No ensaio da devnet é diferente: lá o pagador é uma chave
nova, criada com o comando acima.)

Para ver o endereço de uma chave que já está na pasta:

```
node -e "const{Keypair}=require('@solana/web3.js');console.log(Keypair.fromSecretKey(Uint8Array.from(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')))).publicKey.toBase58())" C:\Users\John\veluno-mainnet\pagador.json
```

Na mainnet, para `pagador.json` tem que aparecer exatamente
`G1PhqQ3esibLyM8q4YHnWSUAvhaVvPwxSsPDusmkKTDx`. Se aparecer outro endereço, o arquivo não é o
da carteira certa: pare e resolva antes de continuar.

No fim você tem seis endereços anotados (pagador, guardião, agente, keeper, programa, buffer)
e o endereço da tesouraria.

### Colocar SOL nas carteiras

Envie da sua carteira pessoal, para os **endereços** anotados:

| Para | Quanto | Por quê |
|---|---|---|
| pagador | ter **0,5 SOL** | Publicar o programa custa cerca de 0,3 SOL. O lançamento custa cerca de 0,03 SOL. O resto é folga. |
| guardião | **0,01 SOL** | Para ele conseguir agir numa emergência sem você precisar mandar SOL antes. |
| agente | **0,05 SOL** | Taxas de rede dos éditos. É tudo o que um ladrão levaria dessa carteira. |
| keeper | **0,05 SOL** | Taxas de rede dos pagamentos. Esse SOL é dele; ele nunca usa as taxas dos holders para isso. Numa semana de muito movimento ele pode gastar perto de 0,2 SOL: recarregue quando o servidor pedir (`docs/hospedagem.md`). |
| tesouraria | **0,01 SOL** | O keeper se recusa a ligar enquanto nunca houve nada no endereço da tesouraria. É o jeito de ele pegar um endereço digitado errado antes de mandar dinheiro para um lugar de onde ninguém tira. |

Para a tesouraria, copie o endereço daqui: `6Zudkofv2WFz2XdAR43cozs7rJavhyn5UmQw7E9QSDph`.
Antes de enviar, **compare com o endereço que a sua carteira mostra, letra por letra**, do
começo ao fim. Um endereço da Solana com uma letra trocada continua sendo um endereço válido,
só que de ninguém.

---

## 3. O que fica travado para sempre

Depois do lançamento, **ninguém** muda isto, nem você, nem o guardião:

- A **taxa** de 3% por trade, e o quinto dela que fica com a Meteora.
- A **curva**: começa em 30 SOL de valor de mercado e **não gradua**. "Graduar" é o que a
  Meteora faz quando uma curva enche: ela tira o hook do token, e as regras do agente deixam
  de valer. Esta curva só encheria com **9 bilhões de SOL** dentro dela, e todo o SOL que
  existe soma cerca de 635 milhões: 14 vezes menos. (Você confere esse total em qualquer
  explorador da Solana, procurando por "supply". Ele cresce menos de 4% ao ano; nesse ritmo
  levaria uns 175 anos para existirem 9 bilhões de SOL, e todos teriam de estar nesta curva ao
  mesmo tempo.) O número é em SOL e está fixo no código: não depende do preço do SOL no dia do
  lançamento, e não existe linha no `launch.json` para mudá-lo. O resumo da parte 6 mostra
  esse número.
- Os **limites do agente**: um édito a cada 10 minutos no máximo; um édito vale no máximo
  2 horas; a tesouraria recebe no mínimo 40% e no máximo 50% das taxas.
- O **nome** e o **ticker**: Veluno, VELUNO. Com um nome só, ele nunca muda.
- O **endereço do `metadata.json`** (o campo `uri`). O endereço fica gravado no token; o
  arquivo que está nesse endereço continua nosso (parte 5).
- A **quantidade** de tokens: 1 bilhão. Ninguém cria mais.
- **Quem pode retirar as taxas da pool**: só o programa, e só para o keeper que estiver escrito
  no livro de regras.

O que **pode** mudar depois, e só com a chave do guardião. São seis coisas, e nenhuma outra:

1. **pausar** o agente;
2. **despausar** o agente;
3. **trocar o agente** por outra chave;
4. **trocar o keeper** por outra chave (quem escolhe o keeper escolhe para qual chave as taxas
   são entregues dali em diante);
5. **nomear uma chave de app** mais tarde. O token nasce sem chave de app, e por isso nenhum
   hook sobre "o app" vale para ele. Se um dia o guardião nomear uma, o agente passa a poder
   usar esses hooks, e o site passa a mostrá-los. O guardião também pode trocá-la ou tirá-la;
6. **passar o papel de guardião** para outra chave (a chave nova tem que assinar junto).

O comando do guardião (`docs/emergencia.md`) faz as quatro primeiras. As duas últimas existem
no programa, mas o comando ainda não as oferece: se você quiser usá-las, fale com quem
programa.

O que pode mudar com a chave do pagador: **o programa inteiro**. É a única porta que continua
aberta. *Decisão sua:* existe um comando que fecha essa porta para sempre (o programa nunca
mais pode ser corrigido nem trocado). Não faça isso sem conversar com quem programa.

---

## 4. Publicar o programa (gasta SOL de verdade)

Você precisa do **endereço do RPC** da mainnet (parte 1, item 5). Ele é segredo.

Cole, trocando `COLE_O_RPC_AQUI` pelo endereço do RPC. É **uma linha só**:

```
wsl -e bash -lc 'export PATH=$HOME/.local/share/solana/install/active_release/bin:$PATH; solana program deploy $HOME/agent-hook-target/hook/deploy/agent_hook.so --url COLE_O_RPC_AQUI --keypair /mnt/c/Users/John/veluno-mainnet/pagador.json --program-id /mnt/c/Users/John/veluno-mainnet/programa.json --buffer /mnt/c/Users/John/veluno-mainnet/buffer.json'
```

Demora de um a alguns minutos. No fim aparece:

```
Program Id: <um endereço>
```

Esse endereço é o do `programa.json` que você anotou. Confira que é o mesmo.

- **Se parar no meio** (erro de rede, tempo esgotado): rode **exatamente o mesmo comando** de
  novo. Ele continua de onde parou, por causa do `buffer.json`.
- **Custo:** cerca de 0,29 SOL ficam guardados no programa. Para ver o valor exato antes
  (o número é o tamanho do programa, 56752, mais 45):
  `wsl -e bash -lc 'export PATH=$HOME/.local/share/solana/install/active_release/bin:$PATH; solana rent 56797 --url mainnet-beta'`

Para conferir o que foi publicado (troque as duas partes em maiúsculas):

```
wsl -e bash -lc 'export PATH=$HOME/.local/share/solana/install/active_release/bin:$PATH; solana program show COLE_O_PROGRAM_ID --url COLE_O_RPC_AQUI'
```

Tem que mostrar em `Data Length` o número que você anotou na parte 1 (hoje, `56752`) e, na
linha `Authority`, o **endereço do pagador**: é ele quem pode atualizar o programa.

---

## 5. O arquivo de lançamento, linha por linha

Copie o exemplo para a sua pasta:

```
copy launch.example.json C:\Users\John\veluno-mainnet\launch.json
notepad C:\Users\John\veluno-mainnet\launch.json
```

Preencha assim. O que está em **negrito** você troca; o resto já vem certo e **não é para mexer**.

| Linha | O que colocar |
|---|---|
| `"rpc"` | **O endereço do RPC da mainnet**, o mesmo do passo 4. |
| `"hookProgram"` | **O `Program Id` do passo 4.** |
| `"payerKeypair"` | **`"pagador.json"`** (o arquivo está na mesma pasta). |
| `"guardian"` | **O endereço do guardião.** |
| `"agent"` | **O endereço do agente.** |
| `"keeper"` | **O endereço do keeper.** |
| `"feeBps": 300` | A taxa: 3%. Travada para sempre. |
| `"startCapSol": 30` | Onde a curva começa. Travado. Onde ela graduaria não tem linha: ela não gradua (parte 3). |
| `"minIntervalSecs": 600` | O agente escreve no máximo um édito a cada 10 minutos. Travado. |
| `"maxRuleSecs": 7200` | Um édito vale no máximo 2 horas. Travado. |
| `"minTreasuryBps": 4000` | Piso da tesouraria: 40% das taxas. Travado. |
| `"maxTreasuryBps": 5000` | Teto da tesouraria: 50% das taxas. Travado. |
| `"minRenameSecs": 86400` | Não tem efeito com um nome só. Deixe como está. |
| `"split"` | Como as taxas se dividem até o primeiro édito: 30% holders, 30% queima, 40% tesouraria. |
| `"names"` | `Veluno` e `VELUNO`. Travado. |
| `"uri"` | **`"https://www.veluno.li/metadata.json"`**, exatamente assim, com o `www`. Travado. |

Sobre o `uri`:

- **O endereço é permanente.** Ele fica gravado no token e ninguém troca depois.
- **O arquivo continua nosso.** O que está nesse endereço é um arquivo do site
  (`site\metadata.json`), e pode ser editado depois: a descrição, a imagem. O nome e o ticker
  que valem são os gravados no token.
- **O arquivo tem que estar no ar antes do lançamento** (parte 1, item 3). Carteiras e
  exploradores leem esse endereço nos primeiros minutos; se ele não responder, o token aparece
  sem imagem, e alguns demoram a olhar de novo.
- É com `www` porque `https://veluno.li` responde mandando ir para `https://www.veluno.li`, e
  nem todo leitor segue esse desvio.

Atenção:

- Os endereços vão **entre aspas**, sem os sinais `<` e `>` do exemplo.
- **Não** existe linha `feeClaimer`. Se ela aparecer, o comando recusa.
- **Não** existe mais a linha `graduationCapUsd`. O exemplo antigo tinha; se o seu
  `launch.json` foi copiado dele e ainda tem essa linha, **apague a linha inteira**. Enquanto
  ela estiver lá, o comando recusa com `the launch file cannot name a graduationCapUsd`.
- **Não** acrescente a linha `cosigner` (a chave de app): o Veluno nasce sem ela.
- O endereço da tesouraria **não** entra neste arquivo. Ele vai só para o servidor.

Salve e feche.

---

## 6. Conferir antes de lançar (não gasta nada)

```
npm run launch -- C:\Users\John\veluno-mainnet\launch.json
```

Aparece um resumo. **Leia linha por linha** e compare com o que você anotou:

| Linha do resumo | Tem que dizer |
|---|---|
| `network` | `mainnet` |
| `token` | `Veluno (VELUNO), mint ...` (anote o endereço depois de `mint`: é o endereço do token) |
| `hook program` | o `Program Id` do passo 4 |
| `payer` | o endereço do pagador, com o SOL que sobrou |
| `guardian` | o endereço do guardião |
| `agent` | o endereço do agente |
| `keeper` | o endereço do keeper |
| `fee claimer` | um endereço que você não conhece. Está certo: é o livro de regras, que nenhuma chave controla. |
| `app key` | começa com `none: no hook about the app applies to this token` |
| `trading fee` | `3% per trade, of which Meteora keeps 20%` |
| `curve` | `starts at 30 SOL of market cap and cannot graduate` e, na linha de baixo, `9,000,000,000 SOL in the curve, 14 times all the SOL there is (about 635 million)`: é o SOL que teria de estar na curva para ela graduar (parte 3) |
| `limits` | `one edict every 10 minutes at most, an edict stands 2 hours at most` e `treasury never below 40% and never above 50%` |
| `names` | `one, for good` |
| `card` | `https://www.veluno.li/metadata.json` e, na linha de baixo, `answers with the card of Veluno (VELUNO)`. Se nessa linha aparecer `WARNING`, **não lance**: o arquivo não está no ar, ou o endereço não é o certo. |
| `opens with` | `no rule; fees 30% holders, 30% burn, 40% treasury` |

Se aparecer `WARNING` em qualquer outra linha (por exemplo, a mesma chave em duas funções),
pare e leia: é o comando avisando de algo que depois não tem conserto.

A última linha começa com `Nothing was sent.` Nada foi gasto.

Se o comando recusar, ele diz `Nothing was sent:` e uma frase em inglês com o que falta no
arquivo, por exemplo `the launch file needs guardian, a public key`. Corrija e rode de novo.

Na primeira vez, este comando cria `mint.json` e `curve-config.json` na pasta. **Não apague.**
O endereço do token (`mint`) já é o definitivo.

---

## 7. Lançar (gasta SOL de verdade, não tem volta)

Só depois de a conferência da parte 6 estar certa, e de o `metadata.json` estar no ar:

```
npm run launch -- C:\Users\John\veluno-mainnet\launch.json --send --mainnet
```

Aparece o mesmo resumo e depois três linhas, cada uma com o código de uma transação:

```
  create the curve's config: ...
  write the rulebook: ...
  create the pool: ...

  launched. Addresses are in C:\Users\John\veluno-mainnet\token.json
```

- **Se parar no meio:** rode o mesmo comando de novo. Ele pula o que já foi feito.
- **Custo:** cerca de 0,03 SOL.

O arquivo `token.json` tem os endereços de tudo. **Não publique esse arquivo**: ele guarda o
endereço do RPC com a sua chave. Você vai usar ele três vezes: no servidor, no site e no
comando do guardião.

Confira que deu certo:

```
npm run guardian -- C:\Users\John\veluno-mainnet\token.json status
```

Tem que mostrar `network mainnet`, os endereços do guardião, do agente e do keeper, e
`state running`.

### Depois de lançar, nesta ordem

1. **Ligue o servidor logo em seguida**: `docs/hospedagem.md`. Do `token.json` você vai
   precisar de `hookProgram`, `mint` e `pool`. Faça isso antes de divulgar o endereço do
   token: as taxas que entrarem antes de o keeper ligar são contadas todas de uma vez, para
   quem estiver segurando o token no momento em que ele ligar.
2. **Só quando o servidor estiver saudável**, ligue o site (abaixo).
3. Guarde a pasta `C:\Users\John\veluno-mainnet` inteira num pendrive. Depois que o servidor
   estiver rodando, apague `agente.json` e `keeper.json` do computador (ficam no pendrive).

### O site

Abra `site\config.js` no Bloco de Notas e preencha quatro linhas, com os valores do `token.json`:

```
  rulebook: "COLE O rulebook DO token.json",
  program: "COLE O hookProgram DO token.json",
  pool: "COLE O pool DO token.json",
```

e, mais abaixo, a linha `trade` (troque `ENDERECO_DO_TOKEN` pelo `mint` do `token.json`):

```
  trade: [{ label: "Jupiter", url: "https://jup.ag/swap/SOL-ENDERECO_DO_TOKEN" }],
```

Confira também a linha `treasury`. Ela já vem preenchida com
`6Zudkofv2WFz2XdAR43cozs7rJavhyn5UmQw7E9QSDph` e tem que ser **o mesmo endereço** que você
colou em `TREASURY` no servidor: é o que o site mostra como "Treasury" na lista de endereços.

Não mexa nas outras linhas. `feeBps: 300`, `log`, `ledger` e `ledgerFile` já estão certos. A
linha `rpc` é a chave **do site**, que é pública e diferente da do servidor.

Quem programa envia essa alteração para o GitHub; a Vercel publica sozinha em um ou dois
minutos. Enquanto o `rulebook` estiver vazio, o site continua mostrando o ensaio.

Se por algum motivo o site for ligado **antes** do servidor, deixe a linha `ledger` vazia
(`ledger: "",`): a página então diz que o keeper ainda não está rodando. Com o servidor no ar,
volte para `ledger: "data/ledger-head.json",`.
