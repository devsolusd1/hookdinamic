# EDICT

Um token na Solana cujas regras de compra são inventadas por um agente de IA, sozinho, a partir
de um sorteio que ele não controla e dentro de limites travados no lançamento. Cada mudança de
regra é um édito. Projeto independente: programa, chaves e carteiras próprios.

## Como funciona

1. O token tem um **hook**: um programa que a Solana roda em toda transferência e que pode
   recusar uma compra. Vender na curva e mandar de uma carteira para outra nunca são recusados.
2. A regra em vigor fica no **livro de regras**, uma conta on-chain por token. Uma regra é uma
   lista curta de comparações sobre a compra. Ninguém escreveu as regras antes: o agente compõe
   cada uma.
3. Antes de cada édito, o hash de um bloco recente **sorteia** quatro coisas: o temperamento da
   regra (aberta, leve, apertada ou estranha), em torno de quais fatos ela tem que ser
   construída, quem as fees favorecem e quanto tempo ela dura. O Claude transforma o sorteio
   numa regra e num texto. Qualquer pessoa pode refazer o sorteio a partir do bloco.
4. A regra dura o tempo sorteado e expira sozinha. Aí o agente sorteia de novo.

### O que uma regra pode olhar

Uma regra tem até 16 condições em até 4 grupos. A compra passa se todas as condições de pelo
menos um grupo valerem. Cada condição compara um destes fatos com um número:

| fato | o que é |
|---|---|
| `size` | tamanho da compra, em % do supply |
| `held_before`, `held_after` | quanto a carteira tinha antes e quanto fica depois, em % do supply |
| `minute`, `hour`, `weekday` | o relógio da blockchain, em UTC |
| `elapsed` | segundos desde que a regra foi escrita |
| `via_app` | se a compra veio pelo app (a carteira do app co-assina a transação) |
| `priority_fee` | a taxa de prioridade que a transação pagou |
| `curve_sol` | quanto SOL há na curva |
| `luck` | um número de 0 a 99 que anda um por slot e começa diferente em cada carteira |

Exemplo real, escrito pelo Claude no devnet a partir do sorteio "apertada, dia da semana e
sorte, 60 minutos": *até meia-noite UTC só compra quem estiver com sorte abaixo de 15; depois
da meia-noite, só com sorte 85 ou mais.*

### O que o agente não pode fazer

Os limites ficam no livro de regras desde o lançamento e não existe instrução para mudá-los:
intervalo mínimo entre dois éditos, duração máxima de uma regra e teto da fatia da tesouraria.
O **agente** é a única chave que escreve regras, e só dentro deles. O **guardião** pausa o
agente e troca chaves, mas não escreve regras; com o agente pausado o token fica livre.

## As peças

- `programs/hook`: o programa on-chain (Pinocchio, ~45 KB). É o transfer hook do token e guarda
  o livro de regras. Também guarda a divisão das fees (holders / burn / tesouraria); o hook não
  mexe em dinheiro, quem pagar as fees lê a divisão dali.
- `site/rules.js`: a linguagem das regras num lugar só. O site e o agente usam o mesmo arquivo
  para transformar uma regra em números e para dizê-la em palavras.
- `src/curve.ts`: a curva na Meteora DBC. Uma curva só, com graduação em ~US$ 1 bi de market
  cap, ou seja, na prática nunca gradua (a Meteora remove o hook quando a curva completa).
- `src/agent.ts` e `scripts/agent.ts`: o agente. Sorteia, mostra o mercado e o sorteio ao
  Claude, confere a resposta e grava on-chain. Uma resposta fora dos limites, que não siga o
  sorteio ou que ninguém conseguiria cumprir é devolvida ao modelo uma vez e depois descartada.
  Cada decisão vai para um log, e o hash dela fica no livro de regras.
- `agent/persona.md`: como o token fala. É texto livre, pode trocar.
- `site/`: o site. HTML, CSS e JavaScript puros, sem build.

## Comandos

