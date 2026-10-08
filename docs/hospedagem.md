# Ligar o serviço num servidor: passo a passo

Para o dono do projeto. O "serviço" é um programa só, que roda o **agente** e o **keeper** 24
horas e publica os registros deles em `https://agent.veluno.li`. Você liga uma vez e deixa.

Os nomes de botões estão em inglês porque é assim que aparecem nas telas. **Os caminhos de
clique na Railway e na Vercel vêm da documentação delas, lida em 7 de outubro de 2026. Ninguém
percorreu estes passos numa conta de verdade ainda**, então um botão pode estar num lugar um
pouco diferente. O serviço em si foi testado numa rede local.

**No fim você tem:** um serviço na Railway (US$ 5 por mês), com um disco que não se perde, no
endereço `agent.veluno.li`.

**Você vai percorrer este documento duas vezes**, como o `docs/lancamento.md`: primeiro para o
ensaio na devnet, depois para a mainnet.

---

## Onde você está agora

Você já fez duas coisas na Railway:

- criou a conta, no plano **Hobby**;
- importou o repositório do GitHub. Isso criou um **projeto**, com um **serviço** dentro.

Esse serviço ainda **não consegue ligar**: os builds dele falham. Não é defeito da conta.
Quando você importou, o GitHub ainda não tinha esta versão do código, que é a que traz o
arquivo `Dockerfile` de que a Railway precisa. E, como os deploys automáticos estão ligados,
**cada alteração enviada ao GitHub começa mais um build**, que falha de novo.

Faça agora, antes de qualquer outra coisa:

1. **Desligue os deploys automáticos.** Clique no serviço → **Settings** → **Source** → na
   parte que fala do branch, desligue os deploys automáticos (o botão é **Disconnect**; em
   algumas telas aparece como **Disable**). Assim o servidor só passa a rodar código novo
   quando alguém aperta **Deploy latest commit**, e não a cada alteração no GitHub. Isso vale
   para sempre, não só agora: com os deploys automáticos ligados, quem consegue enviar código
   para o repositório consegue rodá-lo ao lado das chaves um minuto depois.
2. **Espere o aviso de quem programa** de que esta versão está no GitHub. Só então os builds
   passam a funcionar. Os que falharam ficam na lista (**Deployments**) com a palavra
   **Failed**: pode deixar, não atrapalham.
3. **No GitHub**: Settings → Password and authentication → ligue a verificação em duas etapas,
   se ainda não estiver ligada. Daqui em diante, quem entra no seu GitHub entra no servidor.

O projeto que você já tem vai servir para o **ensaio na devnet**. O da mainnet você cria
depois, novo (a parte seguinte explica por quê).

---

## O ensaio na devnet (faça primeiro)

É este documento inteiro, com o token de teste que você criou seguindo `docs/lancamento.md`,
parte 0. O que muda:

| Onde | No ensaio |
|---|---|
| Parte 0 (o que ter em mãos) | Tudo vem da pasta `C:\Users\John\veluno-devnet`: o `token.json`, o `agente.json` e o `keeper.json` **do ensaio**. A tesouraria é o endereço do `tesouraria.json` do ensaio. A chave da Anthropic é de verdade (é o único gasto real do ensaio). |
| `RPC_URL` | Um endereço de RPC **da devnet**. Crie agora a conta da Helius do servidor (`docs/lancamento.md`, parte 1, item 5). O endereço de devnet é o mesmo da mainnet, com a mesma chave, trocando `mainnet` por `devnet` no começo: `https://devnet.helius-rpc.com/?api-key=SUA_CHAVE`. O endereço público `https://api.devnet.solana.com` serve para os comandos que você roda em casa, mas não para um serviço que pergunta o dia inteiro. |
| `HOOK_PROGRAM`, `MINT`, `POOL` | Do `token.json` **do ensaio**. |
| `TREASURY` e `KEEPER_OWN_WALLETS` | Os endereços **do ensaio** (pagador, guardião, agente e tesouraria da pasta `veluno-devnet`). A tesouraria do ensaio também precisa de um pouco de SOL de teste. |
| Passo 5 (`agent.veluno.li`) | **Pule.** Esse endereço fica para a mainnet. No ensaio: serviço → **Settings** → **Networking** → **Generate Domain**, porta `8080`. A Railway dá um endereço terminado em `.up.railway.app`. Use ele no lugar de `agent.veluno.li` nos passos 7 e 8. |
| Passo 8 (o site) | **Pule.** No ensaio os três registros abrem direto no endereço da Railway: `/log.jsonl`, `/ledger-head.json` e `/ledger.jsonl`. |
| Passo 9 (cópias e alarmes) | Só os tetos de gasto (itens 3 e 4). Cópias e alarme são para a mainnet. |

