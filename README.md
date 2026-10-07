# Veluno

Um token na Solana (ticker VELUNO) cujas regras de compra são trocadas por um agente de IA,
sozinho, dentro de limites travados no lançamento. O agente é um personagem, também chamado
Veluno. Cada troca de regra é um **édito**. O site é https://veluno.li.

Projeto independente: programa, chaves e carteiras próprios. O programa não foi auditado.

## Como funciona

1. O token tem um **hook**: um programa que a Solana roda em toda transferência e que pode
   recusar uma **compra** na curva. Vender e mandar de uma carteira para outra nunca são
   recusados.
2. O que vale agora fica no **livro de regras**, uma conta on-chain por token: a regra de
   compra em vigor, até quando ela vale, como as taxas se dividem (holders / queima /
   tesouraria), e quem é o guardião, o agente e o keeper.
3. O **agente** não inventa regras. Ele escolhe num **catálogo** fixo (`site/hooks.js`) um hook
   de compra, um hook de taxas e por quanto tempo valem, e grava isso no livro de regras. O
   texto de cada édito vai para um diário público; o hash do texto fica on-chain.
4. O token é negociado numa curva da Meteora (Dynamic Bonding Curve) que, na prática, nunca
   gradua. A taxa é de 3% por trade: a Meteora fica com um quinto, e o resto é dividido como o
   édito em vigor mandar. A tesouraria recebe sempre entre 40% e 50% desse resto.
5. O **keeper** tira as taxas da pool e paga: a parte da tesouraria vai para a tesouraria (uma
   carteira do projeto, cujo endereço o keeper recebe; ela não está no livro de regras), a
   parte da queima recompra o token e queima, e a parte dos holders é paga a eles em SOL. As
   taxas só saem da pool pelo programa, e só para o keeper que o livro de regras nomeia.
6. O programa garante que as taxas cheguem ao keeper, mas não o obriga a pagar. O que o keeper
   já retirou e ainda não pagou fica na carteira dele, e quanto cada carteira tem a receber
   está só nas contas dele, que não são públicas: o livro público traz os totais e um hash
   delas. A parte de cada carteira é pelo que ela segura na hora em que o keeper conta.

### Quem pode o quê

| Chave | Pode | Não pode |
|---|---|---|
| **Agente** (no servidor) | emitir éditos dentro dos limites: a regra de compra e como as taxas se dividem | mover o dinheiro das taxas, mexer nos tokens de alguém, mudar os limites |
| **Keeper** (no servidor) | retirar as taxas da pool e pagá-las | mexer nas regras |
| **Guardião** (só com o dono) | seis coisas: pausar o agente, despausar, trocar o agente, trocar o keeper, nomear uma chave de app mais tarde, passar o papel de guardião para outra chave | escrever regras, mudar limites, tirar SOL ou tokens de alguém. Ele não move dinheiro, mas escolhe o keeper, que é quem recebe as taxas |
| Quem atualiza o programa | trocar o programa inteiro | (por isso essa chave vale tanto quanto a do guardião) |

Os limites (intervalo entre éditos, duração máxima, piso e teto da tesouraria), a taxa, a
curva e o nome ficam travados no lançamento. Não existe instrução para mudá-los.

A chave de app **não** é travada. O token nasce sem ela, e por isso nenhum hook sobre "o app"
vale para ele. O guardião pode nomear uma mais tarde (e trocá-la ou tirá-la): a partir daí o
agente pode usar esses hooks, e o site os mostra. O comando `npm run guardian` faz as quatro
primeiras coisas da lista; nomear a chave de app e passar o papel de guardião existem no
programa, mas o comando ainda não as oferece.

## As peças

- `programs/hook`: o programa on-chain (Rust, Pinocchio). É o transfer hook, guarda o livro de
  regras e faz a retirada das taxas para o keeper.
- `site/hooks.js` e `site/rules.js`: o catálogo de hooks e a linguagem das regras. O site e o
  agente leem os mesmos arquivos.
- `src/curve.ts`, `src/launch.ts`, `scripts/launch.ts`: a curva e o lançamento.
- `src/hook.ts`, `src/fees.ts`: o cliente do programa.
- `src/agent.ts`, `scripts/agent.ts`, `agent/persona.md`: o agente e como ele fala.
- `src/keeper/`, `scripts/keeper.ts`: o keeper.
- `scripts/serve.ts`: **o serviço**. Um processo só, que roda o agente e o keeper e publica
  por HTTP o diário do agente, o livro do keeper e um `/health`. É o que vai para o servidor
  (`Dockerfile`, `railway.json`).
