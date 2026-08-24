import { unwrapDeclaration } from "./adapter.ts";
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
    //
    // **「根」不等於「傳進來的那個節點」。** 剖面 1.1.0 讓 Python 的實體節點
    // 變成包裝節點 `decorated_definition`，真正的 `function_definition` 因此
    // 降成子節點——`isRoot` 對它是 false，上面那條規則於是命中，宣告自己的
    // 名字被當成區域繫結收走。實測 psf/requests HEAD：137 個帶裝飾器的宣告
    // （807 之中的 17.0%）全部 `hash_alpha === hash_alpha_self`，正是這段
    // 註解說要避免的那個狀態。所以包裝底下那一層也算根（見下方遞迴）。
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
    // 包裝節點只包一層，所以「還是根」最多往下傳一層，不會擴散。
    const wrappedField = isRoot ? profile.declarationWrappers.get(node.type) : undefined;
    for (const c of node.children) {
      walk(c, wrappedField !== undefined && c.fieldName === wrappedField);
    }
  };

  walk(decl, true);
  return order;
}

/**
 * 取得宣告自身的名稱（供 hash_alpha_self 使用）。找不到回 undefined。
 *
 * 包裝節點底下才有 `name` 欄位：`decorated_definition` 的直屬子節點只有
 * `decorator` 與 `definition`。不先解開的話這裡一律回 undefined，
 * `hash_alpha_self` 就退化成 `hash_alpha`，L3b 對帶裝飾器的宣告永遠不觸發。
 */
export function declarationName(
  decl: SynNode,
  profile: LanguageProfile,
): string | undefined {
  const target = unwrapDeclaration(decl, profile) ?? decl;
  for (const c of target.children) {
    if (c.fieldName === profile.nameField) return c.text;
  }
  return undefined;
}