**No fim do ensaio, apague o projeto do ensaio inteiro**: no projeto → **Settings** →
**Danger** → **Delete Project**. O disco vai junto.

**Para a mainnet, crie um projeto novo**, do mesmo jeito que você importou o repositório da
primeira vez (**New Project** → **Deploy from GitHub repo**), e desligue os deploys automáticos
dele também. O disco dele nasce vazio.

**A regra: o disco tem que estar vazio antes da mainnet.** Nunca aponte para o token de
verdade um disco que já rodou com a devnet. Esse disco guarda as contas do keeper e o diário do
agente **do token de teste**. Com ele, o keeper para e diz `the books ... are those of keeper
... for token ..., not mine`, e o diário continua com os éditos do token de teste no meio.
Trocar só as variáveis não limpa o disco.

---

## 0. O que ter em mãos antes de começar

Tudo isto vem do lançamento (`docs/lancamento.md`):

| O quê | De onde vem |
|---|---|
| `token.json` | A pasta do lançamento. Dele você usa `hookProgram`, `mint` e `pool`. |
| `agente.json` e `keeper.json` | A pasta do lançamento. São as **chaves** do servidor. |
| O endereço da **tesouraria** | `6Zudkofv2WFz2XdAR43cozs7rJavhyn5UmQw7E9QSDph`. Só o endereço; a chave dela nunca vem para cá. |
| Os endereços do pagador, do guardião e do agente | O pagador é `G1PhqQ3esibLyM8q4YHnWSUAvhaVvPwxSsPDusmkKTDx`. Os outros dois você anotou quando criou as chaves. |
| Uma chave da **Anthropic** | console.anthropic.com → API keys → Create key. A conta precisa ter crédito. |
| O endereço de **RPC** do servidor | O mesmo que você usou no lançamento (`docs/lancamento.md`, parte 1, item 5). É segredo, e não é o do site. |

**Antes de ligar: a tesouraria tem que ter recebido SOL pelo menos uma vez.** Mande 0,01 SOL
para `6Zudkofv2WFz2XdAR43cozs7rJavhyn5UmQw7E9QSDph` e confira num explorador (solscan.io) que
chegou. O keeper se recusa a ligar enquanto nunca houve nada nesse endereço: é como ele pega um
endereço digitado errado antes de mandar para lá 40% a 50% de todas as taxas.

**Três regras que valem para sempre:**

1. A chave do **guardião** e a do **pagador** nunca vão para o servidor.
2. O servidor tem chaves **só dele** (`agente.json`, `keeper.json`). Não use a sua carteira.
3. Nenhuma chave vai para o GitHub, para um chat ou para um print de tela.

---

## 1. Conta na Railway

Já está feito (veja "Onde você está agora"): conta no plano **Hobby** (US$ 5 por mês). O
período de teste gratuito não serviria: ele apaga o disco 30 dias depois que o crédito acaba.

## 2. O projeto e o serviço

No ensaio, é o projeto que você já tem.

Na mainnet, um projeto novo: **New Project** → **Deploy from GitHub repo** →
`devsolusd1/hookdinamic`. Aparece uma caixa com o nome do serviço e ele começa a construir.
Esse primeiro deploy sobe sem as variáveis: o agente e o keeper ficam desligados. Mesmo assim
a Railway mostra o serviço como **ativo** (foi o que aconteceu no servidor de verdade): ela só
pergunta se o serviço responde em `/`, e ele responde assim que a porta abre. **É o esperado, e
não quer dizer que está pronto:** ainda falta configurar. Antes de seguir, desligue os deploys
automáticos desse serviço novo (Settings → Source, como em "Onde você está agora").

## 3. Criar o disco

Clique com o botão direito no fundo vazio da tela → **Volume** (ou Ctrl+K e digite "volume") →
escolha o serviço → em **Mount path** escreva exatamente:

```
/data
```

Nesse disco ficam o diário do agente, o livro público do keeper e as **contas do keeper**
(quanto cada holder ainda tem a receber). Ele sobrevive a reinícios e atualizações.

## 4. Colar as variáveis

Clique no serviço → aba **Variables** → **RAW Editor** → cole o bloco abaixo e troque cada
`COLE...` e cada `ENDERECO...` pelo valor certo. Não deixe espaços antes ou depois do `=`.