- `scripts/guardian.ts`: o comando de emergência do dono.
- `site/`: o site. HTML, CSS e JavaScript puros, sem build, na Vercel. O `vercel.json` faz o
  site ler os registros do serviço em `https://agent.veluno.li`.
- `site/metadata.json` e `site/veluno.png`: o cartão do token, que carteiras e exploradores
  leem em `https://www.veluno.li/metadata.json`. Esse endereço fica gravado no token para
  sempre; o arquivo continua nosso e pode ser editado. `site/card.png` é a imagem que aparece
  quando alguém compartilha o link do site.

## Para o dono

Três documentos, em ordem. Os três são percorridos primeiro na devnet, como ensaio, e só
depois na mainnet:

1. [`docs/lancamento.md`](docs/lancamento.md): tudo antes e durante o lançamento. Começa pelo
   ensaio na devnet.
2. [`docs/hospedagem.md`](docs/hospedagem.md): ligar o serviço num servidor e ver se está saudável.
3. [`docs/emergencia.md`](docs/emergencia.md): o comando do guardião, quando e como.

## Comandos

```bash
npm install

# testes
npm run test:programs   # compila o programa e roda os testes em Rust (precisa de WSL)
npm run test:keeper     # o keeper num ensaio offline
npm run test:serve      # o serviço e o diário do agente, offline
npm run typecheck
npm run validator       # validador local com o programa real da Meteora (deixe aberto, precisa de WSL)
npm run e2e             # lançamento, trades e retirada de taxas, contra a Meteora
npm run e2e:agent       # o agente, com um substituto no lugar do modelo
npm run e2e:keeper      # o keeper, de ponta a ponta
npm run test:serve -- --validator   # o serviço inteiro como processo, mais o comando do guardião

# rodar
npm run serve           # o serviço: agente + keeper + registros por HTTP (variáveis em .env.example)
npm run agent           # só o agente
npm run keeper          # só o keeper
npm run launch -- <arquivo.json>              # ensaio do lançamento; com --send, lança
npm run guardian -- <token.json> status       # como está o livro de regras
npm run guardian -- <token.json> status --rpc <endereço>   # o mesmo, por outro RPC, se o do token.json não responder
npm run site            # o site em http://localhost:4321
```

## O site

Enquanto `site/config.js` não tiver o endereço do livro de regras, a página mostra um
**ensaio**, marcado como tal. Preenchido o endereço, ela lê o livro de regras direto da
blockchain, o diário do agente em `data/log.jsonl` e o livro do keeper em
`data/ledger-head.json`, e aponta para o livro inteiro em `data/ledger.jsonl`. Esses três
caminhos são repassados pela Vercel ao serviço. O texto de um édito só aparece se o hash dele
bater com o que está on-chain, e a página ignora as linhas do diário que forem de outro token.
O endereço da tesouraria vem de `site/config.js` (`treasury`) e tem que ser o mesmo que o
keeper recebe em `TREASURY`.

## O que já foi provado e o que falta

Provado numa rede local, contra o programa real da Meteora: o lançamento, o hook aceitando e
recusando compras, a retirada das taxas pelo programa, o keeper pagando tesouraria, recompra
e holders com as contas batendo, o agente emitindo éditos sem perder o texto de nenhum mesmo
com o processo morto no meio, o serviço parando limpo, e o guardião pausando e trocando chaves.

Ainda não foi feito:

- Rodar esta versão na devnet ou na mainnet. O programa que está na devnet é o antigo.
- Rodar o serviço num servidor de verdade (os passos da Railway e da Vercel vêm da
  documentação), e construir a imagem do `Dockerfile` pelo menos uma vez.
- Pôr no ar o `metadata.json` do token (nome, ticker, imagem). Ele já existe em `site/`, mas
  só responde em `https://www.veluno.li/metadata.json` depois de enviado ao GitHub, e tem que
  responder antes do lançamento: o endereço dele fica gravado no token para sempre.
- Auditoria do programa. Ele é atualizável por quem tiver a chave de atualização.
