# ai-usage

Painel local de consumo de tokens/custo de agentes de código (Claude Code, OpenCode, Codex etc.) lendo os logs locais via [ccusage](https://ccusage.com). Atualiza sozinho, tem filtro cruzado por modelo e por tag de projeto (estilo Power BI), converte o custo para reais e exporta CSV. Opcionalmente, sincroniza tudo para data lake/banco de forma incremental e desacoplada.

## O problema que ele resolve

Quem usa agentes de código no dia a dia não tem resposta fácil para perguntas básicas: **quanto estou gastando? Em qual modelo? Em qual projeto?** As dificuldades reais:

- **Os dados existem, mas são invisíveis.** Cada agente grava logs locais de uso, mas ninguém abre JSONL na mão para somar tokens. O `ccusage` resolve a leitura — este painel resolve a visualização e a análise.
- **Os logs são efêmeros.** O Claude Code (e outros) tem janela de retenção: dias antigos somem dos logs e o histórico de custo se perde. O painel mantém um **histórico local persistente** que sobrevive à retenção — o que entrou, nunca mais some.
- **Times não têm visão consolidada.** Cada dev consome na própria máquina; o gestor não enxerga o total. O modo headless + sync sobe o consumo de cada máquina (com identificação de usuário/máquina) para um data lake ou banco, de forma incremental, pronto para um dashboard corporativo.
- **Ambiente corporativo é hostil.** Notebook com proxy que quebra o npm, executáveis bloqueados, sem admin. Por isso o servidor tem **zero dependências** (só Node nativo), degrada graciosamente sem rede e roda de qualquer pasta — inclusive OneDrive com espaços e acentos no caminho.
- **Modelos atrás de proxy/gateway não têm preço.** Nomes com prefixo corporativo (ex.: `acme-claude-sonnet-5`) ficam com custo zerado nas ferramentas padrão. Aqui viram **tags de projeto** filtráveis e o preço é resolvido automaticamente pela tabela pública do LiteLLM.

Em resumo: **observabilidade de custo de IA plug-and-play** — 2 cliques para rodar na máquina de qualquer dev, e escala para telemetria de time quando necessário.

## Como rodar

Requisito: **Node.js 18+** (https://nodejs.org). Nenhum `npm install` é necessário para o modo web — o servidor usa só módulos nativos e o `ccusage` é baixado pelo `npx` na primeira execução.

| Ação | Windows | Linux/macOS |
|---|---|---|
| Iniciar **em segundo plano** (sem janela de console) | 2 cliques em `start.vbs` | `./start.sh` |
| Encerrar | 2 cliques em `stop.bat` | `./stop.sh` |
| Iniciar com console visível (debug) | `start-debug.bat` | `node server.js` |
| Iniciar em modo **headless** (sem painel, só coleta+sync) | `start-headless.vbs` | `node server.js --headless` |

O navegador abre sozinho em http://localhost:8384. Se rodar o start de novo com o painel já aberto, ele só reabre a página (não duplica o servidor).

## O que tem no painel

- **Filtro de período** — padrão: início ao fim do mês atual
- **Cards**: entrada, saída, cache write, cache read, total de tokens e custo do período em R$ (cotação USD→BRL da AwesomeAPI, gratuita, sem chave; sem internet, mostra em US$)
- **Gráfico** de colunas empilhadas por dia, dividido por modelo, alternando entre Tokens e Custo (US$)
- **Filtro cruzado (estilo Power BI)**: clique num modelo — no segmento da barra, no chip ou na linha da tabela — e **tudo** se adapta: cards, gráfico e tabela passam a refletir só aquele modelo. `Ctrl+clique` soma modelos à seleção, clicar de novo (ou `Esc`, ou "Limpar filtro") volta ao total
- **Tabela granulada por dia × modelo**, com total no rodapé e exportação em CSV (`;` + vírgula decimal, pronto pro Excel BR); o CSV respeita o filtro ativo
- **Atualização automática** com contador, pausa e botão de atualizar agora

### Tags de projeto (automático)

Prefixos nos nomes dos modelos (ex.: `acme-claude-sonnet-4-6`) são detectados sozinhos e viram **tags** — no painel aparece a linha "Tag / projeto" com chips para filtrar tudo (cards, gráfico e tabela) por tag. A tabela e o CSV ganham a coluna Tag.

### Preço automático para modelos com prefixo

Quando um modelo dos logs não tem preço conhecido (o caso dos modelos com prefixo, ex.: `acme-*`), o painel resolve sozinho: extrai o modelo base (removendo prefixo e sufixos de instância como `-2`), busca o preço na tabela pública do LiteLLM (mesma fonte do ccusage, com cache local de 7 dias) e **grava o override automaticamente** no `ccusage.json` — sem sobrescrever nada que você tenha definido manualmente. Para desligar: `"autoPricing": false` no `config.json`. Modelos que o LiteLLM não conhece (ex.: apelidos totalmente customizados) continuam precisando de override manual.

## Configuração

### `config.json` — comportamento do painel

```json
{
  "port": 8384,          // porta do servidor local
  "refreshSeconds": 60,  // intervalo da atualização automática
  "agent": "all",        // "all", "claude", "opencode", "codex", ...
  "offline": false,      // true = tabela de preços embutida do ccusage, sem rede
  "autoPricing": true    // resolve preço de modelos com prefixo automaticamente
}
```

Use `"agent": "claude"` para ver **apenas** o Claude Code (sem misturar OpenCode etc.).

### `ccusage.json` — mapeamento de preços (pricing overrides)

Modelos desconhecidos pelo ccusage (ex.: prefixo de proxy `acme-...`) ficam com custo zerado. Cada chave aqui é o **nome exato** do modelo nos logs, com o preço por token (preço por milhão ÷ 1.000.000):

```json
{
  "defaults": {
    "pricingOverrides": {
      "nome-exato-do-modelo": {
        "inputCostPerToken": 0.000003,
        "outputCostPerToken": 0.000015,
        "cacheCreationInputTokenCost": 0.00000375,
        "cacheReadInputTokenCost": 0.0000003
      }
    }
  }
}
```

Listar os nomes exatos (PowerShell):

```powershell
npx ccusage@latest daily --json --breakdown | ConvertFrom-Json |
  Select-Object -ExpandProperty daily |
  Select-Object -ExpandProperty modelBreakdowns |
  Select-Object -ExpandProperty modelName | Sort-Object -Unique
```

O arquivo já vem com um exemplo genérico (`acme-*`) — troque pelas chaves reais dos seus logs. Com o `autoPricing` ativado (padrão), a maioria dos modelos com prefixo é mapeada sozinha e você raramente precisa editar isto na mão.

## App desktop (Electron) — um único .exe

O projeto já vem preparado. Para gerar o instalador (precisa de internet na primeira vez):

```powershell
npm install
npm run dist
```

Sai em `dist/`:
- `ccusage Dashboard Setup 1.0.0.exe` — **instalador de um clique** (um único arquivo: instala, cria atalho e abre)
- `ccusage Dashboard 1.0.0.exe` — versão **portátil** (um único arquivo, roda direto, sem instalar)

No app desktop o `ccusage` vai **embutido** (dependência do pacote), então a máquina de destino **não precisa nem de Node**. As configurações editáveis ficam em `%APPDATA%\ccusage Dashboard\` (`config.json` e `ccusage.json`), criadas na primeira execução a partir dos padrões.

Para testar o app sem empacotar: `npm run app`.

### Sobre consumo de RAM

Electron embute um Chromium: espere ~150–250 MB de RAM. Se isso incomodar, a alternativa é o **Tauri** (~30–60 MB, usa o WebView2 nativo do Windows), mas exige toolchain Rust para compilar. O código foi estruturado (frontend puro + servidor separado) justamente para uma migração futura ser simples.

## Sincronização com data lake / banco (opcional e desacoplada)

Desligada por padrão. Quando ativada, mantém um **histórico local persistente** (`usage-history.json`) com merge por `data+agente+modelo`: dias que saírem da janela de retenção dos logs do ccusage **permanecem no histórico** — os dados exportados ficam consistentes no tempo. Se um valor voltar menor (purge parcial de log), o maior é preservado.

O envio é **incremental**: hash por mês, e só os meses alterados são reenviados (meses fechados sobem uma vez e nunca mais). Camadas por destino (`layers`):

- **`table`** — o histórico consolidado, um `.jsonl` por mês em `table/ccusage_table_{maquina}_{AAAA-MM}.jsonl` (uma linha por dia × modelo, com `tag`, `base_model` e custo); só os meses que mudaram são reenviados
- **`delta`** — `.jsonl` **append-only** com apenas as linhas novas/alteradas de cada sync, em `delta/ccusage_delta_{maquina}_{timestamp}.jsonl`; ideal para ingestão orientada a eventos (padrão do webhook)
- **`raw`** — o JSON bruto do ccusage da rodada, intocado, em `raw/` (princípio da raw)

Se algum destino falhar, os hashes não são consolidados e o próximo sync **retenta** automaticamente.

**Configure pela interface**: clique no pill **sync** no topo do painel — o formulário permite habilitar, definir o intervalo, a identidade (usuário/máquina) e os destinos (file, azureBlob, webhook) com suas camadas, e salva tudo em `config.local.json` aplicando na hora, sem reiniciar. Também dá para editar o arquivo na mão — **`config.local.json`** (mesmo formato do config.json, sobrepõe ele e está no `.gitignore`: é onde ficam segredos como SAS token):

```json
{
  "sync": {
    "enabled": true,
    "intervalMinutes": 30,
    "targets": [
      { "type": "file", "dir": "C:/lake/ccusage" },
      { "type": "azureBlob", "sasUrl": "https://conta.blob.core.windows.net/container?sv=...", "prefix": "bronze/ccusage/" },
      { "type": "webhook", "url": "https://minha-api/ingest", "headers": { "x-api-key": "..." }, "layers": ["delta"] }
    ]
  }
}
```

- `file` — grava numa pasta (local, share, caminho montado do lake); padrão de camadas: raw+table+delta
- `azureBlob` — PUT direto no container via SAS URL, sem SDK (a SAS precisa de permissão de criação e escrita: `sp` com `c` e `w`)
- `webhook` — POST JSON pra qualquer endpoint (Function App, API de ingestão de banco, etc.); padrão: só `delta`

### Identidade nas linhas (opcional)

Cada linha exportada leva `machine` e `user` para diferenciar quem consumiu o quê (útil quando várias pessoas do time sobem para o mesmo lake). Em notebook corporativo, `user` reflete o login de rede. Controle no bloco `sync`:

```json
"sync": {
  "user": "auto",     // "auto" (padrão) = login da máquina · "off" = não enviar · "texto" = valor fixo
  "machine": "auto"   // idem para o hostname
}
```

### Modo headless (coleta silenciosa para o lake)

Com `"headless": true` no config (ou `node server.js --headless`), o processo roda **sem painel e sem abrir porta HTTP** — só coleta do ccusage e sincroniza nos destinos no intervalo configurado. Requer `sync.enabled = true`. No Windows, use `start-headless.vbs` (invisível) e `stop.bat` para encerrar (ele mata pelo PID gravado em `server.pid`).

Para rodar automaticamente no login do Windows: `Win+R` → `shell:startup` → cole um atalho para o `start-headless.vbs`. Pronto: telemetria de uso do time subindo pro lake sem ninguém precisar lembrar de abrir nada.

Observação: a camada `raw` gera um arquivo por sync com mudanças (snapshots imutáveis, estilo bronze append-only). Se quiser economizar armazenamento, restrinja o destino com `"layers": ["table", "delta"]`.

No painel, aparece o pill **sync: ok HH:MM** no topo (clique para sincronizar na hora). Endpoints: `GET /api/sync/status` e `POST /api/sync/run`.

Modelo de tabela sugerido para consumir `table`/`delta` (Delta/SQL):

```sql
CREATE TABLE ccusage_daily_model (
  date DATE, machine STRING, user STRING, agent STRING,
  model STRING, tag STRING, base_model STRING,
  input_tokens BIGINT, output_tokens BIGINT,
  cache_creation_tokens BIGINT, cache_read_tokens BIGINT,
  total_tokens BIGINT, cost_usd DECIMAL(12,6), exported_at TIMESTAMP
);
```

### Publicando no GitHub

O repo já vem com `.gitignore` cobrindo `node_modules/`, `dist/`, `config.local.json` (segredos), `sync-state.json` e caches. Antes de publicar, confira que seu `ccusage.json` e `config.json` versionados não contêm nada sensível — eles são só preços e preferências, mas vale o olho.

## Solução de problemas

- **"Falha ao consultar o ccusage"**: teste `npx ccusage@latest daily` no terminal; a primeira execução baixa o pacote.
- **Cotação indisponível**: o painel segue em US$ e a cotação volta na próxima atualização com internet.
- **Porta em uso**: mude `port` no `config.json` (e no `start.vbs`, que abre a URL).