```
RPC_URL=COLE_O_RPC_DO_SERVIDOR
HOOK_PROGRAM=COLE_O_hookProgram_DO_token.json
MINT=COLE_O_mint_DO_token.json
POOL=COLE_O_pool_DO_token.json
ANTHROPIC_API_KEY=COLE_A_CHAVE_DA_ANTHROPIC
AGENT_KEYPAIR_JSON=COLE_TUDO_O_QUE_ESTA_DENTRO_DE_agente.json
KEEPER_KEYPAIR_JSON=COLE_TUDO_O_QUE_ESTA_DENTRO_DE_keeper.json
TREASURY=6Zudkofv2WFz2XdAR43cozs7rJavhyn5UmQw7E9QSDph
KEEPER_OWN_WALLETS=G1PhqQ3esibLyM8q4YHnWSUAvhaVvPwxSsPDusmkKTDx,ENDERECO_DO_GUARDIAO,ENDERECO_DO_AGENTE,6Zudkofv2WFz2XdAR43cozs7rJavhyn5UmQw7E9QSDph
AGENT_POLL_SECS=60
PORT=8080
DRY_RUN=1
```

De onde vem cada valor:

| Variável | O que é |
|---|---|
| `RPC_URL` | O endereço do RPC **do servidor** (parte 0). |
| `HOOK_PROGRAM`, `MINT`, `POOL` | Abra o `token.json` no Bloco de Notas. São as linhas `hookProgram`, `mint` e `pool`, sem as aspas. |
| `ANTHROPIC_API_KEY` | A chave criada em console.anthropic.com. |
| `AGENT_KEYPAIR_JSON` | Abra `agente.json` no Bloco de Notas, selecione tudo (Ctrl+A), copie e cole. Começa com `[` e termina com `]`. |
| `KEEPER_KEYPAIR_JSON` | O mesmo, com `keeper.json`. |
| `TREASURY` | O **endereço** da tesouraria: `6Zudkofv2WFz2XdAR43cozs7rJavhyn5UmQw7E9QSDph`. Depois de colar, **compare com o endereço que a sua carteira mostra, letra por letra**, do começo ao fim: um endereço com uma letra trocada continua válido, só que de ninguém. Não pode ser o endereço do keeper: o serviço recusa. |
| `KEEPER_OWN_WALLETS` | As carteiras do próprio projeto, separadas por vírgula, sem espaço: o pagador (`G1PhqQ3esibLyM8q4YHnWSUAvhaVvPwxSsPDusmkKTDx`), o guardião, o agente e a tesouraria. Elas nunca recebem como holder. *Decisão sua:* acrescente toda outra carteira sua que for segurar o token. (O keeper e a tesouraria já ficam de fora sozinhos; a tesouraria está na lista só para não haver dúvida.) |
| `AGENT_POLL_SECS=60` | De quanto em quanto tempo o agente confere se é hora de escrever. 60 gasta um terço do RPC. |
| `PORT=8080` | A porta. Tem que ser a mesma do passo 5. |
| `DRY_RUN=1` | **Ensaio:** o agente e o keeper calculam e mostram o que fariam, mas não enviam nada. Fica assim só até o passo 7, **por alguns minutos**: enquanto está ligado, o agente consulta o modelo de verdade, e isso custa. No ensaio o agente monta a transação do édito sem assinar nem enviar, e a linha dele nos logs termina dizendo como o texto ficaria gravado na blockchain (o "memo"): `memo: the announcement, whole` quer dizer inteiro; `memo, cut to the first ...` quer dizer que seria cortado, e mostra até onde. |
| `AGENT_PRIORITY_MICROLAMPORTS` | **Não está no bloco acima: sem essa linha vale o padrão, `50000`.** É a taxa de prioridade do édito: quanto o agente oferece à rede para a transação dele entrar logo num bloco. O padrão é um preço para dias calmos: cada édito custa perto de 0,00001 SOL (no máximo 0,000026 SOL). **No dia do lançamento na mainnet, use `1000000`:** acrescente a linha `AGENT_PRIORITY_MICROLAMPORTS=1000000` antes de ligar de verdade (passo 7) e aperte Deploy. Nesse dia o édito disputa lugar no bloco com as compras do token, e um édito que não entra deixa o token uns seis minutos sem regra. Com `1000000` cada édito custa perto de **0,0001 SOL** (no máximo 0,00043 SOL), e os 0,05 SOL da carteira do agente dão para uns **500 éditos** (com o padrão, uns 5 mil). Passado o movimento, apague a linha ou volte para `50000`. *A decisão é sua.* O custo sai do SOL da carteira do agente; se faltar, o `/health` avisa (`the agent's wallet needs topping up`). Escreva só algarismos, sem ponto nem vírgula (`50.000` é recusado: o agente fica desligado e o `/health` diz por quê, até você corrigir). `0` não oferece nada; o máximo aceito é `5000000`. Ao ligar, o serviço mostra nos logs o valor em uso: `agent: an edict bids 1,000,000 micro-lamports ...` (ou `50,000`, com o padrão). |
| `KEEPER_SETTINGS` | **Opcional. Não está no bloco acima: sem essa linha valem os padrões do keeper.** Só uma coisa aqui interessa a você: a taxa de prioridade do keeper, `microLamportsPerUnit`. O padrão é `10000`. Para subir, a linha é exatamente assim, com as chaves e as aspas: `KEEPER_SETTINGS={"microLamportsPerUnit":50000}` e depois Deploy. Quando subir e para quanto está em "Se as transações não entram", mais abaixo. Tem que ser um número inteiro, no máximo `10000000`. Um erro nessa linha desliga **só o keeper**, na hora de ligar (o agente continua): os logs mostram `keeper: stopped: ...` e o `/health` mostra `the keeper is not running: ...`, com o motivo. |

