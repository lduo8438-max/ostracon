import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { GRAMMARS, grammarForPath, parseSource } from "../src/ast/parser.ts";
import { collectBindings } from "../src/ast/bindings.ts";
import { hashDeclaration } from "../src/ast/hash.ts";
import { PYTHON_GRAMMAR_VERSION, pythonProfile } from "../src/ast/profiles/python.ts";
import { typescriptProfile } from "../src/ast/profiles/typescript.ts";

const require = createRequire(import.meta.url);

/**
 * Python 剖面的驗證。
 *
 * **這份測試存在的理由不是「支援 Python」**，是驗證「加新語言＝新增一份剖面」
 * 這個宣稱成立。它一次就逼出三個藏在語言中立層裡的 TypeScript 假設，
 * 三個都屬於本專案追了整個 W2–W4 的同一型缺陷：**宣稱支援兩種東西，
 * 只驗了其中一種**。
 */

test("python profile 使用實際安裝的精確 grammarVersion", () => {
  const installed = (require("tree-sitter-python/package.json") as { version: string })
    .version;
  assert.equal(PYTHON_GRAMMAR_VERSION, installed);
  assert.equal(pythonProfile.grammarVersion, installed);
});

test("每份剖面的 family 都互異，shape_profile 才隔得開", () => {
  const families = GRAMMARS.map((g) => g.profile.family);
  assert.equal(new Set(families).size, families.length, families.join("、"));
});

test("副檔名對應到正確的 grammar，且認不得的一律不索引", () => {
  assert.equal(grammarForPath("a/b.py"), "python");
  assert.equal(grammarForPath("a/b.ts"), "typescript");
  assert.equal(grammarForPath("a/b.tsx"), "tsx");
  assert.equal(grammarForPath("a/b.PY"), "python");
  // `.pyi` 是型別存根：收它會讓同一個函式在 .py 與 .pyi 各有一個實體。
  assert.equal(grammarForPath("a/b.pyi"), undefined);
  assert.equal(grammarForPath("README.md"), undefined);
  assert.equal(grammarForPath("Makefile"), undefined);
  // 目錄名裡的點不得被當成副檔名。
  assert.equal(grammarForPath("pkg.py/Makefile"), undefined);
});

const parse = async (source: string) => {
  const parsed = await parseSource(source, "python");
  return parsed;
};

const declarationNamed = async (source: string, name: string) => {
  const parsed = await parse(source);
  const found = parsed.declarations.find((d) => d.qualifiedName === name);
  assert.ok(found, `找不到宣告 ${name}，實際有：${parsed.declarations.map((d) => d.qualifiedName).join("、")}`);
  return { ...found, source };
};

const alphaOf = async (source: string, name: string) => {
  const decl = await declarationNamed(source, name);
  return hashDeclaration(decl.node, source, pythonProfile).hashAlpha;
};

test("class 與 def 都抽得到，方法帶類別名前綴", async () => {
  const parsed = await parse(
    "class Cache:\n    def get(self, k):\n        return k\n\ndef helper():\n    pass\n",
  );
  const names = parsed.declarations.map((d) => d.qualifiedName);
  assert.deepEqual(names, ["Cache", "Cache.get", "helper"]);
});

test("模組層級的賦值不是宣告", async () => {
  // TypeScript 要靠 valueBearingDeclarations 把 `const n = 1` 擋掉；
  // Python 根本不把賦值列為宣告，所以那個欄位留 undefined。
  const parsed = await parse("CONST = 1\nfn = lambda x: x\n");
  assert.deepEqual(parsed.declarations, []);
  assert.equal(pythonProfile.valueBearingDeclarations, undefined);
  assert.ok(typescriptProfile.valueBearingDeclarations);
});

/**
 * 以下每一條都是「純改名應該相等」或「改語意應該相異」的成對比對。
 *
 * 這才是剖面正確與否的判準：`collectBindings` 回傳什麼名字是實作細節，
 * 但**同一段程式碼換個區域變數名是不是同一段程式碼**是語意問題。
 */
