# Emergência: o comando do guardião

Para o dono do projeto. Este é o freio. Ele roda **do seu computador**, com a chave do
guardião (`guardiao.json`), que nunca vai para o servidor.

Os comandos são para colar no **PowerShell**, aberto na pasta do projeto
(`C:\Users\John\RafinhaProject\agent-hook-token`). As respostas aparecem em inglês; este
documento diz o que procurar nelas. Se a primeira linha for
`bigint: Failed to load bindings, pure JS will be used (try npm run rebuild?)`, é normal: não
é erro.

**Ensaiado numa rede local de teste**, com o serviço rodando: pausar, despausar, trocar o
agente, trocar o keeper, e a recusa de uma chave errada. **Ainda não foi rodado na devnet nem
na mainnet.** Ensaie uma vez na devnet antes do lançamento (fim deste documento).

---

## O que o guardião pode e não pode

A chave do guardião pode seis coisas, e nenhuma outra:

| Pode | Como se faz |
|---|---|
| **Pausar** o agente | Este comando: `pause` (parte 2). |
| **Despausar** o agente | Este comando: `resume` (parte 3). |
| **Trocar o agente** por outra chave | Este comando: `agent` (parte 4). |
| **Trocar o keeper** por outra chave | Este comando: `keeper` (parte 5). |
| **Nomear uma chave de app** mais tarde | Existe no programa. Este comando ainda não oferece: fale com quem programa. |
| **Passar o papel de guardião** para outra chave | Existe no programa (a chave nova tem que assinar junto). Este comando ainda não oferece: fale com quem programa. |

O guardião **não pode**: escrever ou apagar uma regra; mudar os limites, a taxa, a curva ou o
nome; tirar SOL ou tokens da carteira de alguém, nem da pool.

**Sobre o dinheiro.** O guardião não move dinheiro nenhum. Mas é ele quem escolhe o keeper, e
as taxas são entregues ao keeper. Quem tiver a chave do guardião pode nomear um keeper dele e
ficar com as taxas dali em diante. Por isso essa chave fica fora do servidor, e vale tanto
quanto o que o token arrecada.

**Sobre a chave de app.** O token nasce sem chave de app, e por isso nenhum hook sobre "o app"
vale para ele. Isso **não** é travado para sempre: o guardião pode nomear uma chave de app
mais tarde, trocá-la ou tirá-la. A partir de então o agente passa a poder usar os hooks sobre
o app, e o site passa a mostrá-los.

Com o agente **pausado**: o agente não consegue escrever nada, e **nenhuma regra de compra
vale** (toda compra passa). Vender nunca foi restrito. O keeper continua pagando normalmente.

**Parar o serviço na Railway não resolve uma chave roubada.** Quem copiou a chave continua
podendo usá-la de qualquer lugar. Só o guardião tira o poder dela.

---

## O que você precisa

1. O arquivo `token.json` do lançamento (`C:\Users\John\veluno-mainnet\token.json`).
2. O arquivo `guardiao.json` (`C:\Users\John\veluno-mainnet\guardiao.json`, ou o pendrive).
3. Um pouco de SOL na carteira do guardião (0,01 SOL dura anos: cada comando custa 0,000005).

Todo comando tem duas formas:

- **Sem `--send`:** só mostra o que faria e pergunta à rede se seria aceito. **Não envia nada.**
- **Com `--send --mainnet` no fim:** faz.

Sempre rode primeiro sem, leia, e depois repita com `--send --mainnet`. (Na devnet é só `--send`.)

### Se o comando não conseguir falar com a rede

O comando fala com a Solana pelo endereço que está na linha `rpc` do `token.json`. Esse é o
RPC **do servidor**, com a chave dele. Se essa chave tiver sido apagada (parte 6), ou se a
cota dela tiver acabado bem na hora em que você precisa pausar, o comando para e diz:

```
  I could not get an answer from the node at https://...
  Nothing was sent.
```

Rode o **mesmo comando** de novo, acrescentando no fim `--rpc` e outro endereço. O endereço
público da Solana, `https://api.mainnet-beta.solana.com`, basta para as poucas chamadas deste
comando:

```
npm run guardian -- C:\Users\John\veluno-mainnet\token.json status --rpc https://api.mainnet-beta.solana.com
```

```
npm run guardian -- C:\Users\John\veluno-mainnet\token.json pause --key C:\Users\John\veluno-mainnet\guardiao.json --send --mainnet --rpc https://api.mainnet-beta.solana.com
```

Vale para todas as ações (`status`, `pause`, `resume`, `agent`, `keeper`): é sempre o comando
normal, mais `--rpc <endereço>`. Na devnet o endereço público é
`https://api.devnet.solana.com`.

Depois de trocar a chave da Helius do servidor, abra o `token.json` no Bloco de Notas e troque
a linha `rpc` pelo endereço novo. Assim o comando volta a funcionar sem `--rpc`.

---

## 1. Olhar sem mexer