Depois, em cada uma destas quatro linhas, clique nos três pontinhos → **Seal**:
`AGENT_KEYPAIR_JSON`, `KEEPER_KEYPAIR_JSON`, `ANTHROPIC_API_KEY`, `RPC_URL`. "Seal" faz o valor
nunca mais aparecer na tela, nem para você. Por isso as chaves ficam guardadas também no
pendrive.

Aperte **Deploy** na faixa que aparece no topo.

## 5. O endereço agent.veluno.li

(Só na mainnet. No ensaio, use o endereço que a Railway gera: veja "O ensaio na devnet".)

Na Railway: serviço → **Settings** → **Networking** → **Public Networking** →
**+ Custom Domain** → escreva `agent.veluno.li`, porta `8080`. A Railway mostra **dois
registros**, um CNAME e um TXT. Deixe essa janela aberta.

Na Vercel: painel → **Domains** (menu lateral) → `veluno.li` → **DNS Records** → adicione os
dois:

| Name | Type | Value |
|---|---|---|
| `agent` | CNAME | o valor que a Railway mostra (parecido com `abc123.up.railway.app`) |
| o nome que a Railway mostra para o TXT | TXT | o valor que a Railway mostra |

No campo Name da Vercel vai só o começo, sem `.veluno.li`. Os dois registros são obrigatórios.
Volte à Railway e espere o sinal verde ao lado do domínio (costuma levar minutos).

## 6. Conferir que os deploys automáticos estão desligados

Serviço → **Settings** → **Source**. Você já desligou no começo; confira que continua
desligado, neste serviço. É ele que roda ao lado das chaves.

## 7. Conferir que está saudável, e só então ligar de verdade

### Como ver

Abra no navegador:

```
https://agent.veluno.li/health
```

Saudável é assim (os valores mudam):

```
{
  "ok": true,
  "problems": [],
  "dryRun": true,
  "agent":  { "on": true, "last": "in-force", "address": "...", "errorsInARow": 0, ... },
  "keeper": { "on": true, "last": "waiting",  "address": "...", "saying": "nothing is due: ...", ... },
  "records": { ... },
  "diskFreeMb": 4871
}
```

O que olhar:

- `"ok": true` e `"problems": []`.
- `"agent"` → `"on": true`, o `"address"` é o **endereço do agente** que você anotou, e
  `"last"` **não** é `"error"`.
- `"keeper"` → `"on": true`, o `"address"` é o **endereço do keeper** que você anotou, e
  `"last"` **não** é `"error"`.
- `"dryRun": true` enquanto o `DRY_RUN=1` estiver lá.

Se `"last"` for `"error"` em um dos dois, alguma coisa está errada mesmo que `"ok"` ainda diga
`true`: recarregue a página em um minuto e leia `"lastError"` e a lista `"problems"`.

Se a página não abrir, ou a Railway disser **Healthcheck failed**: serviço → **Deployments** →
o último → **View logs**. As últimas linhas dizem o motivo, do mesmo jeito que a tabela abaixo.

### Se `"ok"` for `false`

A lista `"problems"` diz o motivo, em inglês. Os mais comuns:

