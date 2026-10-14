<p align="center">
  <img src="web/icons/roxo.png" width="128" alt="">
</p>

<h1 align="center">Sustenido</h1>

<p align="center"><strong>Edição Markdown visual para Windows.</strong><br>
Escreva e veja a formatação ao mesmo tempo. Leve, rápido, offline.</p>

<p align="center">
  <a href="https://github.com/4yBibo/Sustenido/releases">Download</a> ·
  <a href="#recursos">Recursos</a> ·
  <a href="#atalhos">Atalhos</a> ·
  <a href="#desenvolvimento">Desenvolvimento</a>
</p>

---

## Por que

O Bloco de Notas é rápido, mas não formata. Os editores de Markdown completos pesam centenas de megabytes e abrem em vários segundos. O Sustenido fica no meio: **16 MB em disco, abre em menos de 2 segundos**, e mostra títulos, listas, tabelas, fórmulas e diagramas enquanto você digita, no estilo do Obsidian.

## Recursos

**Escrever**
- Live Preview: a formatação aparece na hora; a sintaxe só reaparece onde o cursor está
- Barra de formatação flutuante ao selecionar texto: título, negrito, itálico, marca-texto, cor do texto, código, link, emoji
- Marca-texto em qualquer cor; por padrão, na cor do tema
- Tabelas rápidas: digite `| Item | Qtd |`, pressione Enter; Tab navega entre células
- Auto-fechamento de parênteses, aspas, `*` e `_`
- Fórmulas LaTeX (`$E = mc^2$`), diagramas Mermaid, destaque de sintaxe em blocos de código
- Notas de rodapé `[^1]`, propriedades em YAML, links `[[entre notas]]`, imagens arrastadas para a nota

**Organizar**
- Abas, como no Bloco de Notas do Windows 11, com sessão restaurada ao reabrir
- Pasta de notas na barra lateral, com subpastas
- Painel de estrutura com os títulos da nota
- Histórico de navegação (Alt+← / Alt+→)
- Modo foco e modo máquina de escrever

**Exportar e importar**
- PDF, Word (.docx), HTML e Markdown
- Importa HTML e PDF como Markdown
- Copiar a nota inteira formatada para colar no Word, Gmail ou Notion

**Aparência**
- Tema claro, escuro ou do sistema
- 20 cores de destaque; o ícone do app acompanha a cor
- Efeito de vidro (acrílico) do Windows 11
- Tamanho do texto ajustável

## Atalhos

| Ação | Atalho |
| --- | --- |
| Ler / editar | `Ctrl+E` |
| Nova aba · Abrir · Salvar | `Ctrl+N` · `Ctrl+O` · `Ctrl+S` |
| Localizar · Substituir · Ir para linha | `Ctrl+F` · `Ctrl+H` · `Ctrl+G` |
| Negrito · Itálico · Link | `Ctrl+B` · `Ctrl+I` · `Ctrl+K` |
| Marca-texto | `Ctrl+Shift+H` |
| Estrutura da nota | `Ctrl+Shift+O` |
| Modo foco · Máquina de escrever | `F8` · `F9` |
| Barra lateral | `Ctrl+\` |
| Próxima aba | `Ctrl+Tab` |
| Configurações | `Ctrl+,` |

## Instalação

Requisitos: Windows 10 ou 11 (64 bits). O [WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/) já vem com o Windows 11 e com o Edge.

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1
```

Instala para o usuário atual, sem administrador, registra o Sustenido para `.md` e `.markdown` e abre a tela de Aplicativos padrão do Windows para você confirmar. `install.ps1 -Uninstall` remove tudo.

## Desenvolvimento

- Host: C# (.NET Framework 4.8, WinForms) + WebView2 — [Program.cs](Program.cs)
- Interface: HTML/CSS/JS sem framework, CodeMirror 6, marked, KaTeX, Mermaid — [src/](src/), [web/](web/)
- Build: `dotnet build Sustenido.csproj -c Release -o bin\out` (o esbuild roda dentro do build)
- Testes: `npm test`
- Ícones: `tools/make-icons.ps1` gera as 20 variantes a partir de `assets/icon-source.png`
- Pacote para a Microsoft Store: `tools/make-msix.ps1`

## Licença

MIT. Fontes: Inter e Work Sans (OFL).
