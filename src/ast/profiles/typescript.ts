import type { LanguageProfile } from "../types.ts";

/**
 * TypeScript / TSX 的語言剖面。
 *
 * 全部 grammar 相依的知識集中在這一個檔案。加新語言＝新增一份剖面，
 * 不動 hash.ts 與 bindings.ts。
 *
 * grammarVersion 必須跟著實際安裝的 tree-sitter-typescript 走——
 * grammar 升版可能改變節點型別，那會讓所有既有雜湊失效，
 * 而 shape_profile 就是用來讓「失效」變成可偵測而不是靜默錯誤的。
 */
const baseProfile: Omit<LanguageProfile, "family" | "grammarVersion"> = {

  commentTypes: new Set(["comment"]),

  identifierTypes: new Set([
    "identifier",
    "type_identifier",
    "shorthand_property_identifier",
    "shorthand_property_identifier_pattern",
  ]),

  /**
   * 永不正規化。
   *
   * property_identifier：obj.foo 的 foo。改了就是呼叫別的東西。
   * shorthand_property_identifier：{ userId } 同時是鍵與值——
   *   正規化會把物件的鍵名一起改掉，{ userId } 與 { sessionId } 會雜湊相同。
   *   這是整份剖面裡最容易漏掉的一條。
   * statement_identifier：label，改名不影響語意但也不值得為它建索引。
   */
  preservedIdentifierTypes: new Set([
    "property_identifier",
    "shorthand_property_identifier",
    "statement_identifier",
  ]),

  declarationTypes: new Set([
    "function_declaration",
    "generator_function_declaration",
    "class_declaration",
    "method_definition",
    "abstract_method_signature",
    "interface_declaration",
    "type_alias_declaration",
    "enum_declaration",
    // const Foo = () => {} 這種要由 adapter 從 lexical_declaration
    // 往下找到 variable_declarator，再判斷 value 是否為函式。
    "variable_declarator",
  ]),

  nameField: "name",

  bindingRules: [
    // 參數
    { nodeType: "required_parameter", field: "pattern", destructuring: true },
    { nodeType: "optional_parameter", field: "pattern", destructuring: true },
    { nodeType: "rest_pattern", destructuring: true },
    // 區域變數宣告
    { nodeType: "variable_declarator", field: "name", destructuring: true },
    // 巢狀函式與類別
    { nodeType: "function_declaration", field: "name" },
    { nodeType: "generator_function_declaration", field: "name" },
    { nodeType: "class_declaration", field: "name" },
    // catch
    { nodeType: "catch_clause", field: "parameter", destructuring: true },
    // for...of / for...in
    { nodeType: "for_in_statement", field: "left", destructuring: true },
    // 型別參數 <T>
    { nodeType: "type_parameter", field: "name" },
  ],
};

/** 必須與 package.json 鎖定的 tree-sitter-typescript 精確版本一致。 */
export const TYPESCRIPT_GRAMMAR_VERSION = "0.23.2";

export const typescriptProfile: LanguageProfile = {
  ...baseProfile,
  family: "typescript",
  grammarVersion: TYPESCRIPT_GRAMMAR_VERSION,
};

/**
 * TSX 與 TypeScript 來自同一個 npm 套件，但使用不同 grammar WASM。
 * family 必須不同，否則兩份解析定義域會共用 shape_profile。
 */
export const tsxProfile: LanguageProfile = {
  ...baseProfile,
  family: "tsx",
  grammarVersion: TYPESCRIPT_GRAMMAR_VERSION,
};
