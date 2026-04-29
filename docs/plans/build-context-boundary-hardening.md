# Plano: Config Simplification + Build Context Boundary Hardening

**Status:** Pronto para implementação  
**Data:** 2026-04-29  
**ADR de referência:** [ADR-0004](../adr/0004-ecosystem-runner-config-and-build-context-hardening.md)

---

## Escopo

Este plano cobre dois conjuntos de mudanças que compartilham os mesmos arquivos de config e schema, implementados como uma sequência unificada:

1. **Config simplification**: remoção dos campos deprecated do composer (`image_strategy`, `framework_profile`) e adição do campo `allow_build_context_escape` nos três runners.
2. **Build context boundary hardening**: substituição do bloco warn-only em `build-project-image.ts` por uma verificação com enforcement via git root.

**Não há retrocompatibilidade** — configs com `image_strategy` ou `framework_profile` sob `scanners.composer` falham no schema load com mensagem de migração. O schema usa `.strict()` e campos desconhecidos são rejeitados com erro descritivo.

---

## Steps de Implementação

### Step 1 — Remover campos deprecated do composer (independente)

**Arquivos afetados (mudança atômica nos 4):**

1. `src/core/types/config.ts`
   - Remove `ComposerImageStrategy` type
   - Remove `image_strategy?: ComposerImageStrategy` de `ComposerRunnerConfig`
   - Remove `framework_profile?: 'none' | 'laravel' | 'symfony' | 'wordpress'` de `ComposerRunnerConfig`

2. `src/infrastructure/config/schema.ts`
   - Remove `image_strategy: z.enum(['pull', 'build']).optional()` de `ComposerRunnerConfigSchema`
   - Remove `framework_profile: z.enum([...]).optional()` de `ComposerRunnerConfigSchema`

3. `src/app/commands/init.ts`
   - Remove o prompt interativo de `framework_profile` do fluxo do comando `init`

4. `src/infrastructure/config/generator.ts`
   - Remove `composerFrameworkProfile` de `GenerateConfigOptions`
   - Remove qualquer referência ao campo no corpo da função geradora

**Também nesta mesma etapa:**

5. `src/infrastructure/config/templates/project-config.hbs.ts`
   - Remove blocos `{{#if composerFrameworkProfile}}` e qualquer outro bloco Handlebars referente a `framework_profile` ou `image_strategy`

6. `src/infrastructure/provisioner/php-profiles.ts`
   - Remove referências de comentário a `image_strategy` (campo comentado/documentado no arquivo)

**Critério de aceite:**
- `npx tsc --noEmit` passa sem erros
- Schema Zod rejeita `image_strategy` e `framework_profile` com mensagem legível (verificado via teste no Step 7)

---

### Step 2 — Adicionar `allow_build_context_escape` nos três runners (independente do Step 1)

**Arquivos afetados:**

1. `src/core/types/config.ts`
   - Adiciona `allow_build_context_escape?: boolean` em `NpmRunnerConfig`, `PipRunnerConfig`, `ComposerRunnerConfig`
   - JSDoc: campo somente relevante quando `image_source: 'dockerfile'` e `build_context` resolve fora do git root

2. `src/infrastructure/config/schema.ts`
   - Adiciona `allow_build_context_escape: z.boolean().optional()` nos três schemas de runner (`NpmRunnerConfigSchema`, `PipRunnerConfigSchema`, `ComposerRunnerConfigSchema`)

**Critério de aceite:**
- Campo aceito pelo schema em todos os 3 runners
- Campo ausente (undefined) também aceito
- Valor não-booleano rejeitado pelo Zod

---

### Step 3 — Novo módulo de boundary (independente dos Steps 1 e 2)

**Arquivo:** `src/infrastructure/ecosystem-runtime/resolve-build-context-boundary.ts` *(novo)*

Exporta:

**`resolveAllowedBuildContextRoot(projectDir: string): Promise<{ root: string; source: 'git' | 'project-dir' }>`**
- Chama `git -C <projectDir> rev-parse --show-toplevel` via `execFile` (nunca `exec` — sem interpolação de string no shell)
- Sucesso → `{ root: <git root>, source: 'git' }`
- Qualquer falha (ENOENT, exit não-zero, bare repo, worktree, timeout) → `{ root: projectDir, source: 'project-dir' }`
- Cache em `Map<string, Promise<{ root: string; source: 'git' | 'project-dir' }>>` no escopo do módulo — evita subprocess duplo dentro de um mesmo invocation da CLI

