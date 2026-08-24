import { pythonProfile } from "./profiles/python.ts";
import { tsxProfile, typescriptProfile } from "./profiles/typescript.ts";
import type { LanguageProfile } from "./types.ts";

/**
 * 語言註冊表：副檔名 → grammar wasm → 語言剖面。
 *
 * **加一種語言只能改這一個檔案加一份剖面。** 在此之前這三件事分散在
 * `parser.ts` 的三個地方（`GrammarKind` 聯集、`grammarPaths` 紀錄、
 * `grammarForPath` 的兩條正規表示式，外加 `parseSource` 裡
 * `grammar === "tsx" ? tsxProfile : typescriptProfile` 這個三元式），
 * 而那個三元式在加入第三種語言的當下會**靜默地**把 Python 判成 TypeScript：
 * 型別檢查過得去，剖面卻是錯的，四層雜湊照樣算得出數字。
 */
export interface GrammarSpec {
  /** 對外的 grammar 名稱，同時是 wasm 的快取鍵 */
  kind: string;
  /**
   * 解析用的 wasm。用 npm specifier 而不是相對路徑：封裝後 `dist/` 與
   * `node_modules/` 的相對位置與原始碼樹不同，`import.meta.resolve` 兩邊都對。
   */
  wasm: string;
  profile: LanguageProfile;
  /**
   * 認得的副檔名，一律小寫、含點。順序有意義：`grammarForPath` 取第一個命中的，
   * 所以 `.tsx` 必須排在 `.ts` 之前處理——這裡改用完整比對，沒有前綴問題。
   */
  extensions: readonly string[];
  /**
   * 這個語言的**測試檔命名慣例**（目錄慣例是跨語言的，不放這裡）。
   *
   * 它會出現在這個介面而不是 `LanguageProfile`，是因為它不是 grammar 知識——
   * `LanguageProfile` 描述的是語法樹，這一條描述的是社群慣例。但它確實是
   * 「加一種語言要一起帶進來的東西」，所以歸註冊表管。
   *
   * 少了它的症狀是實測到的：`ostracised` 的判準原本只認得 JS/TS 慣例，於是
   * psf/requests 根目錄的 `test_requests.py` 整份被當成「被推翻的做法」列出來。
   */
  testFilePattern?: RegExp;
}

export const GRAMMARS: readonly GrammarSpec[] = [
  {
    kind: "tsx",
    wasm: "tree-sitter-typescript/tree-sitter-tsx.wasm",
    profile: tsxProfile,
    extensions: [".tsx", ".jsx"],
    testFilePattern: /\.(spec|test|bench)\.[cm]?[jt]sx?$/,
  },
  {
    kind: "typescript",
    wasm: "tree-sitter-typescript/tree-sitter-typescript.wasm",
    profile: typescriptProfile,
    extensions: [".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"],
    testFilePattern: /\.(spec|test|bench)\.[cm]?[jt]sx?$/,
  },
  {
    kind: "python",
    wasm: "tree-sitter-python/tree-sitter-python.wasm",
    profile: pythonProfile,
    // `.pyi` 是型別存根，只有簽章沒有實作。收它會讓同一個函式在
    // `foo.py` 與 `foo.pyi` 各有一個實體，而兩者的血緣其實是同一條。
    extensions: [".py"],
    // pytest 與 unittest 的慣例。`conftest.py` 刻意不收：它是設定不是測試，
    // 而且裡面的 fixture 被推翻時確實是一個值得看見的決定。
    testFilePattern: /(^|\/)(test_[^/]+|[^/]+_test)\.py$/,
  },
];

export type GrammarKind = (typeof GRAMMARS)[number]["kind"];

/**
 * 副檔名 → grammar。**同一個副檔名不得出現在兩份剖面裡**，否則 `parseSource`
 * 的結果會取決於陣列順序，而那不是任何人會去讀的東西。
 */
const byExtension = new Map<string, GrammarSpec>();
for (const spec of GRAMMARS) {
  for (const ext of spec.extensions) {
    const existing = byExtension.get(ext);
    if (existing) {
      throw new Error(
        `副檔名 ${ext} 同時登記給 ${existing.kind} 與 ${spec.kind}，語言註冊表有衝突`,
      );
    }
    byExtension.set(ext, spec);
  }
}

const byKind = new Map(GRAMMARS.map((spec) => [spec.kind, spec]));

export function grammarSpecFor(kind: GrammarKind): GrammarSpec {
  const spec = byKind.get(kind);
  if (!spec) throw new Error(`未登記的 grammar：${kind}`);
  return spec;
}

/**
 * 從路徑判斷該用哪個 grammar，認不得就回 undefined（那個檔案整個不索引）。
 *
 * 取最後一個點之後的部分，不用正規表示式：`Makefile.py.bak` 這種不該命中，
 * 而 `/\.py$/` 之類的寫法每加一種語言就要多維護一條。
 */
export function grammarForPath(pathName: string): GrammarKind | undefined {
  const at = pathName.lastIndexOf(".");
  if (at < 0) return undefined;
  return byExtension.get(pathName.slice(at).toLowerCase())?.kind;
}
