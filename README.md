# EDICT

Um token na Solana cujas regras são reescritas por um agente de IA, sozinho, dentro de limites
travados no lançamento. Cada mudança de regra é um édito. Projeto independente: programa,
chaves e carteiras próprios.

## As peças

- `programs/hook`: o programa on-chain (Pinocchio, ~31 KB). É o transfer hook do token e guarda
  o **livro de regras**, uma conta por token.
  - Regras que o hook aplica: janela "só pelo app" (a compra precisa da assinatura da carteira
    do app), compra máxima e carteira máxima em % do supply.
  - Vender na curva nunca é recusado.
  - O livro também guarda a divisão das fees (holders / burn / tesouraria). O hook não mexe em
    dinheiro; quem pagar as fees lê a divisão dali.
  - **Agente**: a única chave que escreve regras, e só dentro dos limites.
    **Guardião**: pausa o agente e troca chaves, não escreve regras.
- `src/curve.ts`: a curva na Meteora DBC. Uma curva só, com graduação em ~US$ 1 bi de market
  cap, ou seja, na prática nunca gradua (a Meteora remove o hook quando a curva completa).
- `src/agent.ts` e `scripts/agent.ts`: o agente. Fica rodando, lê o mercado, pergunta ao Claude
  qual a próxima regra, confere contra os limites e grava on-chain. Cada decisão vai para um
  log, e o hash dela fica no livro de regras.
- `agent/persona.md`: como o token fala. É texto livre, pode trocar.
- `site/`: o site. HTML, CSS e JavaScript puros, sem build.

## Comandos

```bash
npm install
npm run test:programs   # compila o programa e roda os testes em Rust (precisa de WSL)
npm run validator       # validador local com o programa real da Meteora (deixe aberto)
npm run e2e             # lançamento, trades sob cada regra e saque de fees, contra a Meteora
npm run e2e:agent       # o loop do agente, com um substituto no lugar do modelo
npm run agent           # o agente de verdade (configure o .env a partir do .env.example)
npm run site            # o site em http://localhost:4321
```

## O site

Enquanto `site/config.js` não tiver o endereço do livro de regras, a página mostra uma
**edição de espécime**: exemplos marcados como tal, para ver como o registro vai ficar.
Preenchido o endereço, ela passa a ler o livro de regras da blockchain a cada 20 segundos e o
log do agente em `site/data/log.jsonl`. O texto de um édito só aparece se o hash dele bater
com o que está on-chain.

Para ver o modo ao vivo sem lançar nada:

```bash
npm run validator    # em um terminal
npm run site:seed    # cria um token local e faz o agente emitir quatro éditos
npm run site:local   # o site lendo esse token, em http://localhost:4322
```

No lançamento:

1. Preencha `rulebook`, `program`, `pool`, `feeBps` e `trade` em `site/config.js`.
2. Troque `rpc` por um endpoint que aceite chamadas de navegador. O público da Solana recusa
   navegadores quando está cheio.
3. Faça o agente publicar o log dele em `site/data/log.jsonl` (é o arquivo de `AGENT_LOG`).
4. O nome aparece só em `site/index.html`.

## O que ainda não existe

- Deploy em devnet ou mainnet, e o script de lançamento para rede real.
- O pagamento das fees conforme a divisão (holders, buyback e burn). O site já descreve esse
  pagamento, então ele não deve ir ao ar antes disso.
- Uma compra real pela FOMO para provar a carteira co-assinante.
- Imagem de preview para redes sociais (og:image).

O programa não foi auditado e é atualizável por quem tiver a chave de upgrade.
