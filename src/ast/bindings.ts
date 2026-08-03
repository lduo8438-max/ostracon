import type { LanguageProfile, SynNode } from "./types.ts";

/**
 * 收集一個宣告內部的區域繫結名稱，依首次出現順序排列。
 *
 * ── 已知限制：這是名稱比對，不是作用域解析 ──────────────────────────────
 * 若區域變數 x 遮蔽了同名的全域 x，兩者都會被正規化。真正的作用域解析需要
 * 完整的 resolver，成本高出一個數量級。
 *
 * 代價是「過度正規化」：alpha 雜湊可能對兩段其實不同的程式碼判定相等，
 * 於是 change_level 會把本該是 alpha 的變更報成 token。這是誤判但不是災難，
 * 而且方向是保守的——會少送 LLM，不會多送。
 *
 * 反方向（漏掉該正規化的名字）才會造成假的 alpha 變更，成本是多花錢。
 * 所以規則寧可寬一點。
 */
export function collectBindings(decl: SynNode, profile: LanguageProfile): string[] {
  const order: string[] = [];
  const seen = new Set<string>();

  const add = (name: string) => {
    if (!name || seen.has(name)) return;
    seen.add(name);
    order.push(name);
  };

  /** 從一個 pattern 節點撈出所有繫結名稱，會遞迴進解構 */
  const harvest = (node: SynNode, deep: boolean) => {
    if (profile.identifierTypes.has(node.type)) {
      add(node.text);
      return;
    }
    // 解構模式中的 shorthand（{ a, b }）在 tree-sitter 裡是
    // shorthand_property_identifier_pattern 這類節點——它在 pattern 位置
    // 確實是繫結，跟物件字面值裡的同名節點意義相反，所以只在這裡撈。
    if (node.type.endsWith("_pattern") || deep) {
      for (const c of node.children) harvest(c, true);
      return;
    }
    for (const c of node.children) harvest(c, deep);
  };

  const walk = (node: SynNode, isRoot: boolean) => {
    // 根節點自身的名稱不是它自己的區域繫結。
    //
    // function_declaration → name 是繫結規則（為了處理巢狀函式），但套在根上
    // 會把實體自己的名字也正規化，於是 hash_alpha 等同 hash_alpha_self，
    // 兩者的區別整個消失——純改名就再也無法與「改名且改內容」區分。
    // 宣告自身的名稱歸 hash_alpha_self 管，不歸這裡。
    for (const rule of isRoot ? [] : profile.bindingRules) {
      if (node.type !== rule.nodeType) continue;
      if (rule.field) {
        for (const c of node.children) {
          if (c.fieldName === rule.field) harvest(c, rule.destructuring ?? false);
        }
      } else {
        for (const c of node.children) harvest(c, rule.destructuring ?? false);
      }
    }
    for (const c of node.children) walk(c, false);
  };

  walk(decl, true);
  return order;
}

/** 取得宣告自身的名稱（供 hash_alpha_self 使用）。找不到回 undefined。 */
export function declarationName(
  decl: SynNode,
  profile: LanguageProfile,
): string | undefined {
  for (const c of decl.children) {
    if (c.fieldName === profile.nameField) return c.text;
  }
  return undefined;
}