| O que aparece | O que quer dizer | O que fazer |
|---|---|---|
| `still starting` | Acabou de ligar. | Espere um minuto e recarregue. |
| `the agent is not running: ... is not set` | Faltou uma variável. | Volte ao passo 4 e confira o nome que aparece. |
| `... is not a keypair ...` | A chave foi colada pela metade. | Cole de novo, do `[` ao `]`. |
| `the agent keeps failing: ... is not this token's agent` | A chave no servidor não é a do agente deste token. | Confira `AGENT_KEYPAIR_JSON` e `MINT`. |
| `the keeper keeps failing: the rulebook names ... as the keeper, not my key` | A chave no servidor não é a do keeper deste token. | Confira `KEEPER_KEYPAIR_JSON` e `MINT`. (Depois de uma troca de keeper pelo guardião a linha é outra: a de baixo.) |
| `the keeper has finished and no keeper runs here now: ... stopped for good` | **Não é falha.** O guardião trocou o keeper, e o keeper deste servidor pagou o que devia e parou. O `"ok"` fica `false` porque daí em diante nenhum keeper roda aqui: as taxas esperam na pool pelo keeper novo. | Chame quem programa para ligar o keeper novo: veja `docs/emergencia.md`, parte 5. Enquanto isso, `KEEPER_OFF=1` em Variables (e Deploy) tira o aviso e deixa o resto rodando. |
| `... has not worked since it started: ...` | O agente ou o keeper ainda não conseguiu dar um passo desde que ligou. Quase sempre é uma variável errada. | Leia o resto da frase e confira o passo 4. |
| `... there is nothing at the treasury's address ...` | Não há nada no endereço que está em `TREASURY`: ou nunca houve, ou a carteira foi esvaziada até zero (o keeper confere isso cada vez que o serviço liga). | Compare `TREASURY` com a carteira, letra por letra. Se estiver certo, mande 0,01 SOL para ela: o keeper liga sozinho quando o SOL chegar. Ao tirar SOL da tesouraria, deixe sempre um pouco nela. |
| `... the treasury's address ... is not a wallet ...` | O endereço em `TREASURY` não é de uma carteira (é de um programa ou de uma conta de token). SOL mandado para lá nunca sairia. | Corrija `TREASURY`. O keeper não faz nada enquanto isso. |
| `... the books ... are those of keeper ... for token ..., not mine` | O disco é de outro token (o do ensaio, por exemplo). | Não use esse disco. Veja "O ensaio na devnet". |
| `the keeper's wallet needs topping up` | O keeper ficou sem SOL para as taxas de rede. | Mande 0,05 SOL para o endereço do keeper (0,2 SOL se o movimento estiver grande). |
| `the agent's wallet needs topping up` | Chegou a hora de um édito e a carteira do agente não tem SOL para ter certeza de pagar por ele. **Enquanto isso o agente não escreve éditos**: quando o édito em vigor vence, o token fica sem regra e qualquer compra passa. Ele nem consulta o modelo, então não gasta nada esperando. | Mande SOL para o endereço do agente (0,05 SOL; é o `"address"` de `"agent"` no `/health`, e `"wallet"` ali diz quanto falta). Não precisa reiniciar: ele continua sozinho na conferência seguinte, em até um minuto. |
| `the keeper's transactions are not landing` | Três rodadas seguidas do keeper terminaram com uma transação que não entrou em nenhum bloco, e nenhuma entrou no meio (uns cinco minutos assim). **Nada se perde:** uma transação que não entra não custa nada e não move nada, e o keeper tenta de novo. As taxas continuam esperando na pool. | Se as compras e vendas do token estão passando normalmente, o preço que o keeper oferece está baixo para o movimento do dia: suba-o. Veja "Se as transações não entram", mais abaixo. O aviso some sozinho quando uma transação dele entrar. |
| `the agent keeps failing: ...` (outro motivo) | Em geral o RPC ou a Anthropic fora do ar. Se a frase termina em `has expired: block height exceeded`, o édito não entrou em nenhum bloco. | Veja os logs. Para o édito que não entra, veja "Se as transações não entram", mais abaixo. Se durar mais de uma hora, chame quem programa. |
| `the keeper keeps failing: ... until a person has looked` | As contas do keeper não batem com a rede. Ele parou de propósito. | **Não apague nada.** Chame quem programa. |
| `edict N is on chain and its text is not in the log` | Alguém escreveu um édito com a chave do agente fora deste servidor. | Se não foi você rodando o agente em casa, trate como chave roubada: `docs/emergencia.md`. |
| `the agent has gone silent` / `the keeper has gone silent` | Travou. | Deployments → três pontinhos → **Restart**. |
| `the disk is nearly full` | O disco encheu. | Chame quem programa. O agente não escreve éditos sem espaço para guardar o texto. |

### Ler o ensaio e ligar de verdade

1. Na Railway: serviço → **Deployments** → o que está rodando → **View logs**. Em até um minuto
   aparecem linhas como:
   - `agent: would issue an edict (dry run, nothing sent): ...` (o que o agente escreveria)
   - `keeper: ...` com o que o keeper faria, ou `keeper: waiting: nothing is due: ...`

   Se no começo dos logs aparecer `bigint: Failed to load bindings, pure JS will be used`, é
   normal: não é erro.