const RENAME_EQUIVALENT: Array<[string, string, string]> = [
  [
    "參數",
    "def f(a, b):\n    return a + b\n",
    "def f(x, y):\n    return x + y\n",
  ],
  [
    "區域變數",
    "def f():\n    total = 1\n    return total\n",
    "def f():\n    acc = 1\n    return acc\n",
  ],
  [
    "多重指派",
    "def f():\n    a, b = 1, 2\n    return a + b\n",
    "def f():\n    p, q = 1, 2\n    return p + q\n",
  ],
  [
    "for 迴圈變數",
    "def f(xs):\n    for item in xs:\n        print(item)\n",
    "def f(xs):\n    for row in xs:\n        print(row)\n",
  ],
  [
    "生成式變數",
    "def f(xs):\n    return [v * 2 for v in xs]\n",
    "def f(xs):\n    return [w * 2 for w in xs]\n",
  ],
  [
    "with ... as",
    "def f(p):\n    with open(p) as fh:\n        return fh.read()\n",
    "def f(p):\n    with open(p) as handle:\n        return handle.read()\n",
  ],
  [
    "except ... as",
    "def f():\n    try:\n        g()\n    except ValueError as err:\n        print(err)\n",
    "def f():\n    try:\n        g()\n    except ValueError as exc:\n        print(exc)\n",
  ],
  [
    "lambda 參數",
    "def f():\n    return lambda q: q + 1\n",
    "def f():\n    return lambda r: r + 1\n",
  ],
  [
    "*args / **kwargs",
    "def f(*args, **kwargs):\n    return g(args, kwargs)\n",
    "def f(*items, **opts):\n    return g(items, opts)\n",
  ],
  [
    "有預設值的參數",
    "def f(timeout=3):\n    return timeout\n",
    "def f(delay=3):\n    return delay\n",
  ],
  [
    "有型別註記的參數",
    "def f(url: str) -> str:\n    return url\n",
    "def f(target: str) -> str:\n    return target\n",
  ],
  [
    "巢狀函式",
    "def f():\n    def inner(z):\n        return z\n    return inner\n",
    "def f():\n    def nested(z):\n        return z\n    return nested\n",
  ],
  [
    "海象運算子",
    "def f(g):\n    if (n := g()) > 0:\n        return n\n",
    "def f(g):\n    if (m := g()) > 0:\n        return m\n",
  ],
];

for (const [label, left, right] of RENAME_EQUIVALENT) {
  test(`純改名不改語意：${label}`, async () => {
    assert.equal(await alphaOf(left, "f"), await alphaOf(right, "f"));
  });
}

/**
 * 反方向。這些是**過度正規化**會踩到的地雷：兩段語意不同的程式碼被判成相同，
 * `change_level` 會把真的改動報成「沒有改動」。
 *
 * 前兩條正是驅動 `preservedFields` 與 `BindingRule.directOnly` 存在的原因；
 * 少了任一個，對應那一條就會失敗。
 */
const SEMANTIC_DIFFERENT: Array<[string, string, string]> = [
  [
    "屬性名（preservedFields）",
    "def f(self):\n    self._data = 1\n    return self._data\n",
    "def f(self):\n    self._cache = 1\n    return self._cache\n",
  ],
  [
    "型別註記（directOnly）",
    "def f(x: int) -> int:\n    return x\n",
    "def f(x: str) -> str:\n    return x\n",
  ],
  [
    "關鍵字引數名",
    "def f(g):\n    return g(timeout=3)\n",
    "def f(g):\n    return g(retries=3)\n",
  ],
  [
    "被呼叫的函式名",
    "def f():\n    return connect()\n",
    "def f():\n    return disconnect()\n",
  ],
  [
    "字面值",
    "def f():\n    return 1\n",
    "def f():\n    return 2\n",
  ],
];

