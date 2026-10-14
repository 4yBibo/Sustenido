# nano-banana-mcp

Servidor MCP (stdio) que expõe o Nano Banana Pro (`gemini-3-pro-image`) ao Claude Code neste projeto.

## Ferramentas
- `generate_image`: texto para imagem. Parâmetros: `prompt`, `aspect_ratio`, `size` (1K/2K/4K), `name`.
- `edit_image`: até 14 imagens de referência mais um prompt geram uma imagem editada ou combinada.

As imagens vão para `tools/nano-banana-mcp/out/` (ou `NANO_BANANA_OUT`). A ferramenta devolve o caminho.

## Configuração
1. `npm install` nesta pasta.
2. Coloque a chave em `.env` nesta pasta: `GEMINI_API_KEY=...`. O arquivo é ignorado pelo git.
3. O registro já está em `.mcp.json` na raiz do projeto. O Claude Code pede aprovação na primeira sessão aberta aqui.

Variáveis opcionais: `NANO_BANANA_MODEL`, `NANO_BANANA_OUT`.
