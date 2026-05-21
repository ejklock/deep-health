<!-- GENERATED — do not edit. Source: quick-start.template.md -->
# security-scan — Guia de Início Rápido

Instale, configure e rode seu primeiro `fix` em menos de 5 minutos.
Para configuração avançada, consulte o [Guia de Uso Completo](./usage-guide.md).

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
| Linux (x64) | `security-scan-0.2.1-20260518-153358-linux-x64` |
| Linux (arm64) | `security-scan-0.2.1-20260518-153358-linux-arm64` |
| macOS (arm64 / Apple Silicon) | `security-scan-0.2.1-20260518-153358-macos-arm64` |
| Windows (x64) | `security-scan-0.2.1-20260518-153358-win-x64.exe` |

O padrão de nome é `security-scan-{versão}-{timestamp}-{plataforma}`. Sempre baixe a release mais recente.

### Linux e macOS

```bash
# Substitua pelo nome do arquivo que você baixou
chmod +x ./security-scan-0.2.1-20260518-153358-linux-x64

# Opcional: disponibilizar globalmente
sudo mv ./security-scan-0.2.1-20260518-153358-linux-x64 /usr/local/bin/security-scan
```

Verifique a instalação:

```bash
security-scan --version
```

### Windows

No PowerShell, renomeie o arquivo baixado para `security-scan.exe` e adicione-o a um diretório que esteja no `PATH`.

---

## Inicialização

Na **raiz do projeto** que você quer analisar, rode:

```bash
security-scan init
```

O assistente interativo vai guiá-lo pelas perguntas de configuração. Ao final, ele cria o arquivo `project-config.yml` no diretório atual com as configurações do projeto.

> Dica: rode `init` dentro do diretório do projeto, não em um diretório pai — isso garante que os caminhos relativos (Dockerfile, lockfiles) sejam detectados corretamente.

---

## Rodando o fix

Com o projeto inicializado, execute:

```bash
security-scan fix
```

O comando vai:

1. Escanear as dependências em busca de vulnerabilidades (via OSV Scanner)
2. Tentar corrigir automaticamente os pacotes vulneráveis
3. Gerar um relatório em `.security-scan/reports/`

**Quer ver o que seria feito sem aplicar nada?** Use `--dry-run`:

```bash
security-scan fix --dry-run
```

---

## Referência rápida

| Comando | O que faz |
|---|---|
| `security-scan init` | Configura o projeto interativamente |
| `security-scan fix` | Escaneia e corrige vulnerabilidades |
| `security-scan fix --dry-run` | Simula o fix sem aplicar mudanças |
| `security-scan fix --create-branch` | Cria um branch Git antes de aplicar o fix |
| `security-scan scan` | Apenas escaneia, sem corrigir |
| `security-scan --help` | Lista todos os comandos disponíveis |

---

Para configurações avançadas (Dockerfile personalizado, SonarQube, múltiplos projetos, variáveis de ambiente), consulte o [Guia de Uso Completo](./usage-guide.md).
