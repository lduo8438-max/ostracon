import type { LanguageProfile } from "../types.ts";

/**
 * Python 的語言剖面。
 *
 * 這份剖面的目的不是「支援 Python」，是**驗證架構沒有寫死在單一語言**
 * （見 `CLAUDE.md` 的非目標清單：W1–W6 只支援 TypeScript）。它值得存在，
 * 是因為寫它的過程逼出了三個原本藏在語言中立層裡的 TypeScript 假設：
 *
 *  1. `adapter.ts` 直接用字面值判斷 `variable_declarator` / `value` /
 *     `arrow_function`──改成 `valueBearingDeclarations`。
 *  2. `preservedIdentifierTypes` 依**型別**保護屬性名，而那只在 grammar 給了
 *     專屬型別時才成立。Python 的 `self._d` 的 `_d` 就是普通 `identifier`──
 *     改成同時支援依**欄位**保護（`preservedFields`）。
 *  3. `BindingRule.destructuring` 的註解說它會遞迴進解構模式，實際上兩個分支
 *     都會遞迴，旗標完全無作用（實測 650 個宣告差異為 0）。真正需要的是反向的
 *     `directOnly`──Python 的 `parameters` 少了它會把型別註記收成繫結。
 *
 * 三個都是「宣稱語言中立、只在一種語言上驗過」的同一型缺陷。
 */

/**
 * Python 沒有 TypeScript 那種「值是函式才算宣告」的形狀：`def` 與 `class`
 * 本身就是宣告，`x = lambda: 1` 刻意不收（那是賦值，不是宣告；而且收了會讓
 * 每一個模組層級的常數都變成候選實體）。所以 `valueBearingDeclarations` 留空。
 */
const baseProfile: Omit<LanguageProfile, "family" | "grammarVersion"> = {
  commentTypes: new Set(["comment"]),

  /**
   * Python 的 grammar 只有一種識別子型別。所有角色差異都在欄位上，
   * 這正是 `preservedFields` 必須存在的原因。
   */
  identifierTypes: new Set(["identifier"]),

  /** 依型別保護不到任何東西——Python 不給屬性名專屬型別。 */
  preservedIdentifierTypes: new Set<string>(),

  /**
   * `attribute`：`self._d` 的 `_d`。與 TypeScript 的 `property_identifier` 同義，
   * 差別只在 Python 用欄位而不是型別來標示它。收成繫結的話 `self._d` 與
   * `self._cache` 的 alpha 雜湊會相等——改欄位名變成「沒有改動」。
   *
   * 清單只有這一條是刻意的。`keyword_argument` 的 `name`（`f(timeout=3)` 的
   * `timeout`）同樣不該收，但**沒有任何規則會遞迴到呼叫的引數列**，加進來只會
   * 讓人以為那條路徑存在。欄位名 `name` 更是不能放：`{ field: "name" }` 是
   * bindingRules 裡最常用的選擇器。
   */
  preservedFields: new Set(["attribute"]),

  /**
   * `decorated_definition` 刻意**不**列入。它是包裝節點，名字在子節點的
   * `definition` 欄位底下，直接列入會抽不到名稱；而 `extractDeclarations` 會走
   * 進它的子節點，所以被裝飾的函式仍然收得到。
   *
   * 代價是**裝飾器本身不在實體範圍內**：`@property` 改成 `@cached_property`
   * 四層雜湊全部看不到。這是已知限制，不是疏漏──修它要改的是實體邊界，
   * 那會動到 `stable_key`，必須另外提版本並重跑黃金測試集。
   */
  declarationTypes: new Set(["function_definition", "class_definition"]),

  nameField: "name",

  bindingRules: [
    // ── 參數 ────────────────────────────────────────────────────────────
    // `directOnly` 是必要的：`(self, url: str)` 裡 `str` 也是 identifier，
    // 只是埋在 `type` 底下。整棵遞迴會把型別名收成繫結，於是
    // `def f(x: int)` 與 `def f(x: str)` 的 alpha 雜湊相等。
    { nodeType: "parameters", directOnly: true },
    { nodeType: "lambda_parameters", directOnly: true },
    { nodeType: "default_parameter", field: "name" },
    { nodeType: "typed_parameter", directOnly: true },
    { nodeType: "typed_default_parameter", field: "name" },
    // *args / **kwargs。這兩個節點底下只有名字，整棵收是安全的。
    { nodeType: "list_splat_pattern" },
    { nodeType: "dictionary_splat_pattern" },

    // ── 賦值 ────────────────────────────────────────────────────────────
    // `left` 可能是 identifier、pattern_list（a, b = …）或 attribute
    // （self._d = …）。attribute 的屬性名由 preservedFields 擋掉，
    // 但物件那一半（`self`）仍會被收——它本來就是參數，收兩次不影響。
    { nodeType: "assignment", field: "left" },
    { nodeType: "augmented_assignment", field: "left" },
    // 海象運算子 `if (n := f()) > 0`
    { nodeType: "named_expression", field: "name" },

    // ── 巢狀宣告 ────────────────────────────────────────────────────────
    { nodeType: "function_definition", field: "name" },
    { nodeType: "class_definition", field: "name" },

    // ── 迴圈與 with／except ─────────────────────────────────────────────
    { nodeType: "for_statement", field: "left" },
    // 生成式：`[x*2 for x in data]`
    { nodeType: "for_in_clause", field: "left" },
    // `with open(p) as fh` 與 `except E as err` 都走 as_pattern。
    { nodeType: "as_pattern", field: "alias" },

    // ── 型別參數（PEP 695，Python 3.12+）─────────────────────────────────
    { nodeType: "type_parameter", directOnly: true },
  ],
};

/** 必須與 package.json 鎖定的 tree-sitter-python 精確版本一致。 */
export const PYTHON_GRAMMAR_VERSION = "0.25.0";

export const pythonProfile: LanguageProfile = {
  ...baseProfile,
  family: "python",
  grammarVersion: PYTHON_GRAMMAR_VERSION,
};
