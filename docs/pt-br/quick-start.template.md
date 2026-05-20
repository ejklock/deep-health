# {{CLI_NAME}} — Guia de Início Rápido

Instale, configure e rode seu primeiro `fix` em menos de 5 minutos.
Para configuração avançada, consulte o [Guia de Uso Completo]({{USAGE_GUIDE_LINK}}).

---

## Pré-requisitos

| Ferramenta | Obrigatório | Observação |
|---|---|---|
| Docker | **Sim** | Todas as execuções de runtime acontecem em containers. Não é necessário instalar Node.js, PHP ou Python localmente. |

> O Docker precisa estar rodando antes de qualquer comando `scan` ou `fix`.

---

## Instalação

Acesse a página de releases: **[https://github.com/ejklock/osv-security-cli/releases](https://github.com/ejklock/osv-security-cli/releases)**

Baixe o binário para o seu sistema:

| Plataforma | Exemplo de arquivo |
|---|---|
| Linux (x64) | `{{CLI_NAME}}-0.2.1-20260518-153358-linux-x64` |
| Linux (arm64) | `{{CLI_NAME}}-0.2.1-20260518-153358-linux-arm64` |
| macOS (arm64 / Apple Silicon) | `{{CLI_NAME}}-0.2.1-20260518-153358-macos-arm64` |
| Windows (x64) | `{{CLI_NAME}}-0.2.1-20260518-153358-win-x64.exe` |

O padrão de nome é `{{CLI_NAME}}-{versão}-{timestamp}-{plataforma}`. Sempre baixe a release mais recente.

### Linux e macOS

```bash
# Substitua pelo nome do arquivo que você baixou
chmod +x ./{{CLI_NAME}}-0.2.1-20260518-153358-linux-x64

# Opcional: disponibilizar globalmente
sudo mv ./{{CLI_NAME}}-0.2.1-20260518-153358-linux-x64 /usr/local/bin/{{CLI_NAME}}
```

Verifique a instalação:

```bash
{{CLI_NAME}} --version
```

### Windows

No PowerShell, renomeie o arquivo baixado para `{{CLI_NAME}}.exe` e adicione-o a um diretório que esteja no `PATH`.

---

## Inicialização

Na **raiz do projeto** que você quer analisar, rode:

```bash
{{CLI_NAME}} init
```

O assistente interativo vai guiá-lo pelas perguntas de configuração. Ao final, ele cria o arquivo `project-config.yml` no diretório atual com as configurações do projeto.

> Dica: rode `init` dentro do diretório do projeto, não em um diretório pai — isso garante que os caminhos relativos (Dockerfile, lockfiles) sejam detectados corretamente.

---

## Rodando o fix

Com o projeto inicializado, execute:

```bash
{{CLI_NAME}} fix
```

O comando vai:

1. Escanear as dependências em busca de vulnerabilidades (via OSV Scanner)
2. Tentar corrigir automaticamente os pacotes vulneráveis
3. Gerar um relatório em `{{CLI_DIR}}/reports/`

**Quer ver o que seria feito sem aplicar nada?** Use `--dry-run`:

```bash
{{CLI_NAME}} fix --dry-run
```

---

## Referência rápida

| Comando | O que faz |
|---|---|
| `{{CLI_NAME}} init` | Configura o projeto interativamente |
| `{{CLI_NAME}} fix` | Escaneia e corrige vulnerabilidades |
| `{{CLI_NAME}} fix --dry-run` | Simula o fix sem aplicar mudanças |
| `{{CLI_NAME}} fix --create-branch` | Cria um branch Git antes de aplicar o fix |
| `{{CLI_NAME}} scan` | Apenas escaneia, sem corrigir |
| `{{CLI_NAME}} --help` | Lista todos os comandos disponíveis |

---

Para configurações avançadas (Dockerfile personalizado, SonarQube, múltiplos projetos, variáveis de ambiente), consulte o [Guia de Uso Completo]({{USAGE_GUIDE_LINK}}).
