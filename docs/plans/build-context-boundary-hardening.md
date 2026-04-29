# Plan: Build Context Boundary Hardening

**Status:** Awaiting decision on open questions before implementation  
**Date:** 2026-04-29  
**Author:** Opus 4 (via implementation-planner)

---

## Problema

`src/infrastructure/ecosystem-runtime/build-project-image.ts:123–138` tem uma verificação de segurança fraca para o `build_context`:

```typescript
// warn-only — não bloqueia
if (
  contextDir !== resolvedProjectDir &&
  !contextDir.startsWith(resolvedProjectDir + path.sep)
) {
  logger.warn(`build_context resolves outside the project directory...`);
}
```

**Risco:** `build_context: '../../'` não gera erro — expõe silenciosamente o filesystem ao Docker daemon. Em monorepos, é um caso legítimo, mas sem limite superior.

## Solução

Detectar o git root automaticamente via `git rev-parse --show-toplevel`. Ele vira o **teto máximo** para o `build_context`.

- Dentro do `allowedRoot` → silencioso
- Fora do `allowedRoot`, sem escape hatch → **throw** com mensagem acionável
- Fora do `allowedRoot`, com `allow_build_context_escape: true` → warn (opt-in explícito)
- Sem git → `projectDir` é o teto (fallback mais conservador)

---

## Steps de Implementação

### Step 1 — Novo helper de boundary (independente)

**Arquivo:** `src/infrastructure/ecosystem-runtime/resolve-build-context-boundary.ts` *(novo)*

- Exporta `resolveAllowedBuildContextRoot(projectDir): Promise<{ root: string; source: 'git' | 'project-dir' }>`
- Chama `git -C <projectDir> rev-parse --show-toplevel` via `execFile` (nunca `exec`, sem interpolação de strings)
- Qualquer falha (sem git, non-zero exit, bare repo, worktree) → `{ root: projectDir, source: 'project-dir' }`
- Cache em `Map<projectDir, Promise<...>>` — evita subprocess duplo por CLI run (~10–50ms por invoke)
- Exporta `assertBuildContextWithinBoundary({ contextDir, allowedRoot, boundarySource, logPrefix, allowEscape })`:
  - Lança `Error` descritivo quando `allowEscape !== true` e `contextDir` está fora de `allowedRoot`
  - Mensagem inclui: paths resolvidos, fonte do boundary (`'git root'` vs `'project directory'`), hint para o escape hatch

### Step 2 — Substituir warn-only (depende do Step 1)

**Arquivo:** `src/infrastructure/ecosystem-runtime/build-project-image.ts`

- Remove bloco warn-only (linhas 123–138)
- Adiciona `allowBuildContextEscape?: boolean` em `BuildProjectImageOptions`
- Chama `resolveAllowedBuildContextRoot(projectDir)` e depois `assertBuildContextWithinBoundary(...)`
- Usa `fs.realpath` em ambos os paths antes de comparar (defesa contra symlink escape)
- Usa `path.relative` para containment check — não string prefix (seguro cross-platform)

```
contextDir dentro do allowedRoot       → silencioso, prossegue
fora + allowBuildContextEscape !== true → throw com mensagem acionável
fora + allowBuildContextEscape === true → logger.warn (comportamento atual, mas opt-in)
```

### Step 3 — Adicionar escape hatch no config (independente)

**Arquivos:** `src/core/types/config.ts` + `src/infrastructure/config/schema.ts`

- Adiciona `allow_build_context_escape?: boolean` (default `false`) em `NpmRunnerConfig`, `PipRunnerConfig`, `ComposerRunnerConfig`
- Schema Zod aceita o campo mas **não valida o boundary** — boundary é runtime concern (estado do filesystem), não estrutural

### Step 4 — Wiring em resolve.ts (depende de Steps 2 + 3)

**Arquivo:** `src/infrastructure/ecosystem-runtime/resolve.ts`

- No branch `image_source === 'dockerfile'`, lê `scannerCfg?.allow_build_context_escape`
- Passa como `allowBuildContextEscape` para `buildProjectImage`

