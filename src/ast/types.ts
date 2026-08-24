/**
 * 雜湊層對語法樹的最小介面。
 *
 * 刻意不直接吃 tree-sitter 的 SyntaxNode——與 lineage.ts 不吃 git 是同一個理由：
 * 四層雜湊是整個系統的地基，它必須能在沒有解析器的情況下用手工樹徹底測試。
 * tree-sitter 只留一層 adapter 負責把 cursor 走成這個形狀。
 */
export interface SynNode {
  /** tree-sitter 的節點型別，例如 function_declaration、identifier */
  type: string;
  /** 在父節點中的欄位名，例如 condition、consequence、body。無則 undefined */
  fieldName?: string;
  /** 具名節點（grammar 中有名字的），對應 tree-sitter 的 isNamed */
  isNamed: boolean;
  /** 此節點涵蓋的原始碼 */
  text: string;
  /** JS 字串中的 UTF-16 code-unit index；不是 schema 的 byte offset */
  startIndex: number;
  endIndex: number;
  /** 全部子節點，含匿名節點（標點、關鍵字） */
  children: SynNode[];
}

/**
 * 語言剖面：把所有 grammar 相依的知識集中在一處。
 *
 * 加新語言＝新增一份剖面，不動雜湊邏輯。
 */
export interface LanguageProfile {
  /** 語言家族，進入 shape_profile */
  family: string;
  /** grammar 版本，進入 shape_profile。grammar 一升版節點型別就可能改，雜湊必須跟著作廢 */
  grammarVersion: string;
  /**
   * 剖面本身的版本。**改動任何會影響「哪個節點是宣告」或「哪個名字是繫結」的
   * 欄位都必須提升它**——那些欄位決定雜湊的輸入，不變量 7 適用。
   *
   * 它進的是 **declarations pass 的版本字串**，不是 `shape_profile`。理由：
   * `shape_profile` 回答的是「這兩個雜湊在同一趟 pass 裡可不可以比較」，而同一趟
   * pass 的兩側都是用當下的剖面現場觀察出來的，本來就一致——它偵測不到版本變更。
   * 真正會讓新舊規則混進同一個資料庫的是**續跑**，而擋住續跑的是 pass 版本，
   * 那裡已經有「版本不符就拒絕並要求刪檔重建」的路徑。
   */
  profileVersion: string;

  /** 註解節點型別。token 層要整批捨棄 */
  commentTypes: ReadonlySet<string>;
  /**
   * 可被正規化的識別子節點型別。
   * 只有這些型別的節點才可能被換成 $n。
   */
  identifierTypes: ReadonlySet<string>;
  /**
   * 永不正規化的識別子型別。
   *
   * property_identifier：obj.foo 的 foo 是屬性名，改了就是改語意。
   * shorthand_property_identifier：{ userId } 同時是鍵與值，
   *   正規化會把物件的鍵名一起改掉——這是最容易漏掉的一個。
   */
  preservedIdentifierTypes: ReadonlySet<string>;
  /**
   * 永不正規化的**欄位**。佔據這些欄位的子樹整棵不當繫結。
   *
   * 這個欄位的存在本身就是一個實測發現：`preservedIdentifierTypes` 是**依型別**
   * 保護的，而那只在 grammar 願意給屬性名一個專屬型別時才成立。TypeScript 給了
   * （`property_identifier`），Python 沒有——`self._d` 的 `_d` 與區域變數 `_d`
   * 同樣是 `identifier`，唯一的差別是它佔據 `attribute` 這個欄位。
   *
   * 少了這一條，Python 的 `self._d = x` 會把屬性名 `_d` 收成繫結，於是
   * `self._d` 與 `self._cache` 的 alpha 雜湊相等——改欄位名會變成「沒有改動」。
   */
  preservedFields: ReadonlySet<string>;

  /** 什麼節點算一個「宣告」（entity 的邊界） */
  declarationTypes: ReadonlySet<string>;
  /**
   * 包裝節點：實體的邊界該落在包裝上，名稱卻在被包裝的宣告裡。
   * key 是包裝節點型別，value 是被包裝宣告所在的欄位名。
   *
   * Python 的 `decorated_definition` 是唯一的使用者：`@property` 與它裝飾的
   * `def` 是同一件事的兩半，邊界切在 `def` 上會讓 `@property` 換成
   * `@cached_property` **四層雜湊全部看不見**。
   *
   * TypeScript 不需要它——`decorator` 在那份 grammar 裡是 `class_declaration`
   * 的**子節點**而不是包裝，本來就落在邊界內。這正是「同一個概念兩種 grammar
   * 兩種形狀」的又一例。
   */
  declarationWrappers: ReadonlyMap<string, string>;
  /** 宣告的名稱所在的欄位名 */
  nameField: string;
  /**
   * 只有在某個欄位是函式／類別時才算宣告的節點型別。
   *
   * TypeScript 的 `const f = () => {}`：`variable_declarator` 進得了
   * `declarationTypes`，但普通的 `const n = 1` 不該算一個實體。
   * Python 沒有這種形狀，所以留 undefined——**這段判定原本寫死在 adapter 裡**，
   * 而 adapter 是語言中立層。
   */
  valueBearingDeclarations?: {
    types: ReadonlySet<string>;
    /** 值所在的欄位名 */
    valueField: string;
    /** 值是這些型別之一才算宣告 */
    functionTypes: ReadonlySet<string>;
  };

  /** 區域繫結的產生規則 */
  bindingRules: readonly BindingRule[];
}

/**
 * 一條繫結規則：在 nodeType 節點的 field 欄位底下，出現的識別子是區域繫結。
 * field 省略代表整個節點底下都算。
 *
 * **原本這裡有一個 `destructuring` 旗標，已刪除**：它的註解寫著「遞迴進解構模式」，
 * 但 `harvest` 兩個分支都會遞迴進全部子節點，所以旗標開不開結果完全一樣。
 * 對 `src/`（437 個宣告）與 create-t3-app（213 個）實測差異為 0。
 * 真正需要的軸線是反過來的那一個——**要不要只看直屬子節點**，見 `directOnly`。
 */
export interface BindingRule {
  nodeType: string;
  field?: string;
  /**
   * true 代表只收直屬子節點裡的識別子，不往下遞迴。
   *
   * Python 的 `parameters` 需要它：`(self, url: str)` 裡 `self` 是直屬 identifier，
   * 而 `url: str` 的 `str` 也是 identifier，只是埋在 `type` 底下。整棵遞迴會把
   * 型別名收成繫結，於是 `def f(x: int)` 與 `def f(x: str)` 的 alpha 雜湊相等。
   */
  directOnly?: boolean;
}

export interface HashVector {
  hashRaw: string;
  hashToken: string;
  hashAlpha: string;
  /** alpha 再加上「宣告自身的名稱也正規化」，讓純改名可由雜湊相等判定 */
  hashAlphaSelf: string;
  hashShape: string;
  /** 具名節點數。shape 層的碰撞閘門依據 */
  nodeCount: number;
  tokenCount: number;
  /** 依語言剖面與序列化器版本產生，兩份 shape 雜湊只有在 profile 相同時才可比較 */
  shapeProfile: string;
}

/**
 * 序列化器版本。
 *
 * 任何會改變雜湊輸出的變更都必須提升它——包含 token 過濾規則、
 * 繫結判定、S-expression 的寫法。不提升的話新舊雜湊會混在同一個資料庫裡，
 * 而且「不相等」會被誤讀成「程式碼有變」。
 */
export const SERIALIZER_VERSION = "sexp-1.0.0";
