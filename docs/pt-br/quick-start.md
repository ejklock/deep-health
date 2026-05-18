# deep-health — Guia de Início Rápido

> Este guia é autossuficiente: do download ao primeiro `fix` bem-sucedido, sem precisar consultar mais nada.
> Para a referência completa de configuração, consulte [usage-guide.md](./usage-guide.md).

---

## Sumário

1. [Pré-requisitos](#pré-requisitos)
2. [Download do binário](#download-do-binário)
3. [Rodando o init](#rodando-o-init)
   - [Onde rodar o init](#onde-rodar-o-init)
   - [Cada etapa do assistente interativo](#cada-etapa-do-assistente-interativo)
4. [Configuração do Dockerfile](#configuração-do-dockerfile)
   - [Quando o Dockerfile está na raiz do projeto](#quando-o-dockerfile-está-na-raiz-do-projeto)
   - [Quando o init é rodado de um diretório pai](#quando-o-init-é-rodado-de-um-diretório-pai)
   - [build_context e allow_build_context_escape](#build_context-e-allow_build_context_escape)
5. [Windows + SonarQube](#windows--sonarqube)
6. [Rodando o fix](#rodando-o-fix)
   - [Fases do pipeline](#fases-do-pipeline)
   - [Flags principais](#flags-principais)
7. [Referência rápida de comandos](#referência-rápida-de-comandos)

---

## Pré-requisitos

| Ferramenta | Obrigatório | Observação |
|---|---|---|
| Docker | **Sim** | Todas as execuções de runtime (npm, composer, pip, OSV Scanner, SonarQube) acontecem dentro de containers Docker. Não é preciso instalar Node.js, PHP ou Python localmente. |

> **Atenção:** o Docker precisa estar rodando antes de qualquer comando `scan` ou `fix`.

---

## Download do binário

Acesse a página de releases do projeto:

**[https://github.com/ejklock/osv-security-cli/releases](https://github.com/ejklock/osv-security-cli/releases)**

Baixe o binário correspondente ao seu sistema operacional:

| Plataforma | Exemplo de arquivo |
|---|---|
| Linux (x64) | `deep-health-0.2.1-20260518-153358-linux-x64` |
| Linux (arm64) | `deep-health-0.2.1-20260518-153358-linux-arm64` |
| macOS (arm64 / Apple Silicon) | `deep-health-0.2.1-20260518-153358-macos-arm64` |
| Windows (x64) | `deep-health-0.2.1-20260518-153358-win-x64.exe` |

O padrão de nome é `deep-health-{versão}-{timestamp}-{plataforma}`. Baixe sempre o binário da release mais recente.

### Linux e macOS

Após o download, torne o binário executável e mova-o para algum lugar no seu `PATH`:

```bash
# Substitua o nome do arquivo pelo que você baixou
chmod +x ./deep-health-0.2.1-20260518-153358-linux-x64

# Opcional: mover para /usr/local/bin para usar globalmente
sudo mv ./deep-health-0.2.1-20260518-153358-linux-x64 /usr/local/bin/deep-health

# Verificar
deep-health --version
```

### Windows

Baixe o arquivo `.exe` e, se quiser usar de qualquer lugar no terminal, adicione o diretório onde ele está ao `PATH` do sistema ou rode diretamente pelo caminho completo:

```powershell
.\deep-health-win-x64.exe --version
```

---

## Rodando o init

### Onde rodar o init

**Rode o `init` de dentro do diretório raiz do código-fonte do projeto** — o mesmo diretório onde ficam os arquivos de dependências como `package.json`, `composer.json`, `requirements.txt` ou `Pipfile`.

```bash
# Navegue até a raiz do projeto
cd /caminho/para/meu-projeto

# Confirme que você está no lugar certo
ls
# package.json  composer.json  Dockerfile  ...

# Agora rode o init
deep-health init
```

O `init` detecta automaticamente os ecossistemas presentes (npm, composer, pip) lendo os arquivos de manifesto. Se você rodar de um diretório errado, nenhum ecossistema será detectado e você terá que configurar tudo manualmente.

---

### Cada etapa do assistente interativo

O `init` faz uma série de perguntas. Veja o que cada uma significa:

#### 1. Language / Idioma

```
Language / Idioma
> English (en)
  Português (pt-br)
```

Seleciona o idioma das mensagens do CLI e dos relatórios gerados. Esta é a única pergunta bilíngue, pois aparece antes de qualquer idioma ser definido. Use as setas do teclado e pressione Enter para confirmar.

---

#### 2. Nome do projeto e nome do cliente

```
Nome do projeto: [Project]
Nome do cliente: [Client Name]
```

Esses valores aparecem nos relatórios HTML gerados pelo `fix`. Preencha com nomes que identifiquem bem o projeto — são apenas informativos.

---

#### 3. Seleção de ecossistemas

```
Selecione os ecossistemas para configurar (Espaço para marcar, Enter para confirmar)
> [x] NPM (npm)
  [x] Composer (composer)
  [ ] pip (pip)
```

Use **Espaço** para marcar/desmarcar e **Enter** para confirmar. Os ecossistemas detectados automaticamente já aparecem marcados. Se o seu projeto usa apenas npm, desmarque os demais para não gerar configurações desnecessárias.

---

#### 4. Estratégia de fix (por ecossistema)

```
[NPM] Estratégia de correção
> osv
  osv-then-audit
  npm-audit
```

Define como o CLI decide quais pacotes atualizar:

| Opção | Descrição |
|---|---|
| `osv` | Usa o OSV Scanner para calcular as atualizações. **Padrão e recomendado para todos os ecossistemas.** É o melhor ponto de partida. |
| `osv-then-audit` | Aplica o fix do OSV Scanner primeiro e depois roda `npm audit fix` por cima. Disponível apenas para npm. |
| `npm-audit` | Usa somente `npm audit fix`. Mais compatível com lockfiles antigos (v1). Disponível apenas para npm. |

**Recomendação:** comece com `osv`. Se precisar de cobertura adicional para npm, experimente `osv-then-audit`. Para **composer** e **pip**, `osv` é a única estratégia disponível.

---

#### 5. Comandos de validação (por ecossistema)

```
[NPM] Incluir comando de validação "test"? (Y/n)
[NPM] Comando de validação "test": [npm test]
```

Após aplicar as atualizações, o `fix` executa esses comandos dentro do container Docker para confirmar que nada quebrou. Se a validação falhar, as alterações são revertidas automaticamente.

- Aceite o padrão sugerido ou ajuste para o comando de testes do seu projeto (ex: `npm run test:ci`).
- Se quiser pular a validação, responda **N** quando perguntado se quer incluir o comando.

> **Dica:** inclua pelo menos um comando de validação. Sem ele, o fix aplica as atualizações sem verificar se o projeto continua funcionando.

---

#### 6. Advisors (por ecossistema)

```
[NPM] Incluir advisor "npm-audit"? (Y/n)
[NPM] Comando do advisor "npm-audit": [npm audit --json]
```

Advisors são comandos informativos que rodam antes das atualizações. Eles produzem dados para o relatório final mas **nunca bloqueiam o pipeline**. O `npm audit --json` é o advisor padrão para npm.

---

#### 7. Versão da linguagem (por ecossistema)

```
[NPM] Versão da linguagem (detectada: 20, deixe em branco para usar a detectada)
```

O CLI lê arquivos como `.nvmrc`, `.node-version`, `package.json#engines.node`, `.php-version`, `composer.json#require.php`, `runtime.txt` e `.python-version` para detectar a versão automaticamente.

- Se a versão correta foi detectada, pressione **Enter** para aceitar.
- Se não foi detectada ou está errada, digite a versão desejada (ex: `20`, `8.2`, `3.11`).
- Deixar em branco quando não há versão detectada faz o CLI usar uma imagem genérica padrão.

Esta versão é usada para selecionar a imagem Docker correta (ex: `node:20`, `php:8.2`, `python:3.11`).

---

#### 8. Origem da imagem — image source (por ecossistema)

```
[NPM] Origem da imagem
> pull — usa uma imagem padrão do registry
  dockerfile — constrói a partir do Dockerfile do projeto
```

| Opção | Quando usar |
|---|---|
| `pull` **(padrão)** | Funciona para a maioria dos projetos. O CLI baixa uma imagem genérica (ex: `node:20`, `php:8.2-cli`) e executa as atualizações dentro dela. Se o seu projeto não tem dependências de sistema muito específicas, esta opção já resolve. |
| `dockerfile` | Use quando o projeto tem dependências, bibliotecas ou extensões que a imagem genérica não tem. Por exemplo: extensões PHP como `imagick`, bibliotecas nativas como `libvips`, ou qualquer coisa que precise estar no ambiente para o build/test funcionar. |

> **Projetos PHP + Node (ou outro ecossistema misto):** se o seu projeto usa npm junto com outro ecossistema (ex: um projeto Laravel com assets compilados por Node), e você escolher `dockerfile` para o runner de composer, o Dockerfile **precisa ter Node instalado**. Isso porque o CLI roda comandos Node usando aquele Dockerfile — e se o Node não estiver lá, os comandos vão falhar.

Se escolher `dockerfile`, o assistente continua com as próximas perguntas sobre o caminho do Dockerfile.

---

#### 9. Caminho do Dockerfile (quando image source = dockerfile)

```
[NPM] Caminho do Dockerfile: [./Dockerfile]
[NPM] Contexto de build (deixe em branco para '.'): []
[NPM] Argumentos de build (CHAVE=VALOR separados por vírgula, deixe em branco para ignorar): []
```

- **Caminho do Dockerfile:** caminho relativo ao diretório atual onde o `init` está sendo rodado. Se o Dockerfile está na mesma pasta que o `package.json`, use `./Dockerfile`. Veja a seção [Configuração do Dockerfile](#configuração-do-dockerfile) para casos mais complexos.
- **Contexto de build:** diretório usado como raiz para o `docker build`. Deixe em branco para usar `.` (diretório atual). Altere apenas se o seu Dockerfile faz `COPY` de arquivos fora do diretório atual.
- **Argumentos de build:** variáveis passadas via `--build-arg` para o Docker. Formato: `CHAVE1=VALOR1,CHAVE2=VALOR2`. Deixe em branco se não houver.

---

#### 10. SonarQube

```
Habilitar scanner SonarQube? (y/N)
```

Se sim:

```
Modo do SonarQube
> Gerenciado (recomendado) — sobe um container SonarQube via Docker, sem precisar de servidor
  Externo — conecta a um servidor SonarQube existente (melhor desempenho, sem overhead de container)
```

| Modo | Descrição |
|---|---|
| Gerenciado | O CLI sobe e derruba um container SonarQube automaticamente a cada execução. Mais simples, sem setup. Mais lento (aguarda o SonarQube inicializar). |
| Externo | Conecta a um servidor SonarQube já em execução. Mais rápido. Exige configuração adicional no `sonar-project.properties`. Recomendado para Windows (veja a seção [Windows + SonarQube](#windows--sonarqube)). |

Quando o SonarQube é habilitado, o CLI cria automaticamente um arquivo `sonar-project.properties` com um template inicial caso ele ainda não exista.

---

#### 11. Relatórios em Markdown

```
Gerar relatórios em markdown? (Y/n)
Diretório de saída dos relatórios: [.deep-health/reports]
```

Se habilitado, o `fix` salva relatórios em Markdown no diretório informado. O padrão `.deep-health/reports` funciona bem para a maioria dos casos.

---

### Após o init

O CLI gera o arquivo `project-config.yml` no diretório atual e exibe os próximos passos:

```
Criado: /caminho/para/meu-projeto/project-config.yml

Próximos passos:
  1. Edite project-config.yml conforme o seu projeto
  2. Revise protected_packages — adicione pacotes que não devem ser atualizados automaticamente
  3. Execute: deep-health scan --cwd <diretório-do-projeto>
```

Revise o `project-config.yml` gerado antes de rodar o `fix`. Preste atenção especialmente em:
- `protected_packages` — liste pacotes que **não** devem ser atualizados automaticamente (ex: `laravel/framework`).
- Caminhos de Dockerfile, se aplicável.

---

## Configuração do Dockerfile

Esta é a parte que mais causa confusão. Entender como o `dockerfile_path` e o `build_context` funcionam evita erros na hora de rodar o `fix`.

### Quando o Dockerfile está na raiz do projeto

Estrutura mais comum:

```
meu-projeto/
├── Dockerfile          ← Dockerfile aqui
├── package.json
├── src/
└── project-config.yml  ← gerado pelo init
```

Neste caso, o `init` foi rodado de dentro de `meu-projeto/` e o Dockerfile está no mesmo diretório. A configuração correta é:

```yaml
runners:
  npm:
    language_version: '20'
    image_source: 'dockerfile'
    dockerfile_path: './Dockerfile'
    build_context: '.'
```

Ou de forma equivalente, simplesmente `./Dockerfile` no prompt — que é o valor padrão sugerido.

---

### Quando o init é rodado de um diretório pai

Em alguns projetos, a estrutura pode ser assim:

```
workspace/
├── Dockerfile          ← Dockerfile está aqui (nível acima do código)
└── app/
    ├── package.json    ← código do projeto aqui
    └── project-config.yml
```

Neste caso, o `init` deve ser rodado de dentro de `app/`:

```bash
cd workspace/app
deep-health init
```

Mas o Dockerfile está em `workspace/`, um nível acima. O caminho relativo a partir de `app/` é `../Dockerfile`.

**No prompt do init:**

```
[NPM] Caminho do Dockerfile: ../Dockerfile
[NPM] Contexto de build (deixe em branco para '.'): ../
```

Isso gera a seguinte configuração:

```yaml
runners:
  npm:
    language_version: '20'
    image_source: 'dockerfile'
    dockerfile_path: '../Dockerfile'
    build_context: '../'
    allow_build_context_escape: true
```

> **Importante:** quando o `build_context` aponta para fora do diretório atual (como `../`), é necessário adicionar `allow_build_context_escape: true` manualmente no `project-config.yml`. O CLI usa essa flag para confirmar que você sabe que o contexto de build está fora dos limites do projeto.

---

### build_context e allow_build_context_escape

| Campo | O que faz |
|---|---|
| `dockerfile_path` | Caminho do arquivo Dockerfile, relativo ao diretório onde o `init` foi rodado (e onde o `project-config.yml` está). |
| `build_context` | Diretório raiz passado para o `docker build`. Todos os `COPY` e `ADD` no Dockerfile são relativos a este caminho. Padrão: `.` |
| `allow_build_context_escape` | Quando `true`, permite que o `build_context` aponte para fora da raiz do projeto. Defina como `true` quando usar caminhos como `../`. Por padrão é `false` (comentado na config gerada). |
| `build_args` | Variáveis passadas via `--build-arg` para o `docker build`. Útil para passar variáveis de ambiente necessárias no build. |

**Exemplo completo com build args:**

```yaml
runners:
  composer:
    language_version: '8.2'
    image_source: 'dockerfile'
    dockerfile_path: '../Dockerfile'
    build_context: '../'
    build_args:
      APP_ENV: 'local'
      COMPOSER_AUTH: '{"github-oauth":{"github.com":"token"}}'
    allow_build_context_escape: true
```

---

## Windows + SonarQube

O `deep-health` com SonarQube funciona no Windows — não há incompatibilidade. O ponto de atenção é o modo **Gerenciado**: em algumas configurações de Windows, ele pode ser **muito lento**, porque o CLI sobe um container SonarQube do zero a cada execução (aguarda o servidor inicializar, roda o scan, depois derruba o container). Dependendo da máquina, isso pode levar vários minutos por run.

A abordagem recomendada para Windows é usar o modo **Externo**: manter um servidor SonarQube rodando permanentemente via Docker Desktop e apontar o CLI para ele.

### Passo 1: subir o SonarQube localmente

Use o Docker Compose para subir um servidor SonarQube na sua máquina:

```yaml
# docker-compose.sonar.yml
version: '3.8'
services:
  sonarqube:
    image: sonarqube:community
    ports:
      - '9000:9000'
    environment:
      - SONAR_ES_BOOTSTRAP_CHECKS_DISABLE=true
    volumes:
      - sonarqube_data:/opt/sonarqube/data
      - sonarqube_logs:/opt/sonarqube/logs
      - sonarqube_extensions:/opt/sonarqube/extensions

volumes:
  sonarqube_data:
  sonarqube_logs:
  sonarqube_extensions:
```

```bash
docker compose -f docker-compose.sonar.yml up -d
```

Aguarde alguns segundos e acesse **http://localhost:9000**. O login padrão é `admin` / `admin`. Na primeira vez, o SonarQube pedirá para você alterar a senha.

### Passo 2: criar um projeto e gerar um token

1. No SonarQube, crie um novo projeto local (ou use o nome do seu projeto).
2. Vá em **My Account → Security → Generate Tokens**.
3. Crie um token do tipo **Project Analysis Token** e copie o valor.

### Passo 3: configurar o sonar-project.properties

O `init` cria um arquivo `sonar-project.properties` com um template inicial quando você habilita o SonarQube. Edite-o para adicionar as informações do seu servidor local:

```properties
sonar.projectKey=meu-projeto
sonar.projectName=Meu Projeto
sonar.sources=src
sonar.exclusions=**/node_modules/**,**/vendor/**,**/tests/**

# Servidor local (modo externo)
sonar.host.url=http://host.docker.internal:9000
sonar.token=seu-token-aqui
```

> **Nota sobre `host.docker.internal`:** quando o `fix` roda dentro de um container Docker, ele não enxerga `localhost` da máquina host. Use `host.docker.internal` no lugar de `localhost` para apontar para o SonarQube rodando na sua máquina. Isso funciona automaticamente no Docker Desktop para Windows e macOS.

### Passo 4: configurar o modo externo no project-config.yml

No `project-config.yml`, certifique-se de que o SonarQube está no modo externo:

```yaml
scanners:
  sonarqube:
    enabled: true
    mode: external
```

Agora o `deep-health fix` vai conectar ao SonarQube local em vez de tentar subir um container gerenciado.

---

## Rodando o fix

Com o `project-config.yml` configurado, rode o `fix` de dentro do diretório do projeto:

```bash
cd /caminho/para/meu-projeto
deep-health fix
```

### Fases do pipeline

O `fix` executa as seguintes fases em ordem:

| Fase | O que acontece |
|---|---|
| **scan** | Roda o OSV Scanner (Gate A) contra os lockfiles do projeto. Classifica as vulnerabilidades como `auto_safe` (patch/minor sem breaking changes) ou `breaking` (major ou mudança de constraint). |
| **npm / composer / pip** | Para cada ecossistema configurado: aplica as atualizações `auto_safe` dentro de um container Docker isolado, depois executa os comandos de validação configurados. Se a validação falhar, as mudanças daquele ecossistema são **revertidas automaticamente** e o pipeline continua com os próximos. |
| **report** | Gera o relatório HTML executivo com comparação antes/depois de vulnerabilidades. Se `outputs.formats` inclui `markdown`, salva também em Markdown no diretório configurado. |

### O que acontece em caso de falha na validação

Se os testes quebrarem após uma atualização, o CLI:
1. Reverte todas as alterações daquele ecossistema (lockfile, arquivos de dependência).
2. Registra o erro no relatório final.
3. **Continua** processando os outros ecossistemas — uma falha em npm não impede o fix de composer.

### Flags principais

| Flag | O que faz |
|---|---|
| `--dry-run` | Simula todo o pipeline sem modificar nenhum arquivo. Útil para ver o que seria feito antes de executar de verdade. |
| `--authorize-breaking <id...>` | Autoriza atualizações breaking (major) para os ecossistemas informados. **Use com cuidado:** breaking changes podem quebrar a compatibilidade. |
| `--phases <fases>` | Roda apenas as fases informadas (separadas por vírgula). Ex: `--phases scan,npm`. |
| `--no-report` | Pula a geração do relatório HTML. |
| `-v, --verbose` | Exibe logs detalhados de cada etapa. Útil para debug. |

**Exemplos práticos:**

```bash
# Ver o que seria feito sem executar nada
deep-health fix --dry-run

# Autorizar atualizações breaking em composer
deep-health fix --authorize-breaking composer

# Autorizar breaking em múltiplos ecossistemas
deep-health fix --authorize-breaking npm composer

# Rodar apenas o scan e o fix de npm (sem composer, pip e relatório)
deep-health fix --phases scan,npm

# Fix silencioso (apenas erros e relatório final)
deep-health fix --quiet
```

### Códigos de saída do fix

| Código | Significado |
|---|---|
| `0` | Tudo resolvido (ou nada para corrigir) |
| `1` | Vulnerabilidades encontradas, erros de atualização ou vulnerabilidades pendentes |
| `2` | Falha de gate ou erro no scanner |
| `3` | Erro de configuração |

---

## Referência rápida de comandos

| Comando | O que faz |
|---|---|
| `deep-health init` | Gera o `project-config.yml` via assistente interativo |
| `deep-health init --force` | Sobrescreve o `project-config.yml` existente |
| `deep-health scan` | Varre vulnerabilidades (somente leitura, sem modificar arquivos) |
| `deep-health fix` | Pipeline completo: scan → atualizar → validar → relatório |
| `deep-health fix --dry-run` | Simula o pipeline sem modificar nada |
| `deep-health fix --authorize-breaking npm` | Fix autorizando breaking changes em npm |
| `deep-health fix --phases scan,npm` | Roda apenas as fases informadas |
| `deep-health --help` | Exibe ajuda geral |
| `deep-health fix --help` | Exibe ajuda do comando fix |

---

> Para configurações avançadas (protected_packages, safe_update_policy, cloud storage, CI/CD), consulte o [Guia Completo de Uso](./usage-guide.md).