2. Leu e fez sentido? Não deixe o `DRY_RUN` ligado por horas. Volte em **Variables**, **apague
   a linha `DRY_RUN`** e aperte **Deploy**. A partir daqui o agente escreve éditos de verdade e
   o keeper paga de verdade. **Na mainnet, no dia do lançamento**, acrescente na mesma hora a
   linha `AGENT_PRIORITY_MICROLAMPORTS=1000000` (passo 4), para os éditos entrarem nos blocos
   mesmo com muito movimento.
3. Abra `/health` de novo: `"dryRun": false` e `"ok": true`.

## 8. O site

(Só na mainnet.)

O `vercel.json` do projeto já manda a Vercel buscar os registros no serviço. Depois que o site
for publicado com os endereços do token (fim do `docs/lancamento.md`), confira que estes três
abrem:

```
https://www.veluno.li/data/log.jsonl
https://www.veluno.li/data/ledger-head.json
https://www.veluno.li/data/ledger.jsonl
```

O primeiro mostra o diário do agente (pode estar vazio até o primeiro édito). O segundo mostra
só zeros e o terceiro fica vazio até o keeper fazer a primeira retirada de taxas. Com
`DRY_RUN=1` os três ficam vazios.

## 9. Cópias e alarmes (20 minutos, uma vez)

1. **Cópia do disco.** Na Railway, clique no disco (Volume) → **Backups** → agende **Daily** e
   **Weekly**. Isto é o mais importante da lista: as contas do keeper (quanto cada holder ainda
   tem a receber) só existem nesse disco. Se a aba Backups não aparecer no seu plano, avise
   quem programa.
2. **Alarme.** Em uptimerobot.com (plano gratuito): **New monitor** → HTTP(s) → endereço
   `https://agent.veluno.li/health` → a cada 5 minutos → aviso por e-mail. Se algo travar, você
   recebe um e-mail. Sem isso ninguém fica sabendo: a Railway só confere se o serviço responde,
   e só na hora de ligar. Ela não lê o `/health`.
3. **Teto de gasto na Railway.** Menu da conta → **Usage** → aviso por e-mail em US$ 8 e limite
   máximo em US$ 20. (O limite máximo desliga o serviço quando é atingido; por isso fica bem
   acima do gasto normal.)
4. **Teto de gasto na Anthropic.** Em console.anthropic.com, defina um limite mensal para a
   chave (por exemplo US$ 60).

---

## Quanto custa

| O quê | Quanto | Observação |
|---|---|---|
| Railway, plano Hobby | **US$ 5 por mês** | Inclui US$ 5 de uso. Este serviço usa perto de US$ 2 a 3. |
| Anthropic (o modelo do agente) | **cerca de US$ 1 por dia** | Medido na devnet: 2,5 a 3,5 centavos por édito. Se o agente escolher éditos curtos, passa disso. Por isso o teto. |
| RPC do servidor (Helius) | **US$ 0 no começo** | O plano gratuito deve bastar para o servidor. É uma estimativa: ainda não foi medido com o keeper na mainnet. O plano seguinte custa US$ 49 por mês. |
| RPC do site (Helius, outra conta) | **US$ 49 por mês a partir do dia em que o site for divulgado** | O plano gratuito serve para o ensaio e para uma página que quase ninguém abre: aguenta cerca de dez abas abertas ao mesmo tempo. No dia do anúncio isso acaba em minutos, e a página passa a dizer que não alcança a blockchain. Contrate o plano Developer **antes** de divulgar, com a cobrança por uso extra desligada. |
| Vercel (o site) | o plano que você já usa | |
| Taxas de rede do agente e do keeper | centavos por dia | Saem dos 0,05 SOL de cada carteira. Numa semana de muito movimento o keeper pode gastar perto de 0,2 SOL. No dia do lançamento, com `AGENT_PRIORITY_MICROLAMPORTS=1000000`, cada édito custa perto de 0,0001 SOL: os 0,05 SOL do agente dão para uns 500. Recarregue quando o `/health` pedir (`the keeper's wallet needs topping up` ou `the agent's wallet needs topping up`). |

Os preços são os que as páginas dos provedores mostravam em 7 de outubro de 2026. Confira antes de pagar.

---

## No dia a dia

- **Ver se está tudo bem:** `https://agent.veluno.li/health`.
- **Ver o que o agente e o keeper andam dizendo:** Railway → serviço → Deployments → View logs.
- **Parar só o agente, sem tirar os registros do ar:** Variables → acrescente `AGENT_OFF=1` →
  Deploy. Para voltar, apague a linha e Deploy. Para o keeper é `KEEPER_OFF=1`.
- **Reiniciar:** Deployments → três pontinhos → **Restart**. Não perde nada: o serviço termina o
  passo que estava fazendo, e ao voltar lê a blockchain e os arquivos e continua de onde estava.
