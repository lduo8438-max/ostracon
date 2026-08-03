import { Buffer } from "node:buffer";
import { fileURLToPath } from "node:url";
import { Language, Parser } from "web-tree-sitter";
import {
  extractDeclarations,
  toSynNode,
  utf8ByteRange,
  verifyAdapter,
} from "./adapter.ts";
import {
  tsxProfile,
  typescriptProfile,
} from "./profiles/typescript.ts";
import type { LanguageProfile, SynNode } from "./types.ts";

export type GrammarKind = "typescript" | "tsx";

export interface ParsedDeclaration {
  node: SynNode;
  qualifiedName: string;
  kind: string;
}

export interface ParsedSource {
  root: SynNode;
  declarations: ParsedDeclaration[];
  profile: LanguageProfile;
  grammar: GrammarKind;
}

const grammarPaths: Record<GrammarKind, string> = {
  typescript: fileURLToPath(
    import.meta.resolve("tree-sitter-typescript/tree-sitter-typescript.wasm"),
  ),
  tsx: fileURLToPath(
    import.meta.resolve("tree-sitter-typescript/tree-sitter-tsx.wasm"),
  ),
};

let runtimeReady: Promise<void> | undefined;
const languages = new Map<GrammarKind, Promise<Language>>();

function ensureRuntime(): Promise<void> {
  runtimeReady ??= Parser.init();
  return runtimeReady;
}

async function languageFor(kind: GrammarKind): Promise<Language> {
  await ensureRuntime();
  let pending = languages.get(kind);
  if (!pending) {
    pending = Language.load(grammarPaths[kind]);
    languages.set(kind, pending);
  }
  return pending;
}

export function grammarForPath(path: string): GrammarKind | undefined {
  if (/\.(?:tsx|jsx)$/i.test(path)) return "tsx";
  if (/\.(?:ts|mts|cts|js|mjs|cjs)$/i.test(path)) return "typescript";
  return undefined;
}

export async function parseSource(
  source: string,
  grammar: GrammarKind,
): Promise<ParsedSource> {
  const language = await languageFor(grammar);
  const parser = new Parser();
  parser.setLanguage(language);
  const tree = parser.parse(source);
  if (!tree) {
    parser.delete();
    throw new Error(`${grammar} parser 未產生語法樹`);
  }
  try {
    const root = toSynNode(tree.rootNode);
    const profile = grammar === "tsx" ? tsxProfile : typescriptProfile;
    return {
      root,
      declarations: extractDeclarations(root, profile),
      profile,
      grammar,
    };
  } finally {
    tree.delete();
    parser.delete();
  }
}

/**
 * 啟動閘門：用真實兩份 grammar 驗證匿名節點、field name、UTF-16 座標與
 * schema UTF-8 byte range。任何一項不成立就停止索引，不允許帶病產生資料。
 */
export async function verifyParserAdapters(): Promise<void> {
  const probes: Array<{ grammar: GrammarKind; source: string; symbol: string }> = [
    {
      grammar: "typescript",
      source: "// 中文 😀\nexport function greet(name: string) { return `你好 ${name}`; }",
      symbol: "greet",
    },
    {
      grammar: "tsx",
      source:
        "// 中文 😀\nexport function Card({name}: {name: string}) { " +
        "return <section aria-label={name}>你好 {name}</section>; }",
      symbol: "Card",
    },
  ];

  for (const probe of probes) {
    const parsed = await parseSource(probe.source, probe.grammar);
    const problems = verifyAdapter(parsed.root, probe.source);
    if (problems.length) {
      throw new Error(
        `${probe.grammar} adapter 驗證失敗：\n${problems.map((p) => `- ${p}`).join("\n")}`,
      );
    }
    const decl = parsed.declarations.find((d) => d.qualifiedName === probe.symbol);
    if (!decl) throw new Error(`${probe.grammar} adapter 找不到探測宣告 ${probe.symbol}`);
    const range = utf8ByteRange(decl.node, probe.source);
    const expectedStart = Buffer.byteLength(
      probe.source.slice(0, decl.node.startIndex),
      "utf8",
    );
    const expectedEnd = Buffer.byteLength(
      probe.source.slice(0, decl.node.endIndex),
      "utf8",
    );
    if (range.startByte !== expectedStart || range.endByte !== expectedEnd) {
      throw new Error(`${probe.grammar} adapter 的 UTF-8 byte range 轉換錯誤`);
    }
  }
}
