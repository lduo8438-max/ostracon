/**
 * tree-sitter → SynNode 的 adapter。
 *
 * ⚠️ 這是整個 Day 3 唯一沒有被測試覆蓋的檔案。
 * 開發環境的 npm 被封鎖，web-tree-sitter 裝不起來，所以這層映射只有型別檢查，
 * 沒有實際執行過。請務必第一件事就是拿真實檔案跑 `verifyAdapter` 驗證。
 *
 * 相對地，hash.ts / bindings.ts / profiles 的核心邏輯已有手工樹測試覆蓋——
 * 把雜湊層寫成對 SynNode 操作而非直接吃 tree-sitter，就是為了讓
 * 「裝不了解析器」不會連帶讓核心邏輯無法驗證。
 */
import { Buffer } from "node:buffer";
import type { LanguageProfile, SynNode } from "./types.ts";

/** web-tree-sitter 的最小介面，避免在型別層綁死版本 */
interface TsNode {
  type: string;
  isNamed: boolean;
  text: string;
  startIndex: number;
  endIndex: number;
  childCount: number;
  child(i: number): TsNode | null;
  fieldNameForChild(i: number): string | null;
}

/**
 * 把 tree-sitter 節點轉成 SynNode。
 *
 * 三個容易踩到的點：
 *  1. 必須用 child() 走「全部」子節點，不是 namedChild()——token 層需要
 *     標點與關鍵字，只有 shape 層才過濾具名節點。
 *  2. fieldNameForChild 是由父節點查詢的，不是節點自身的屬性。
 *  3. startIndex/endIndex 是 UTF-16 碼元位移，不是位元組。原始碼含非 ASCII
 *     時（中文註解、emoji）拿去 slice Buffer 會錯位。這裡一律以 JS 字串
 *     為單位處理，schema 的 byte_start/byte_end 要在寫入前換算。
 */
export function toSynNode(n: TsNode, fieldName?: string): SynNode {
  const children: SynNode[] = [];
  for (let i = 0; i < n.childCount; i++) {
    const c = n.child(i);
    if (!c) continue;
    children.push(toSynNode(c, n.fieldNameForChild(i) ?? undefined));
  }
  return {
    type: n.type,
    fieldName,
    isNamed: n.isNamed,
    text: n.text,
    startIndex: n.startIndex,
    endIndex: n.endIndex,
    children,
  };
}

/**
 * 把 SynNode 的 JS 字串座標轉成 schema revision.byte_start/byte_end 所需的
 * UTF-8 byte offset。只需對即將持久化的 declaration 呼叫，不必轉整棵樹。
 */
export function utf8ByteRange(
  node: SynNode,
  source: string,
): { startByte: number; endByte: number } {
  return {
    startByte: Buffer.byteLength(source.slice(0, node.startIndex), "utf8"),
    endByte: Buffer.byteLength(source.slice(0, node.endIndex), "utf8"),
  };
}

/**
 * 從一棵檔案樹中抽出所有宣告。
 *
 * `const Foo = () => {}` 這種要特別處理：declarationTypes 含 variable_declarator，
 * 但只有 value 是函式或類別時才算一個實體，否則普通的 const 也會被當成宣告。
 */
export function extractDeclarations(
  root: SynNode,
  profile: LanguageProfile,
): Array<{ node: SynNode; qualifiedName: string; kind: string }> {
  const out: Array<{ node: SynNode; qualifiedName: string; kind: string }> = [];

  const nameOf = (n: SynNode): string | undefined =>
    n.children.find((c) => c.fieldName === profile.nameField)?.text;

  const isFunctionLike = (n: SynNode): boolean => {
    const v = n.children.find((c) => c.fieldName === "value");
    return !!v && /^(arrow_function|function|function_expression|class)$/.test(v.type);
  };

  const walk = (n: SynNode, prefix: string) => {
    if (profile.declarationTypes.has(n.type)) {
      const name = nameOf(n);
      if (name && (n.type !== "variable_declarator" || isFunctionLike(n))) {
        const qualified = prefix ? `${prefix}.${name}` : name;
        out.push({ node: n, qualifiedName: qualified, kind: n.type });
        // 類別成員要帶著類別名當前綴，讓 qualifiedName 與 fixture 的
        // symbol 欄位（ClassName.method）對得上。
        for (const c of n.children) walk(c, qualified);
        return;
      }
    }
    for (const c of n.children) walk(c, prefix);
  };

  walk(root, "");
  return out;
}

/**
 * adapter 自檢。第一次接上 tree-sitter 時務必跑它。
 *
 * 檢查三件事：欄位名有被填上、匿名節點有被保留、位移能還原原始文字。
 * 這三項任何一項壞掉，四層雜湊都會靜默地錯——而且錯得很難察覺，
 * 因為雜湊本來就是不可讀的。
 */
export function verifyAdapter(root: SynNode, source: string): string[] {
  const problems: string[] = [];
  let anonymous = 0;
  let withField = 0;
  let total = 0;

  const walk = (n: SynNode) => {
    total++;
    if (!n.isNamed) anonymous++;
    if (n.fieldName) withField++;
    const slice = source.slice(n.startIndex, n.endIndex);
    if (slice !== n.text) {
      problems.push(
        `位移與文字不符 @${n.type} [${n.startIndex},${n.endIndex}]：` +
          `slice=${JSON.stringify(slice.slice(0, 40))} text=${JSON.stringify(n.text.slice(0, 40))}`,
      );
    }
    for (const c of n.children) walk(c);
  };
  walk(root);

  if (anonymous === 0) {
    problems.push("完全沒有匿名節點——大概用了 namedChild() 而非 child()，token 層會缺標點與關鍵字");
  }
  if (withField === 0) {
    problems.push("完全沒有欄位名——fieldNameForChild 沒接上，shape 層會失去角色區分");
  }
  if (total < 2) problems.push("樹只有一個節點，解析可能失敗");
  return problems;
}