- **Atualizar para código novo:** Deployments → **Deploy latest commit**, quando quem programa
  disser que pode.
- **Trocar uma chave do servidor** (depois de usar o comando do guardião): Variables → cole o
  conteúdo da chave nova em `AGENT_KEYPAIR_JSON` ou `KEEPER_KEYPAIR_JSON` → Seal → Deploy.
  Para a chave do keeper, fale antes com quem programa, e não troque a variável enquanto o
  `/health` não disser `stopped for good`: até lá o keeper antigo está pagando o que já tinha
  retirado (`docs/emergencia.md`, parte 5). As contas do keeper antigo não passam sozinhas
  para o novo.
- **Trocar o RPC do servidor** (a chave da Helius): Variables → `RPC_URL` → Seal → Deploy. E
  troque também a linha `rpc` do `token.json` no seu computador: é por ela que o comando do
  guardião fala com a rede (`docs/emergencia.md`).

**Parar o serviço na Railway não tira o poder de uma chave roubada.** Para isso existe o
guardião: `docs/emergencia.md`.

**Nunca ligue dois serviços com as mesmas chaves.** Dois na mesma máquina se recusam; em duas
máquinas nada impede, e cada um estraga o registro do outro.

---

## Se as transações não entram

Num dia de muito movimento na Solana, como o do lançamento, as transações disputam lugar nos
blocos, e entra antes quem oferece mais. Essa oferta é a **taxa de prioridade**. O agente e o
keeper têm cada um a sua, em variáveis diferentes. Uma transação que não entra **não custa
nada e não move nada**: nenhum SOL se perde por isso. O que se perde é tempo.

### O keeper

**Como aparece.** No `/health`, depois de uns cinco minutos assim, a lista `"problems"` traz
`the keeper's transactions are not landing`. Nos logs (Deployments → View logs) é
inconfundível: a cada minuto e meio ou dois aparece uma linha como

```
keeper: my claim ... never landed and no longer can: nothing moved, and I start it again
```

sempre com um código de transação novo, e sem nenhuma linha `keeper: claimed ...` entre elas.
A mesma frase pode vir com `my payment to the treasury` ou `my buyback` no lugar de
`my claim`. Para os pagamentos aos holders são linhas `keeper: transaction ... expired` e,
no fim da rodada, `keeper: paid 0 holders 0 SOL in 0 transactions (round N); M put off to the
next round`. Depois de três rodadas seguidas assim o serviço diz uma vez
`keeper: its transactions are not landing: ...`, e quando voltar ao normal diz
`keeper: its transactions are landing again`.

**Quando mexer.** Quando isso aparece **e** as compras e vendas do token estão passando
normalmente (você vê os trades num explorador). Aí o problema é o preço. Se as transações de
todo mundo estão falhando, é a rede: espere.

**O que fazer.** Suba a oferta do keeper um degrau de cada vez, em **Variables**, e aperte
Deploy depois de cada um:

| Degrau | A linha, exatamente assim | Quanto o keeper gasta numa hora de movimento contínuo |
|---|---|---|
| (padrão) | sem a linha: vale `10000` | perto de 0,001 SOL |
| 1 | `KEEPER_SETTINGS={"microLamportsPerUnit":50000}` | perto de 0,002 SOL |
| 2 | `KEEPER_SETTINGS={"microLamportsPerUnit":200000}` | perto de 0,005 SOL |
| 3 | `KEEPER_SETTINGS={"microLamportsPerUnit":1000000}` | 0,02 a 0,04 SOL |

Depois de cada degrau, espere uns dez minutos e olhe os logs: se aparecer `keeper: claimed ...`
(ou `keeper: its transactions are landing again`), resolveu, e o aviso some do `/health`. Se
as linhas `never landed` continuarem, vá para o degrau seguinte.

- **Antes do degrau 3, deixe 0,5 SOL na carteira do keeper.** A `1000000` cada retirada de
  taxas custa 0,000155 SOL e cada recompra 0,000255 SOL, e os 0,05 SOL do começo acabariam em
  uma ou duas horas. O endereço do keeper é o `"address"` de `"keeper"` no `/health`.
- Depois de cada Deploy, abra o `/health`. Se aparecer `the keeper is not running: ...`, a
  linha foi escrita errada (faltou uma aspa ou uma chave, ou o número passou de `10000000`):
  corrija e aperte Deploy de novo. O agente continua rodando enquanto isso.
- Se já existir uma linha `KEEPER_SETTINGS` com outras coisas dentro, não troque a linha
  inteira: chame quem programa para acrescentar o número dentro das mesmas chaves.
- O que já estava assinado quando você trocou o número continua com o preço antigo por mais um
  minuto e meio; só depois o keeper assina de novo, com o preço novo. Nada é pago duas vezes
  por causa da troca.