```
npm run guardian -- C:\Users\John\veluno-mainnet\token.json status
```

Não precisa de chave. Mostra:

```
  network     mainnet
  token       Veluno (VELUNO), mint ...
  rulebook    ...
  guardian    ...      <- o endereço do guardião
  agent       ...      <- quem é o agente agora
  keeper      ...      <- quem é o keeper agora
  app key     none: no hook about an app applies   <- ou o endereço da chave de app, se o guardião nomeou uma
  state       running  <- ou PAUSED
  edicts      57 so far
  in force    ...      <- a regra em vigor, em palavras
```

Use sempre que estiver em dúvida, e depois de cada comando abaixo para conferir.

---

## 2. Pausar o agente

**Quando:** o agente está escrevendo regras estranhas; você acha que a chave do agente vazou;
o servidor foi invadido; ou você só quer que tudo pare enquanto pensa.

Primeiro o ensaio:

```
npm run guardian -- C:\Users\John\veluno-mainnet\token.json pause --key C:\Users\John\veluno-mainnet\guardiao.json
```

Tem que aparecer `PAUSE the agent.`, depois `The chain would accept it.` e `Nothing was sent.`

Agora de verdade:

```
npm run guardian -- C:\Users\John\veluno-mainnet\token.json pause --key C:\Users\John\veluno-mainnet\guardiao.json --send --mainnet
```

Tem que terminar com:

```
  state       PAUSED: the agent can issue nothing and no rule is enforced
  ...
  The rulebook shows the change.
```

A pausa vale na hora, na blockchain. Já o `/health` do servidor leva um pouco para mostrar: em
um minuto, no máximo cinco, ele mostra o agente com `"last": "paused"`.

## 3. Despausar

**Quando:** o problema foi resolvido.

```
npm run guardian -- C:\Users\John\veluno-mainnet\token.json resume --key C:\Users\John\veluno-mainnet\guardiao.json --send --mainnet
```

Termina com `state       running` e `The rulebook shows the change.` Se o último édito ainda
estava dentro do prazo, a regra dele volta a valer na hora.

A blockchain já aceita o agente de novo na hora. O servidor nota na próxima vez que lê o livro
de regras: em geral em um minuto, no máximo em cinco. Nesse meio tempo o `/health` continua
mostrando `"last": "paused"`. Não é defeito.

---

## 4. Trocar o agente

**Quando:** a chave do agente vazou ou pode ter vazado. Com a chave do agente, um ladrão
consegue **fechar as compras** e mexer na divisão das taxas dentro do limite. Ele **não**
consegue tirar dinheiro de ninguém.

1. **Pause** (parte 2). Isso já tira o poder da chave roubada.
2. Crie uma chave nova, em outro arquivo (o comando está em `docs/lancamento.md`, parte 2):
   por exemplo `C:\Users\John\veluno-mainnet\agente2.json`. Anote o **endereço** que aparecer.
   Mande 0,05 SOL para ele.
3. Ensaio (troque `ENDERECO_NOVO`):

   ```
   npm run guardian -- C:\Users\John\veluno-mainnet\token.json agent ENDERECO_NOVO --key C:\Users\John\veluno-mainnet\guardiao.json
   ```

   Confira as duas linhas `old agent` (o endereço antigo) e `new agent` (o que você acabou de
   anotar), e `The chain would accept it.`
4. De verdade: o mesmo comando com `--send --mainnet` no fim. Termina com
   `The rulebook shows the change.`
5. No servidor (Railway → Variables): cole o conteúdo de `agente2.json` em
   `AGENT_KEYPAIR_JSON` → Seal → Deploy. Até você fazer isso, o `/health` mostra
   `the agent keeps failing: ... is not this token's agent`. É o esperado. (Em geral aparece
   em um minuto; no pior caso, em quinze.)
6. **Despause** (parte 3).
7. Se o endereço do agente estava em `KEEPER_OWN_WALLETS` no servidor, acrescente lá o
   endereço novo.

---

## 5. Trocar o keeper

**Quando:** a chave do keeper vazou ou pode ter vazado. Com ela, um ladrão leva **o que estiver
na carteira do keeper** e **as taxas que entrarem** até você trocar. Depois da troca, não leva
mais nada. **Aqui cada minuto conta: troque primeiro, entenda depois.**

1. Crie uma chave nova: `C:\Users\John\veluno-mainnet\keeper2.json`. Anote o endereço. Mande
   0,05 SOL para ele.
2. Ensaio (troque `ENDERECO_NOVO`):

   ```
   npm run guardian -- C:\Users\John\veluno-mainnet\token.json keeper ENDERECO_NOVO --key C:\Users\John\veluno-mainnet\guardiao.json
   ```

   Confira `old keeper`, `new keeper` e `The chain would accept it.`
