import { test } from "node:test";
import assert from "node:assert/strict";
import { changeLevel, countNamedNodes, hashDeclaration, sexp, tokenStream } from "../src/ast/hash.ts";
import { collectBindings } from "../src/ast/bindings.ts";
import { typescriptProfile as TS } from "../src/ast/profiles/typescript.ts";
import type { SynNode } from "../src/ast/types.ts";

/**
 * 手工建樹。tree-sitter 在此環境裝不起來，但這其實是對的做法：
 * 雜湊邏輯不該依賴解析器，才能對每個邊界條件做精確的單元測試。
 */
let cursor = 0;
function leaf(type: string, text: string, opts: { field?: string; named?: boolean } = {}): SynNode {
  const startIndex = cursor;
  cursor += text.length;
  return {
    type, text, startIndex, endIndex: cursor,
    isNamed: opts.named ?? true,
    fieldName: opts.field,
    children: [],
  };
}
function node(type: string, children: SynNode[], opts: { field?: string } = {}): SynNode {
  return {
    type,
    text: children.map((c) => c.text).join(""),
    startIndex: children[0]?.startIndex ?? 0,
    endIndex: children.at(-1)?.endIndex ?? 0,
    isNamed: true,
    fieldName: opts.field,
    children,
  };
}
const reset = () => { cursor = 0; };

/** function <name>(<param>) { return <retIdent>; } */
function fn(name: string, param: string, retIdent: string, comment?: string): SynNode {
  reset();
  const kids: SynNode[] = [
    leaf("identifier", name, { field: "name" }),
    node("formal_parameters", [
      node("required_parameter", [leaf("identifier", param, { field: "pattern" })]),
    ], { field: "parameters" }),
  ];
  const body: SynNode[] = [];
  if (comment) body.push(leaf("comment", comment));
  body.push(node("return_statement", [
    leaf("return", "return", { named: false }),
    leaf("identifier", retIdent),
  ]));
  kids.push(node("statement_block", [
    leaf("{", "{", { named: false }), ...body, leaf("}", "}", { named: false }),
  ], { field: "body" }));
  return node("function_declaration", kids);
}

const H = (n: SynNode) => hashDeclaration(n, n.text, TS);

test("註解不進 token 層：加註解只造成 raw 層變更", () => {
  const a = H(fn("f", "x", "x"));
  const b = H(fn("f", "x", "x", "// why"));
  assert.notEqual(a.hashRaw, b.hashRaw);
  assert.equal(a.hashToken, b.hashToken);
  assert.equal(changeLevel(a, b), "raw");
});

test("區域變數改名只造成 token 層變更", () => {
  const a = H(fn("f", "value", "value"));
  const b = H(fn("f", "v", "v"));
  assert.notEqual(a.hashToken, b.hashToken);
  assert.equal(a.hashAlpha, b.hashAlpha);
  assert.equal(changeLevel(a, b), "token");
});

test("字面量變更落在 alpha 層，shape 不變", () => {
  reset();
  const mk = (lit: string) => node("function_declaration", [
    leaf("identifier", "f", { field: "name" }),
    node("statement_block", [node("return_statement", [leaf("number", lit)])], { field: "body" }),
  ]);
  reset(); const a = H(mk("3"));
  reset(); const b = H(mk("5"));
  assert.notEqual(a.hashAlpha, b.hashAlpha);
  assert.equal(a.hashShape, b.hashShape);
  assert.equal(changeLevel(a, b), "alpha");
});

test("加入 try 區塊造成 shape 層變更", () => {
  reset(); const a = H(fn("f", "x", "x"));
  reset();
  const b = H(node("function_declaration", [
    leaf("identifier", "f", { field: "name" }),
    node("formal_parameters", [
      node("required_parameter", [leaf("identifier", "x", { field: "pattern" })]),
    ], { field: "parameters" }),
    node("statement_block", [
      leaf("{", "{", { named: false }),
      node("try_statement", [
        leaf("try", "try", { named: false }),
        node("statement_block", [
          leaf("{", "{", { named: false }),
          node("return_statement", [
            leaf("return", "return", { named: false }),
            leaf("identifier", "x"),
          ]),
          leaf("}", "}", { named: false }),
        ], { field: "body" }),
      ]),
      leaf("}", "}", { named: false }),
    ], { field: "body" }),
  ]));
  assert.notEqual(a.hashShape, b.hashShape);
  assert.equal(changeLevel(a, b), "shape");
});