```bash
npm install
npm run test:programs   # compila o programa e roda os testes em Rust (precisa de WSL)
npm run validator       # validador local com o programa real da Meteora (deixe aberto)
npm run e2e             # lançamento, trades sob vários tipos de regra e saque de fees, contra a Meteora
npm run e2e:agent       # o sorteio e o loop do agente, com um substituto no lugar do modelo
npm run agent           # o agente de verdade (configure o .env a partir do .env.example)
npm run site            # o site em http://localhost:4321
```

## Lançar numa rede de verdade

O lançamento lê um arquivo JSON com a rede, a carteira pagadora e tudo o que fica travado para
sempre (taxa, curva, limites). Copie `launch.example.json`, preencha e rode:

```bash
npm run launch -- .local/devnet/launch.json           # só mostra o que faria
npm run launch -- .local/devnet/launch.json --send    # lança; em mainnet exige também --mainnet
npm run smoke -- .local/devnet 0.05                   # uma compra e uma venda de teste
```

O programa do hook precisa estar publicado antes (`solana program deploy`, cerca de 0,23 SOL de
aluguel). O lançamento em si gasta cerca de 0,02 SOL. Se ele parar no meio, rodar de novo
continua de onde parou. Os endereços saem em `token.json`, na mesma pasta do arquivo de
lançamento.

## Ligar o agente

1. Crie uma chave em console.anthropic.com, em "API keys". A conta precisa ter crédito.
2. Cole a chave no `.env`, na linha `ANTHROPIC_API_KEY=`. O `.env` fica fora do git.
3. `npm run agent -- --once` faz o agente olhar uma vez, na hora, trocando a regra que estiver
   em vigor. Com `DRY_RUN=1` ele decide e mostra, sem enviar nem registrar nada; com
   `DRY_RUN=0` a regra vai para a blockchain.
4. `npm run agent` deixa ele rodando: escreve uma regra, espera ela acabar e escreve a próxima.
   Para ver o resultado, `npm run site:devnet` abre o site lendo o token do devnet em
   http://localhost:4323.

Medido no devnet com o Claude Opus 5.5: cada édito gasta de 2.700 a 3.700 tokens de entrada (o
número cresce com o histórico, que para em 12 éditos) e uns 700 de saída, de 2,5 a 3,5 centavos
de dólar. Com regras de 12 minutos a 2 horas, isso dá cerca de 1 dólar por dia.

## O site

Enquanto `site/config.js` não tiver o endereço do livro de regras, a página mostra uma
**edição de espécime**: exemplos marcados como tal, para ver como o registro vai ficar.
Preenchido o endereço, ela passa a ler o livro de regras da blockchain a cada 20 segundos e o
log do agente em `site/data/log.jsonl`. O texto de um édito só aparece se o hash dele bater
com o que está on-chain.

Para ver o modo ao vivo sem lançar nada:

```bash
npm run validator    # em um terminal
npm run site:seed    # cria um token local e faz o agente emitir cinco éditos
npm run site:local   # o site lendo esse token, em http://localhost:4322
```

No lançamento:

1. Preencha `rulebook`, `program`, `pool`, `feeBps` e `trade` em `site/config.js`.
2. Troque `rpc` por um endpoint que aceite chamadas de navegador. O público da Solana recusa
   navegadores quando está cheio.
3. Faça o agente publicar o log dele em `site/data/log.jsonl` (é o arquivo de `AGENT_LOG`).
4. O nome aparece só em `site/index.html`.

## O que já foi provado e o que falta

Provado no devnet, com o Claude de verdade: o agente sorteia, inventa a regra, grava on-chain,
e o hook recusa e aceita compras exatamente como a regra diz. Foram cinco éditos seguidos; em três
deles houve compras dos dois lados da regra (uma aceita, uma recusada), nos outros dois só a
compra permitida, por falta de SOL de teste para a compra grande.

Ainda não existe:

- Deploy na mainnet.
- Um servidor para o agente ficar ligado 24 horas.
- O pagamento das fees conforme a divisão (holders, buyback e burn). O site já descreve esse
  pagamento, então ele não deve ir ao ar antes disso.
- Uma compra real pela FOMO para provar a carteira co-assinante.
- Imagem de preview para redes sociais (og:image).

O programa não foi auditado e é atualizável por quem tiver a chave de upgrade.
