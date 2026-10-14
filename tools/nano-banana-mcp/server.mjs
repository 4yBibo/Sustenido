#!/usr/bin/env node
// MCP server que expõe o Nano Banana Pro (gemini-3-pro-image) como ferramenta.
// Transporte stdio. Nunca loga a chave. Salva imagens em disco e devolve o caminho.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Lê .env ao lado deste arquivo, se existir; a variável de ambiente tem prioridade.
try { process.loadEnvFile(new URL(".env", import.meta.url)); } catch {}
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error("GEMINI_API_KEY não definida.");
  process.exit(1);
}

const MODEL = process.env.NANO_BANANA_MODEL ?? "gemini-3-pro-image";
const OUT_DIR = resolve(process.env.NANO_BANANA_OUT ?? fileURLToPath(new URL("out", import.meta.url)));

const ai = new GoogleGenAI({ apiKey });

const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };

async function loadReference(path) {
  const mimeType = MIME[extname(path).toLowerCase()];
  if (!mimeType) throw new Error(`Formato não suportado: ${path}`);
  const data = (await readFile(path)).toString("base64");
  return { inlineData: { mimeType, data } };
}

async function generate({ prompt, references = [], aspectRatio, imageSize, name }) {
  const parts = [...(await Promise.all(references.map(loadReference))), { text: prompt }];

  const response = await ai.models.generateContent({
    model: MODEL,
    contents: [{ role: "user", parts }],
    config: {
      responseModalities: ["IMAGE", "TEXT"],
      imageConfig: { aspectRatio, imageSize },
    },
  });

  const candidate = response.candidates?.[0];
  const outParts = candidate?.content?.parts ?? [];
  const texts = [];
  const files = [];

  await mkdir(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");

  for (const part of outParts) {
    if (part.text) texts.push(part.text);
    if (part.inlineData?.data) {
      const ext = part.inlineData.mimeType === "image/jpeg" ? "jpg" : "png";
      const file = resolve(OUT_DIR, `${name ?? "image"}-${stamp}-${files.length + 1}.${ext}`);
      await writeFile(file, Buffer.from(part.inlineData.data, "base64"));
      files.push(file);
    }
  }

  if (files.length === 0) {
    const reason = candidate?.finishReason ?? "sem candidato";
    throw new Error(`Nenhuma imagem retornada (${reason}). ${texts.join(" ")}`.trim());
  }

  return { files, texts };
}

const server = new McpServer({ name: "nano-banana-pro", version: "1.0.0" });

const common = {
  prompt: z.string().min(1).describe("Descrição da imagem ou da edição desejada."),
  aspect_ratio: z
    .enum(["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"])
    .optional()
    .describe("Proporção. Padrão: 1:1."),
  size: z.enum(["1K", "2K", "4K"]).optional().describe("Resolução. Padrão: 1K."),
  name: z.string().regex(/^[\w-]+$/).optional().describe("Prefixo do arquivo de saída."),
};

server.registerTool(
  "generate_image",
  {
    title: "Gerar imagem (Nano Banana Pro)",
    description: "Gera uma imagem a partir de texto com o Nano Banana Pro e salva em disco. Retorna o caminho do arquivo.",
    inputSchema: common,
  },
  async ({ prompt, aspect_ratio, size, name }) => {
    const { files, texts } = await generate({ prompt, aspectRatio: aspect_ratio, imageSize: size, name });
    return { content: [{ type: "text", text: [...files, ...texts].join("\n") }] };
  },
);

server.registerTool(
  "edit_image",
  {
    title: "Editar imagem (Nano Banana Pro)",
    description:
      "Edita ou combina até 14 imagens de referência (PNG/JPG/WebP) seguindo o prompt. Retorna o caminho do arquivo gerado.",
    inputSchema: {
      ...common,
      images: z.array(z.string()).min(1).max(14).describe("Caminhos absolutos das imagens de referência."),
    },
  },
  async ({ prompt, images, aspect_ratio, size, name }) => {
    const { files, texts } = await generate({ prompt, references: images, aspectRatio: aspect_ratio, imageSize: size, name });
    return { content: [{ type: "text", text: [...files, ...texts].join("\n") }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
