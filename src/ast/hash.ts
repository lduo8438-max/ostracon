import { createHash } from "node:crypto";
import { collectBindings, declarationName } from "./bindings.ts";
import { SERIALIZER_VERSION, type HashVector, type LanguageProfile, type SynNode } from "./types.ts";

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/** 兩份 shape 雜湊只有在 shapeProfile 相同時才可比較 */
export function shapeProfile(p: LanguageProfile): string {
  return `${p.family}/${p.grammarVersion}/${SERIALIZER_VERSION}`;
}

/**
 * token 序列：捨棄註解，保留其他所有葉節點。
 *
 * tree-sitter 不把空白產生為節點，所以「忽略空白」是自動的；
 * 需要主動處理的只有註解。註解可能出現在任何深度，必須整棵子樹剪掉。
 */
export function tokenStream(
  decl: SynNode,
  profile: LanguageProfile,
): Array<{ type: string; text: string }> {
  const out: Array<{ type: string; text: string }> = [];
  const walk = (n: SynNode) => {
    if (profile.commentTypes.has(n.type)) return;
    if (n.children.length === 0) {
      out.push({ type: n.type, text: n.text });
      return;
    }
    for (const c of n.children) walk(c);
  };
  walk(decl);
  return out;
}

/**
 * S-expression：只走具名節點，保留欄位名。
 *
 *   (if_statement condition:(binary_expression) consequence:(statement_block))
 *
 * 欄位名是刻意保留的。node type 本身就已經綁在 grammar 上，拿掉欄位名換不到
 * 語言中立性，卻真的失去 condition 與 consequence 的角色區分——兩者互換
 * 會雜湊相同。若將來真需要跨語言比較，正確做法是另建 canonical IR 與
 * 獨立雜湊，而不是削弱原生 shape。
 *
 * 括號必須保留：純前序展開的型別序列無法還原樹狀結構，
 * 不同的樹會產生相同的序列。
 */
export function sexp(node: SynNode): string {
  const parts: string[] = [];
  for (const c of node.children) {
    if (!c.isNamed) continue;
    const inner = sexp(c);
    parts.push(c.fieldName ? `${c.fieldName}:${inner}` : inner);
  }
  return parts.length ? `(${node.type} ${parts.join(" ")})` : `(${node.type})`;
}

/** 具名節點數。shape 層的碰撞閘門依據——低於門檻時 shape 不得參與身份判定。 */
export function countNamedNodes(node: SynNode): number {
  let n = node.isNamed ? 1 : 0;
  for (const c of node.children) n += countNamedNodes(c);
  return n;
}

interface AlphaOptions {
  /** 一併正規化的宣告自身名稱（含遞迴呼叫處） */
  selfName?: string;
}

function alphaTokens(
  decl: SynNode,
  profile: LanguageProfile,
  bindings: string[],
  opts: AlphaOptions = {},
): string {
  const index = new Map<string, string>();
  bindings.forEach((name, i) => index.set(name, `$${i}`));
  if (opts.selfName) index.set(opts.selfName, "$self");

  const out: string[] = [];
  for (const t of tokenStream(decl, profile)) {
    // 屬性名與 shorthand 屬性名永不正規化：
    // obj.foo 的 foo 改了就是改語意；{ userId } 的 userId 同時是物件的鍵。
    const normalizable =
      profile.identifierTypes.has(t.type) && !profile.preservedIdentifierTypes.has(t.type);
    const replaced = normalizable ? index.get(t.text) : undefined;
    out.push(`${t.type}\u001f${replaced ?? t.text}`);
  }
  return out.join("\u001e");
}

/**
 * 計算一個宣告的完整雜湊向量。
 *
 * 四層由細到粗：raw ⊃ token ⊃ alpha ⊃ shape。
 * 兩個版本「第一次不相等的那一層」就是變更的性質，
 * 所以 change_level 是一次查表而不是一套規則引擎。
 */
export function hashDeclaration(
  decl: SynNode,
  source: string,
  profile: LanguageProfile,
): HashVector {
  const raw = source.slice(decl.startIndex, decl.endIndex);
  const tokens = tokenStream(decl, profile);
  const bindings = collectBindings(decl, profile);
  const selfName = declarationName(decl, profile);

  return {
    hashRaw: sha(raw),
    hashToken: sha(tokens.map((t) => `${t.type}\u001f${t.text}`).join("\u001e")),
    hashAlpha: sha(alphaTokens(decl, profile, bindings)),
    hashAlphaSelf: sha(alphaTokens(decl, profile, bindings, { selfName })),
    hashShape: sha(sexp(decl)),
    nodeCount: countNamedNodes(decl),
    tokenCount: tokens.length,
    shapeProfile: shapeProfile(profile),
  };
}

export type ChangeLevel = "none" | "raw" | "token" | "alpha" | "shape";

/**
 * 兩個版本第一次相異的層級 = 變更性質。零 LLM，純查表。
 *
 * 這是成本控制的核心：raw 與 token 兩層完全不需要送模型，
 * 實測一般 repo 有六成以上的變更落在這兩層。
 */
export function changeLevel(a: HashVector, b: HashVector): ChangeLevel {
  // profile 是整份雜湊向量的相容性邊界，不只保護 shape 比較。
  // serializer 或 grammar 一變，即使 raw/token 恰巧相等，也不能把兩份
  // 不同定義域的向量當成可比較；保守回報 shape，讓失效顯性化。
  if (a.shapeProfile !== b.shapeProfile) return "shape";
  if (a.hashRaw === b.hashRaw) return "none";
  if (a.hashToken === b.hashToken) return "raw";
  if (a.hashAlpha === b.hashAlpha) return "token";
  if (a.hashShape === b.hashShape) return "alpha";
  return "shape";
}