- Passado o movimento, apague a linha `KEEPER_SETTINGS` (ou volte para `50000`) e aperte
  Deploy.
- Se em vez disso os logs mostrarem `keeper: sending ...:` seguido de um erro, é o RPC
  recusando o envio. Subir o preço não ajuda: confira o `RPC_URL` e chame quem programa.

### O agente

A oferta do agente é a variável `AGENT_PRIORITY_MICROLAMPORTS` (passo 4). **No dia do
lançamento ela deve estar em `1000000` desde o começo**: cada édito custa perto de 0,0001 SOL,
e os 0,05 SOL do agente dão para uns 500 éditos.

Um édito que não entra aparece nos logs como
`agent: error: Signature ... has expired: block height exceeded.` O agente tenta de novo
sozinho, uns seis minutos depois, e consulta o modelo outra vez (isso custa alguns centavos).
Nesse intervalo, se o édito anterior já venceu, o token fica sem regra. Depois de três
seguidos o `/health` mostra `the agent keeps failing: ... has expired: block height exceeded`.

Se isso acontecer com `1000000`, suba para `2000000` e, se continuar, para `5000000`, que é o
máximo aceito. A `5000000` um édito custa perto de 0,0004 SOL (no máximo 0,002 SOL): mande
antes mais 0,1 SOL para o agente, e volte para `50000` quando o movimento passar.

### Os dois avisos de carteira

| No `/health` | O que fazer |
|---|---|
| `the agent's wallet needs topping up` | Mande 0,05 SOL para o endereço do agente. Enquanto falta, ele não escreve éditos. |
| `the keeper's wallet needs topping up` | Mande 0,05 SOL para o endereço do keeper (0,5 SOL se a oferta dele estiver em `1000000`). Enquanto falta, ele não retira nem paga; nada do que é dos holders é usado para taxas. |

Nenhum dos dois precisa de reinício: cada um continua sozinho quando o SOL chega.

---

## Opcional: uma cópia dos registros públicos fora da Railway

Serve para o diário do agente e o livro público do keeper sobreviverem até à perda da conta da
Railway. Não copia as contas privadas do keeper (para isso é o item 1 da parte 9).

1. No GitHub: **New repository** → nome `veluno-records`, público.
2. **Add file** → **Create new file** → no nome escreva `.github/workflows/copy-records.yml` →
   cole o texto abaixo → **Commit**.
3. Aba **Actions** → "Copy the records" → **Run workflow**, uma vez, e veja ficar verde. Depois
   roda sozinho de hora em hora, sem senha nenhuma.
4. Na Railway, acrescente a variável (trocando `SEU_USUARIO`) e aperte Deploy:
   `RESTORE_FROM=https://raw.githubusercontent.com/SEU_USUARIO/veluno-records/main`
   Com ela, se o disco um dia vier vazio, o serviço busca os dois registros de volta antes de
   escrever qualquer coisa. Nesse caso o keeper **para e pede uma pessoa**, porque as contas
   privadas dele não voltaram: é o certo.

```yaml
name: Copy the records

on:
  schedule:
    # Once an hour, away from the top of the hour, when GitHub is busiest.
    - cron: "17 * * * *"
  workflow_dispatch:

permissions:
  contents: write

concurrency: copy-records

jobs:
  copy:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@v4

      - name: Fetch both records
        run: |
          set -euo pipefail
          for name in log ledger; do
            curl --fail --silent --show-error --max-time 60 --retry 3 --output "$name.new" "https://agent.veluno.li/$name.jsonl"
            # A record only ever grows. If what came back does not start with the copy kept
            # here, the copy stays as it is and the run fails, which GitHub reports by e-mail.
            if [ -s "$name.jsonl" ] && ! cmp --silent --bytes="$(wc -c < "$name.jsonl")" "$name.jsonl" "$name.new"; then
              echo "::error::$name.jsonl no longer starts with the copy kept here"
              exit 1
            fi
            mv "$name.new" "$name.jsonl"
          done

      - name: Commit what changed
        run: |
          git config user.name "records"
          git config user.email "records@users.noreply.github.com"
          git add log.jsonl ledger.jsonl
          git diff --cached --quiet || git commit --message "The records as of $(date --utc +%Y-%m-%dT%H:%MZ)"
          git push

      # Last, so that a service in trouble is still copied. A failure here is the alarm of last resort.
      - name: Ask the service how it is
        run: curl --fail --silent --show-error --max-time 30 https://agent.veluno.li/health
```

Este arquivo de cópia e a volta dos registros por `RESTORE_FROM` foram testados só em parte: a
volta foi testada offline; o arquivo acima nunca rodou no GitHub.