---

## Testes

### Step 5 — `resolve-build-context-boundary.test.ts` *(novo, depende do Step 1)*

| Caso | Expectativa |
|------|-------------|
| Diretório dentro de repo git | Retorna git root com `source: 'git'` |
| Diretório sem git | Retorna `projectDir` com `source: 'project-dir'` |
| `git` binary indisponível (mock ENOENT) | Retorna `projectDir` com `source: 'project-dir'` |
| Segunda chamada com mesmo `projectDir` | Não re-invoca `execFile` (cache) |
| `contextDir` === `allowedRoot` | `assertBuildContextWithinBoundary` → ok |
| `contextDir` filho de `allowedRoot` | → ok |
| `contextDir` fora de `allowedRoot`, `allowEscape: false` | → throw com paths na mensagem |
| `contextDir` fora de `allowedRoot`, `allowEscape: true` | → ok (sem throw) |
| Symlink dentro do projeto apontando para fora | → throw (realpath resolve antes de comparar) |

### Step 6 — `build-project-image.test.ts` (depende dos Steps 2 + 4)

| Caso | Expectativa |
|------|-------------|
| `build_context` dentro do `projectDir` | Builds normalmente |
| `build_context` entre `projectDir` e git root (monorepo válido) | Builds normalmente |
| `build_context` exatamente igual ao git root | Builds normalmente |
| `build_context` acima do git root | `throw` com mensagem descritiva |
| `build_context` acima do git root + `allowBuildContextEscape: true` | `logger.warn` + prossegue |
| Non-git: `build_context` acima do `projectDir` | `throw` por padrão |
| Non-git: mesmo caso + `allowBuildContextEscape: true` | `logger.warn` + prossegue |

### Step 7 — `schema.test.ts` (depende do Step 3)

- `allow_build_context_escape: true` → aceito nos 3 runners
- `allow_build_context_escape: false` → aceito
- `allow_build_context_escape: undefined` → aceito
- Valor não-booleano → rejeitado pelo Zod

---

## Riscos e Mitigações

| Risco | Mitigação |
|-------|-----------|
| Symlink escape via `startsWith` | `fs.realpath` antes de comparar em ambos os paths |
| Git submodules/worktrees: `--show-toplevel` retorna root do worktree, não superproject | Qualquer non-zero exit = sem git → fallback para `projectDir` (mais conservador) |
| Breaking change: configs que hoje só warned irão errar | Documentar no release; `allow_build_context_escape: true` cobre o opt-in |
| Cross-platform paths (Windows separators/casing) | `path.relative` + `!rel.startsWith('..')` ao invés de string prefix |
| TOCTOU: filesystem muda entre `realpath` e `docker build` | Fora de escopo — modelo de confiança trata `project-config.yml` como trusted; fix cobre erros não-intencionais, não ataques |

---

## Diagrama de dependências entre steps

```
Step 1 ──────────────────────────► Step 2 ──► Step 4
Step 3 ──────────────────────────► Step 4

Step 1 ──► Step 5 (testes do helper)
Step 2 + Step 4 ──► Step 6 (testes de integração)
Step 3 ──► Step 7 (testes de schema)
```

Steps 1 e 3 podem rodar em paralelo.  
Steps 5, 6 e 7 podem rodar em paralelo após seus pré-requisitos.

---

## Perguntas em aberto

Responder antes de iniciar a implementação:

1. **Escape hatch per-runner vs. global?**  
   Opus recomenda **per-runner** — mais granular, consistente com onde `build_context` já vive. Alternativa: um flag global `allow_build_context_escape: true` no topo do config que se propaga para todos os runners.

2. **Non-git + contexto acima do `projectDir`?**  
   Opus recomenda **rejeitar por padrão** — sem git, não há teto seguro. Isso é um breaking change para projetos não-git que usam `build_context` acima do `projectDir`. Alternativa: warn (comportamento atual) para não-git, throw apenas quando git root é detectado.