test("欄位名進入 shape：condition 與 consequence 互換不得雜湊相同", () => {
  // 這正是保留 field name 的理由。拿掉的話這兩棵樹會判定為結構相同。
  const mk = (aField: string, bField: string) => {
    reset();
    return node("if_statement", [
      node("binary_expression", [leaf("identifier", "p")], { field: aField }),
      node("statement_block", [leaf("identifier", "q")], { field: bField }),
    ]);
  };
  assert.notEqual(sexp(mk("condition", "consequence")), sexp(mk("consequence", "condition")));
  assert.match(sexp(mk("condition", "consequence")), /condition:/);
});

test("S-expression 保留括號：不同的樹不得產生相同序列", () => {
  reset();
  const flat = node("a", [leaf("b", "1"), leaf("c", "2")]);
  reset();
  const nested = node("a", [node("b", [leaf("c", "2")])]);
  assert.notEqual(sexp(flat), sexp(nested));
});

test("匿名節點不進 shape，但仍進 token", () => {
  reset();
  const n = node("call_expression", [
    leaf("identifier", "f"),
    leaf("(", "(", { named: false }),
    leaf(")", ")", { named: false }),
  ]);
  assert.equal(sexp(n), "(call_expression (identifier))");
  assert.equal(tokenStream(n, TS).length, 3);
  assert.equal(countNamedNodes(n), 2);
});

test("屬性名永不正規化：obj.a 與 obj.b 的 alpha 必須不同", () => {
  const mk = (prop: string) => {
    reset();
    return node("function_declaration", [
      leaf("identifier", "f", { field: "name" }),
      node("formal_parameters", [
        node("required_parameter", [leaf("identifier", "obj", { field: "pattern" })]),
      ], { field: "parameters" }),
      node("statement_block", [node("member_expression", [
        leaf("identifier", "obj", { field: "object" }),
        leaf("property_identifier", prop, { field: "property" }),
      ])], { field: "body" }),
    ]);
  };
  assert.notEqual(H(mk("a")).hashAlpha, H(mk("b")).hashAlpha);
});

test("shorthand 屬性名永不正規化：{ userId } 與 { sessionId } 的 alpha 必須不同", () => {
  // 最容易漏掉的一條：shorthand 同時是物件的鍵與區域變數的引用。
  // 正規化會把鍵名一起改掉，讓兩個結構不同的物件雜湊相同。
  const mk = (name: string) => {
    reset();
    return node("function_declaration", [
      leaf("identifier", "f", { field: "name" }),
      node("statement_block", [
        node("lexical_declaration", [
          node("variable_declarator", [leaf("identifier", name, { field: "name" })]),
        ]),
        node("object", [leaf("shorthand_property_identifier", name)]),
      ], { field: "body" }),
    ]);
  };
  assert.notEqual(H(mk("userId")).hashAlpha, H(mk("sessionId")).hashAlpha);
});

test("繫結依首次出現順序編號，順序不同即為不同的 alpha", () => {
  reset();
  const decl = node("function_declaration", [
    leaf("identifier", "f", { field: "name" }),
    node("formal_parameters", [
      node("required_parameter", [leaf("identifier", "a", { field: "pattern" })]),
      node("required_parameter", [leaf("identifier", "b", { field: "pattern" })]),
    ], { field: "parameters" }),
  ]);
  assert.deepEqual(collectBindings(decl, TS), ["a", "b"]);
});

test("解構模式中的名稱算繫結", () => {
  reset();
  const decl = node("function_declaration", [
    leaf("identifier", "f", { field: "name" }),
    node("formal_parameters", [
      node("required_parameter", [
        node("object_pattern", [
          leaf("shorthand_property_identifier_pattern", "camera"),
          leaf("shorthand_property_identifier_pattern", "onClose"),
        ], { field: "pattern" }),
      ]),
    ], { field: "parameters" }),
  ]);
  assert.deepEqual(collectBindings(decl, TS), ["camera", "onClose"]);
});

test("hash_alpha_self 讓純改名可由雜湊相等判定", () => {
  // lin-company-intel-wrapper 暴露了外層宣告名未正規化的方向；這裡用合成的
  // 純改名釘住特徵本身。實際 fixture 同時改了 body，仍應由 L4 接住。
  const a = H(fn("CompanyIntel", "props", "props"));
  const b = H(fn("CompanyIntelInner", "props", "props"));
  assert.notEqual(a.hashAlpha, b.hashAlpha, "alpha 應該不同——宣告名在 token 流裡");
  assert.equal(a.hashAlphaSelf, b.hashAlphaSelf, "alpha_self 應該相同——純改名");
  assert.equal(a.hashShape, b.hashShape);
});

