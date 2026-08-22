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

  /**
   * 從一個 pattern 節點撈出所有繫結名稱。
   *
   * `preservedFields` 的子樹整棵跳過：它們佔的是屬性名／關鍵字引數名這類位置，
   * 名字改了就是改語意，正規化掉會讓真實改動變成「沒有改動」。
   */
  const harvest = (node: SynNode) => {
    if (profile.identifierTypes.has(node.type)) {
      add(node.text);
      return;
    }
    for (const c of node.children) {
      if (c.fieldName && profile.preservedFields.has(c.fieldName)) continue;
      harvest(c);
    }
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
      const direct = rule.directOnly ?? false;
      // 這裡**刻意不套 preservedFields**：規則指名了欄位就是剖面作者的明確決定，
      // 而 preservedFields 擋的是 harvest 一路遞迴下去時**順帶**撞到的欄位。
      // 兩者混在一起的話，`{ field: "name" }` 這種規則會被自己的保護清單否決。
      for (const c of node.children) {
        if (rule.field !== undefined && c.fieldName !== rule.field) continue;
        // directOnly 時「直屬」指的是 node 的孫節點還是子節點？——子節點。
        // 規則命中的是 node，而 harvest 從 c 開始，所以 c 本身仍要判定。
        if (direct) {
          if (profile.identifierTypes.has(c.type)) add(c.text);
        } else {
          harvest(c);
        }
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
