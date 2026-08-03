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

  /** 什麼節點算一個「宣告」（entity 的邊界） */
  declarationTypes: ReadonlySet<string>;
  /** 宣告的名稱所在的欄位名 */
  nameField: string;

  /** 區域繫結的產生規則 */
  bindingRules: readonly BindingRule[];
}

/**
 * 一條繫結規則：在 nodeType 節點的 field 欄位底下，出現的識別子是區域繫結。
 * field 省略代表該節點底下所有直屬識別子都算。
 */
export interface BindingRule {
  nodeType: string;
  field?: string;
  /** true 代表要遞迴進解構模式（{a, b} / [x, y]）去撈名字 */
  destructuring?: boolean;
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