test("改名同時改內容：alpha_self 也必須不同", () => {
  const a = H(fn("Foo", "x", "x"));
  const b = H(fn("Bar", "x", "y"));
  assert.notEqual(a.hashAlphaSelf, b.hashAlphaSelf);
});

test("shapeProfile 不同時不得判定為 alpha 層變更", () => {
  // 跨 grammar 版本的 shape 雜湊不可比較。誤判成 alpha 會讓一次 grammar 升版
  // 看起來像「全 repo 只改了字面量」，那是最糟的一種靜默錯誤。
  const a = H(fn("f", "x", "x"));
  const b = { ...H(fn("f", "x", "y")), shapeProfile: "typescript/0.24.x/sexp-1.0.0" };
  assert.equal(changeLevel(a, b), "shape");
});

test("shapeProfile 不同時，即使所有雜湊相同也一律回報 shape", () => {
  const a = H(fn("f", "x", "x"));
  const b = { ...a, shapeProfile: "typescript/0.24.x/sexp-1.0.0" };
  assert.equal(changeLevel(a, b), "shape");
});

test("完全相同的宣告回報 none", () => {
  assert.equal(changeLevel(H(fn("f", "x", "x")), H(fn("f", "x", "x"))), "none");
});

// ── adapter 自檢 ───────────────────────────────────────────────────────────

test("verifyAdapter 抓得到「只走具名節點」的 adapter 錯誤", async () => {
  const { verifyAdapter } = await import("../src/ast/adapter.ts");
  reset();
  const namedOnly = node("call_expression", [leaf("identifier", "f")]);
  const problems = verifyAdapter(namedOnly, namedOnly.text);
  assert.ok(problems.some((p) => p.includes("匿名節點")));
});

test("verifyAdapter 抓得到位移與文字不符", async () => {
  const { verifyAdapter } = await import("../src/ast/adapter.ts");
  reset();
  const n = node("x", [leaf("identifier", "abc"), leaf("(", "(", { named: false })]);
  assert.equal(verifyAdapter(n, n.text).filter((p) => p.includes("位移")).length, 0);
  assert.ok(verifyAdapter(n, "WRONG SOURCE").some((p) => p.includes("位移")));
});

test("UTF-16 node index 轉成 schema 所需的 UTF-8 byte range", async () => {
  const { utf8ByteRange } = await import("../src/ast/adapter.ts");
  const source = "// 中文 😀\nfunction f() {}";
  const startIndex = source.indexOf("function");
  const text = "function f() {}";
  const decl: SynNode = {
    type: "function_declaration",
    isNamed: true,
    text,
    startIndex,
    endIndex: startIndex + text.length,
    children: [],
  };
  const range = utf8ByteRange(decl, source);
  assert.deepEqual(range, {
    startByte: Buffer.byteLength(source.slice(0, decl.startIndex), "utf8"),
    endByte: Buffer.byteLength(source.slice(0, decl.endIndex), "utf8"),
  });
  assert.notEqual(range.startByte, decl.startIndex, "非 ASCII 前綴下 byte 與 code-unit index 應不同");
});

test("extractDeclarations 只把函式型的 variable_declarator 當宣告", async () => {
  const { extractDeclarations } = await import("../src/ast/adapter.ts");
  reset();
  const mkDeclarator = (name: string, valueType: string) =>
    node("variable_declarator", [
      leaf("identifier", name, { field: "name" }),
      node(valueType, [leaf("identifier", "body")], { field: "value" }),
    ]);
  const root = node("program", [
    node("lexical_declaration", [mkDeclarator("Widget", "arrow_function")]),
    node("lexical_declaration", [mkDeclarator("LIMIT", "number")]),
  ]);
  const names = extractDeclarations(root, TS).map((d) => d.qualifiedName);
  assert.deepEqual(names, ["Widget"], "普通的 const 不該被當成實體");
});

test("類別成員的限定名稱帶類別前綴，與 fixture 的 symbol 欄位對齊", async () => {
  const { extractDeclarations } = await import("../src/ast/adapter.ts");
  reset();
  const root = node("program", [
    node("class_declaration", [
      leaf("identifier", "RequestDispatcher", { field: "name" }),
      node("class_body", [
        node("method_definition", [
          leaf("property_identifier", "handle", { field: "name" }),
          node("statement_block", [leaf("identifier", "q")], { field: "body" }),
        ]),
      ], { field: "body" }),
    ]),
  ]);
  const names = extractDeclarations(root, TS).map((d) => d.qualifiedName);
  assert.deepEqual(names, ["RequestDispatcher", "RequestDispatcher.handle"]);
});