**`assertBuildContextWithinBoundary(opts: { contextDir: string; allowedRoot: string; boundarySource: 'git' | 'project-dir'; logPrefix: string; allowEscape?: boolean }): Promise<void>`**
- Aplica `fs.realpath` em `contextDir` e `allowedRoot` antes de comparar (defesa contra symlink escape)
- Verifica containment via `path.relative(allowedRoot, contextDir)` — está dentro quando o path relativo não começa com `..`
- `contextDir` dentro de `allowedRoot` → silencioso, retorna
- Fora + `allowEscape !== true` → throw com mensagem que inclui: `contextDir` resolvido, `allowedRoot` resolvido, fonte do boundary (`'git root'` ou `'project directory'`), e hint: `"Set allow_build_context_escape: true under scanners.<ecosystem> to allow this explicitly"`
- Fora + `allowEscape === true` → `logger.warn` com texto: `build_context "<contextDir>" is outside the project boundary ("<allowedRoot>"). The full directory tree will be sent to the Docker daemon — this may expose sensitive files. Set allow_build_context_escape: false to enforce the boundary.`

**Critério de aceite:**
- Testes do Step 5 passam
- Sem efeitos colaterais em paths que estão dentro do boundary

---

### Step 4 — Substituir warn-only em `build-project-image.ts` (depende do Step 3)

**Arquivo:** `src/infrastructure/ecosystem-runtime/build-project-image.ts`

- Adiciona `allowBuildContextEscape?: boolean` em `BuildProjectImageOptions`
- Remove o bloco warn-only das linhas 123–138 (verificação via `startsWith`)
- No lugar, chama `resolveAllowedBuildContextRoot(projectDir)` seguido de `assertBuildContextWithinBoundary({ contextDir, allowedRoot: result.root, boundarySource: result.source, logPrefix, allowEscape: allowBuildContextEscape })`
- O boundary é verificado **antes** da leitura do Dockerfile (antes do Step 1 na sequência interna da função)

**Critério de aceite:**
- Testes do Step 6 passam
- Nenhuma regressão nos testes existentes de `build-project-image`

---

### Step 5 — Wiring em `resolve.ts` (depende dos Steps 2 + 4)

**Arquivo:** `src/infrastructure/ecosystem-runtime/resolve.ts`

- No branch `imageSource === 'dockerfile'`, lê `scannerCfg?.allow_build_context_escape` do config
- Passa como `allowBuildContextEscape` para `buildProjectImage`
- O tipo do cast inline em `scannerCfg` já inclui `allow_build_context_escape` após o Step 2

**Critério de aceite:**
- `resolveEcosystemRuntime` propaga corretamente o campo para `buildProjectImage`
- Compilação passa sem erros de tipo

---

## Testes

### Step 6 — `resolve-build-context-boundary.test.ts` *(novo, depende do Step 3)*

Arquivo: `tests/unit/infrastructure/ecosystem-runtime/resolve-build-context-boundary.test.ts`

| Caso | Expectativa |
|------|-------------|
| `projectDir` dentro de repo git | Retorna git root com `source: 'git'` |
| `projectDir` sem git | Retorna `projectDir` com `source: 'project-dir'` |
| `git` binary indisponível (mock ENOENT) | Retorna `projectDir` com `source: 'project-dir'` |
| Segunda chamada com mesmo `projectDir` | Não re-invoca `execFile` (cache hit) |
| `contextDir === allowedRoot` | `assertBuildContextWithinBoundary` → ok, não lança |
| `contextDir` filho imediato de `allowedRoot` | → ok |
| `contextDir` subárvore profunda de `allowedRoot` | → ok |
| `contextDir` fora de `allowedRoot`, `allowEscape: false` | → throw com paths resolvidos na mensagem |
| `contextDir` fora de `allowedRoot`, `allowEscape: undefined` | → throw (undefined = false) |
| `contextDir` fora de `allowedRoot`, `allowEscape: true` | → `logger.warn`, sem throw |
| Symlink dentro do projeto apontando para fora | → throw (realpath resolve antes de comparar) |

---

### Step 7 — `build-project-image-branches.test.ts` (depende dos Steps 3 + 4)

Arquivo: `tests/unit/infrastructure/ecosystem-runtime/build-project-image-branches.test.ts` (ou atualização do arquivo existente)

