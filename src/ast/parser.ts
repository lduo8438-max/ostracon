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
  GRAMMARS,
  type GrammarKind,
  grammarForPath,
  grammarSpecFor,
} from "./languages.ts";
import type { LanguageProfile, SynNode } from "./types.ts";

// 註冊表是唯一真相；這裡再匯出一次是為了不動既有 import 路徑。
export { GRAMMARS, type GrammarKind, grammarForPath };

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
    pending = Language.load(fileURLToPath(import.meta.resolve(grammarSpecFor(kind).wasm)));
    languages.set(kind, pending);
  }
  return pending;
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
    // 剖面從註冊表取，不再由 grammar 名稱三元式推。原本的
    // `grammar === "tsx" ? tsxProfile : typescriptProfile` 在加入第三種語言時
    // 會把它靜默判成 TypeScript——型別檢查過得去，雜湊卻是用錯剖面算的。
    const profile = grammarSpecFor(grammar).profile;
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
 * 啟動閘門：用每一份真實 grammar 驗證匿名節點、field name、UTF-16 座標與
 * schema UTF-8 byte range。任何一項不成立就停止索引，不允許帶病產生資料。
 *
 * **每一份登記的 grammar 都要有探測**：漏掉一份的話，那個語言會在真實索引時
 * 才第一次被解析，而 adapter 壞掉的症狀是雜湊靜默地錯，不是拋例外。
 * 下面的斷言就是為了讓「有人加了語言卻沒加探測」變成啟動失敗。
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
    {
      grammar: "python",
      // 縮排是 Python 的語法，探測必須真的有一層縮排；只有一行的探測
      // 驗不到 `block` 節點，而 block 正是 shape 層最主要的結構來源。
      source: "# 中文 😀\ndef greet(name: str) -> str:\n    return f\"你好 {name}\"\n",
      symbol: "greet",
    },
  ];

  const covered = new Set(probes.map((p) => p.grammar));
  const missing = GRAMMARS.filter((g) => !covered.has(g.kind)).map((g) => g.kind);
  if (missing.length > 0) {
    throw new Error(`語言註冊表裡的 ${missing.join("、")} 沒有 adapter 探測`);
  }

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