3. De verdade: o mesmo comando com `--send --mainnet` no fim.
4. **Chame quem programa antes de religar o keeper no servidor.** Motivos:
   - As taxas que ainda estavam na pool estão seguras: só o keeper novo consegue retirar.
   - O que o keeper antigo já tinha retirado e ainda não tinha pago ficou na **carteira antiga**.
     Nada move esse dinheiro sozinho. Se a chave antiga foi roubada, conte como perdido. Se
     ela só foi trocada e continua com você, o dinheiro está lá e sai com ela.
   - As contas do keeper antigo (quanto cada holder tem a receber) não passam sozinhas para o
     novo. Elas só existem no disco do servidor. Hoje não existe um comando para isso.
   Enquanto isso, o `/health` mostra `the keeper keeps failing: the rulebook names ... as the
   keeper, not my key`. É o esperado: o keeper antigo parou.

**Não troque o keeper por rotina.** Só em emergência, ou combinado com quem programa.

---

## 6. O servidor foi invadido (ou a conta da Railway, ou a do GitHub)

Nesta ordem:

1. **Trocar o keeper** (parte 5, passos 1 a 3). É o que protege dinheiro.
2. **Pausar o agente** (parte 2).
3. **Trocar o agente** (parte 4, passos 2 a 4).
4. Trocar as senhas e ligar a verificação em duas etapas no GitHub e na Railway.
5. Criar chaves novas na Anthropic e na Helius e apagar as antigas. **A partir daqui o
   comando do guardião não fala mais com a rede pelo `token.json`**, porque o endereço que
   está lá usava a chave apagada. Troque a linha `rpc` do `token.json` pelo endereço novo da
   Helius, ou acrescente `--rpc https://api.mainnet-beta.solana.com` no fim dos comandos
   (veja "Se o comando não conseguir falar com a rede").
6. Criar um serviço novo na Railway com as chaves novas (`docs/hospedagem.md`), junto com quem
   programa, por causa das contas do keeper.
7. **Despausar** (parte 3).

---

## Se o comando recusar

| O que aparece | O que quer dizer |
|---|---|
| `It is not the guardian's key, so nothing was done.` | O arquivo depois de `--key` não é o do guardião. Ele mostra o endereço da chave que você deu e o do guardião de verdade. |
| `... needs the guardian's key: add --key ...` | Faltou `--key` e o caminho do arquivo. |
| `The guardian's wallet ... holds 0 SOL` | Mande 0,01 SOL para o endereço do guardião e repita. |
| `This is mainnet: add --mainnet as well as --send` | Faltou `--mainnet` no fim. |
| `... is not a wallet's address` | O endereço novo está errado. Copie de novo. |
| `The agent is already paused: there is nothing to do.` | Já estava feito. |
| `I could not get an answer from the node at ...` | O comando não conseguiu falar com a rede pelo RPC do `token.json` (chave apagada, cota esgotada, internet fora). Nada foi enviado. Repita com `--rpc https://api.mainnet-beta.solana.com` no fim. |
| `It stopped on an error: ...` | Um erro que o comando não esperava. Se a frase falar de rede (`fetch failed`, `401`, `403`, `429`), é o RPC: repita com `--rpc https://api.mainnet-beta.solana.com` no fim. |
| `The node at ... is on ..., and ... says this token is on ...` | O endereço depois de `--rpc` é de outra rede (devnet no lugar de mainnet, ou o contrário). Nada foi feito. |
| `It did not go through: ...` | Não passou. Rode `status` para ver como ficou: uma transação pode ter entrado mesmo sem a confirmação aparecer. |

O comando nunca mostra nem copia a chave. Ele se recusa a agir com uma chave que não seja a do
guardião **antes** de enviar qualquer coisa.

---

## Se você perder a chave do guardião

Ninguém mais consegue pausar o agente nem trocar chaves. O token continua funcionando, mas sem
freio. Por isso: uma cópia de `guardiao.json` num pendrive guardado, **hoje**.

Se a chave do guardião **vazar**: quem a tiver pode fazer as seis coisas da lista do começo.
Pode pausar, trocar o agente e o keeper por chaves dele (e com o keeper, ficar com as taxas),
nomear uma chave de app e passar o papel de guardião para uma chave dele, tirando você. A
saída é você passar o papel para uma chave nova **antes** dele. Essa instrução existe no
programa, mas o comando acima não a oferece. Chame quem programa imediatamente.

---

## Ensaio na devnet (uma vez, antes do lançamento)

Com o token de ensaio da devnet (`docs/lancamento.md`, parte 0) e a pasta
`C:\Users\John\veluno-devnet`:

1. `status`
2. `pause` sem `--send`; depois com `--send`; `status` mostra `PAUSED`
3. `resume` com `--send`; `status` mostra `running`
4. crie `agente2.json`, troque o agente com `--send`, e troque de volta para o endereço antigo
5. tente uma vez com a chave errada (`--key ...\agente.json`): tem que recusar
6. rode `status` uma vez com `--rpc https://api.devnet.solana.com` no fim, para conhecer a
   opção antes de precisar dela

Na devnet não se usa `--mainnet`.
