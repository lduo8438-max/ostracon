import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createRequire } from "node:module";
import { test } from "node:test";
import { utf8ByteRange, verifyAdapter } from "../src/ast/adapter.ts";
import { parseSource, verifyParserAdapters } from "../src/ast/parser.ts";
import {
  tsxProfile,
  TYPESCRIPT_GRAMMAR_VERSION,
  typescriptProfile,
} from "../src/ast/profiles/typescript.ts";

const require = createRequire(import.meta.url);
const installedGrammarVersion =
  (require("tree-sitter-typescript/package.json") as { version: string }).version;

test("profile 使用實際安裝的精確 grammarVersion", () => {
  assert.equal(TYPESCRIPT_GRAMMAR_VERSION, installedGrammarVersion);
  assert.equal(typescriptProfile.grammarVersion, installedGrammarVersion);
  assert.equal(tsxProfile.grammarVersion, installedGrammarVersion);
  assert.notEqual(typescriptProfile.family, tsxProfile.family);
});

test("真實 TypeScript 與 TSX grammar 通過 adapter 啟動閘門", async () => {
  await verifyParserAdapters();
});

test("非 ASCII 前綴下 declaration 可同時還原字串與 UTF-8 byte range", async () => {
  const source = "// 中文 😀\nexport function greet(name: string) { return `你好 ${name}`; }";
  const parsed = await parseSource(source, "typescript");
  assert.deepEqual(verifyAdapter(parsed.root, source), []);
  const decl = parsed.declarations.find((candidate) => candidate.qualifiedName === "greet");
  assert.ok(decl);
  assert.equal(
    source.slice(decl.node.startIndex, decl.node.endIndex),
    decl.node.text,
  );
  assert.deepEqual(utf8ByteRange(decl.node, source), {
    startByte: Buffer.byteLength(source.slice(0, decl.node.startIndex), "utf8"),
    endByte: Buffer.byteLength(source.slice(0, decl.node.endIndex), "utf8"),
  });
});