for (const [label, left, right] of SEMANTIC_DIFFERENT) {
  test(`語意改變必須看得見：${label}`, async () => {
    assert.notEqual(await alphaOf(left, "f"), await alphaOf(right, "f"));
  });
}

test("宣告自身改名由 hash_alpha_self 吸收，hash_alpha 不吸收", async () => {
  const one = await declarationNamed("def f(a):\n    return a\n", "f");
  const two = await declarationNamed("def g(a):\n    return a\n", "g");
  const h1 = hashDeclaration(one.node, one.source, pythonProfile);
  const h2 = hashDeclaration(two.node, two.source, pythonProfile);
  assert.notEqual(h1.hashAlpha, h2.hashAlpha);
  assert.equal(h1.hashAlphaSelf, h2.hashAlphaSelf);
});

test("繫結清單不含型別名與屬性名", async () => {
  const decl = await declarationNamed(
    "def f(self, url: str, timeout: int = 3):\n" +
      "    self._url = url\n" +
      "    return call(url, timeout=timeout)\n",
    "f",
  );
  const bound = collectBindings(decl.node, pythonProfile);
  assert.deepEqual(bound, ["self", "url", "timeout"]);
});

/**
 * **已知限制，刻意用測試釘住而不是修掉。**
 *
 * 裝飾器不在實體範圍內：`decorated_definition` 是包裝節點，實體的邊界落在裡面
 * 的 `function_definition` 上。於是 `@property` 改成 `@cached_property`
 * 四層雜湊全部看不到。
 *
 * 修它要移動實體邊界，而實體邊界進 `stable_key`——那是一次全量重建，必須另外
 * 提版本並附前後指標。這條測試的作用是：**有人哪天改了邊界，這裡會紅**，
 * 而不是讓限制默默地變成「已經修好了吧」。
 */
test("已知限制：裝飾器的改動目前看不見", async () => {
  const before = "class C:\n    @property\n    def size(self):\n        return 1\n";
  const after = "class C:\n    @cached_property\n    def size(self):\n        return 1\n";
  const a = await declarationNamed(before, "C.size");
  const b = await declarationNamed(after, "C.size");
  assert.equal(
    hashDeclaration(a.node, before, pythonProfile).hashRaw,
    hashDeclaration(b.node, after, pythonProfile).hashRaw,
  );
  // 但整個類別是看得見的——裝飾器落在 class 的實體範圍內。
  const ca = await declarationNamed(before, "C");
  const cb = await declarationNamed(after, "C");
  assert.notEqual(
    hashDeclaration(ca.node, before, pythonProfile).hashRaw,
    hashDeclaration(cb.node, after, pythonProfile).hashRaw,
  );
});

/**
 * 同上：docstring 不是註解節點，所以它進 token 層；TypeScript 的 JSDoc 是
 * `comment`，被 token 層丟掉。**同一個動作在兩個語言被分到不同的 change_level。**
 */
test("已知不對稱：docstring 進 token 層，JSDoc 不進", async () => {
  const one = "def f():\n    \"\"\"舊說明\"\"\"\n    return 1\n";
  const two = "def f():\n    \"\"\"新說明\"\"\"\n    return 1\n";
  const a = await declarationNamed(one, "f");
  const b = await declarationNamed(two, "f");
  assert.notEqual(
    hashDeclaration(a.node, one, pythonProfile).hashToken,
    hashDeclaration(b.node, two, pythonProfile).hashToken,
  );

  const tsOne = "function f() {\n  /** 舊說明 */\n  return 1;\n}";
  const tsTwo = "function f() {\n  /** 新說明 */\n  return 1;\n}";
  const tsA = await parseSource(tsOne, "typescript");
  const tsB = await parseSource(tsTwo, "typescript");
  assert.equal(
    hashDeclaration(tsA.declarations[0]!.node, tsOne, typescriptProfile).hashToken,
    hashDeclaration(tsB.declarations[0]!.node, tsTwo, typescriptProfile).hashToken,
  );
});