| Caso | Expectativa |
|------|-------------|
| `build_context` dentro do `projectDir` | Builds normalmente, sem warn |
| `build_context` entre `projectDir` e git root (monorepo válido) | Builds normalmente |
| `build_context` exatamente igual ao git root | Builds normalmente |
| `build_context` acima do git root | `throw` com mensagem descritiva |
| `build_context` acima do git root + `allowBuildContextEscape: true` | `logger.warn` + prossegue |
| Non-git: `build_context` dentro do `projectDir` | Builds normalmente |
| Non-git: `build_context` acima do `projectDir` | `throw` por padrão |
| Non-git: `build_context` acima do `projectDir` + `allowBuildContextEscape: true` | `logger.warn` + prossegue |

---

### Step 8 — Testes de schema (depende dos Steps 1 + 2)

Arquivo: `tests/unit/infrastructure/config/schema.test.ts` (ou arquivo existente de testes de schema)

**Campos removidos (composer):**
- `image_strategy: 'build'` → rejeitado pelo Zod (campo desconhecido no `.strict()`)
- `framework_profile: 'laravel'` → rejeitado pelo Zod
- Mensagem de erro deve ser legível e orientada à migração

**Campo novo (todos os runners):**
- `allow_build_context_escape: true` → aceito nos 3 runners
- `allow_build_context_escape: false` → aceito
- `allow_build_context_escape: undefined` (ausente) → aceito
- `allow_build_context_escape: 'yes'` (string) → rejeitado pelo Zod

---

## Diagrama de dependências

```
Step 1 (remove deprecated) ──────────────────────────────────► Step 8 (schema tests)
                                                                      ▲
Step 2 (allow_build_context_escape no schema) ────────────────────────┘
     │
     └──────────────────────────────────────────────────► Step 5 (wiring resolve.ts)
                                                                      ▲
Step 3 (novo módulo boundary) ──► Step 4 (substituir warn-only) ──────┘
     │                                │
     └──► Step 6 (testes boundary)    └──► Step 7 (testes build-project-image)
```

**Steps que podem rodar em paralelo:**
- Steps 1, 2 e 3 são independentes entre si — podem ser implementados simultaneamente
- Steps 6, 7 e 8 podem rodar em paralelo após seus pré-requisitos respectivos

**Caminho crítico:** Step 3 → Step 4 → Step 5

---

## Tabela de riscos

| Risco | Probabilidade | Impacto | Mitigação |
|-------|---------------|---------|-----------|
| Symlink escape via comparação de string | Baixa | Alto | `fs.realpath` nos dois paths antes de comparar |
| `git --show-toplevel` retorna root do worktree (git submodule / worktree) | Média | Médio | Qualquer exit não-zero = fallback para `projectDir`; worktree root ainda é um boundary razoável |
| Breaking change: configs com `build_context` que escapavam silenciosamente | Média | Médio | `allow_build_context_escape: true` cobre o opt-in; mensagem de erro deve ser clara |
| Breaking change: configs com `image_strategy` ou `framework_profile` | Baixa | Baixo | Projeto pré-produção; mensagem de erro orienta remoção dos campos |
| Zod `.strict()` + `.superRefine()` em conflito com campos removidos | Baixa | Baixo | `.strict()` rejeita campos desconhecidos antes do `.superRefine()`; comportamento já existente |
| Cross-platform paths (Windows): separador `\` vs `/` | Baixa | Médio | `path.relative` + `!rel.startsWith('..')` — não usa `startsWith` no path completo |
| TOCTOU: filesystem muda entre `realpath` e `docker build` | Muito baixa | Baixo | Fora de escopo — modelo de confiança trata `project-config.yml` como trusted; o fix cobre erros não-intencionais |
| Cache do módulo compartilhado entre testes (estado global) | Média | Médio | Testes devem limpar o cache ou mockar o módulo; usar `vi.resetModules()` ou exportar função de limpeza para testes |

---

## Nota sobre mensagens de erro de migração

Quando `image_strategy` ou `framework_profile` estiverem presentes no config, o Zod `.strict()` produz um erro genérico de "Unrecognized key(s)". Para orientar melhor o usuário, considere adicionar um aviso no loader de config (`src/infrastructure/config/`) que detecte essas chaves antes da validação Zod e emita uma mensagem específica:

```
Configuração inválida: scanners.composer.image_strategy foi removido.
Use image_source: 'dockerfile' + dockerfile_path para o mesmo efeito.
```

Isso não bloqueia a implementação — pode ser adicionado como refinamento posterior.
