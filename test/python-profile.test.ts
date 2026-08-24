import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { GRAMMARS, grammarForPath, parseSource } from "../src/ast/parser.ts";
import { collectBindings } from "../src/ast/bindings.ts";
import { hashDeclaration } from "../src/ast/hash.ts";
import { PYTHON_GRAMMAR_VERSION, pythonProfile } from "../src/ast/profiles/python.ts";
import { typescriptProfile } from "../src/ast/profiles/typescript.ts";
import { declarationIndexerVersion } from "../src/index/repo-pass.ts";
import { isTestPath } from "../src/cli/ostracised.ts";

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

/**
 * 剖面決定「哪個節點是宣告」與「哪個名字是繫結」，兩者都是雜湊的輸入，
 * 所以它必須在**水位線**裡（不變量 7）。少了它有兩個靜默錯誤：加一種語言之後
 * 舊資料庫會續跑、只有水位線之後的 commit 拿得到新語言；移動實體邊界之後續跑，
 * 新舊 `stable_key` 混在同一個資料庫裡。
 *
 * `shape_profile` 擋不住這兩件事——同一趟 pass 的兩側都是用當下的剖面現場觀察的。
 */
test("剖面版本進得了 declarations pass 的水位線", () => {
  const version = declarationIndexerVersion("walk-x", "repo");
  for (const g of GRAMMARS) {
    assert.ok(
      version.includes(`${g.profile.family}@${g.profile.profileVersion}`),
      `${g.profile.family} 的剖面版本沒有進版本字串：${version}`,
    );
  }
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
 * 裝飾器在實體邊界內（剖面 1.1.0）。
 *
 * 在此之前 `decorated_definition` 是包裝節點、實體落在裡面的 `function_definition`
 * 上，於是 `@property` 改成 `@cached_property` 四層雜湊全部看不見——而
 * psf/requests 在 HEAD 有 17.0% 的宣告帶裝飾器。
 */
test("裝飾器的改動看得見", async () => {
  const before = "class C:\n    @property\n    def size(self):\n        return 1\n";
  const after = "class C:\n    @cached_property\n    def size(self):\n        return 1\n";
  const a = await declarationNamed(before, "C.size");
  const b = await declarationNamed(after, "C.size");
  assert.notEqual(
    hashDeclaration(a.node, before, pythonProfile).hashRaw,
    hashDeclaration(b.node, after, pythonProfile).hashRaw,
  );
});

test("包裝節點不會讓同一個宣告被抽兩次", async () => {
  const parsed = await parse(
    "class C:\n" +
      "    @property\n" +
      "    def size(self):\n" +
      "        return 1\n" +
      "\n" +
      "@decorate\n" +
      "class D:\n" +
      "    @staticmethod\n" +
      "    def make():\n" +
      "        return D()\n",
  );
  // 沒有 `C.size.size`，也沒有漏掉被裝飾的類別自己的方法。
  assert.deepEqual(
    parsed.declarations.map((d) => d.qualifiedName),
    ["C", "C.size", "D", "D.make"],
  );
  // kind 取被包裝的宣告，不是 `decorated_definition`——帶不帶裝飾器
  // 是同一種東西，`kind` 分岔會讓 L3b 的同 kind 條件在兩者之間失效。
  assert.deepEqual(
    parsed.declarations.map((d) => d.kind),
    ["class_definition", "function_definition", "class_definition", "function_definition"],
  );
});

/**
 * **上面那條「宣告自身改名由 hash_alpha_self 吸收」用的是沒有裝飾器的 `def f`。**
 * 剖面 1.1.0 把實體節點換成包裝節點之後，`function_definition` 降成子節點，
 * `bindings.ts` 的根判定漏掉了它，於是繫結規則命中、宣告自己的名字被收成
 * 區域繫結——實測 psf/requests HEAD 有 137 個帶裝飾器的宣告（807 之中的 17.0%）
 * 因此 `hash_alpha === hash_alpha_self`，正是那段註解說要避免的狀態。
 *
 * 後果不是配錯而是分級錯：帶裝飾器的宣告單純改名會被報成 `token`
 * （「只改局部變數名」），而且 L3b 對它們永遠不觸發。
 *
 * **兩條一起放，因為問題就出在兩種輸入只驗了一種。**
 */
for (
  const [label, wrap] of [
    ["沒有裝飾器", (body: string) => body],
    ["帶裝飾器", (body: string) => `@staticmethod\n${body}`],
  ] as const
) {
  test(`宣告自身的名稱不得被 hash_alpha 吸收：${label}`, async () => {
    const body = (name: string) => `def ${name}(a, b):\n    total = a + b\n    return total\n`;
    const one = await declarationNamed(wrap(body("alpha")), "alpha");
    const two = await declarationNamed(wrap(body("beta")), "beta");
    const h1 = hashDeclaration(one.node, one.source, pythonProfile);
    const h2 = hashDeclaration(two.node, two.source, pythonProfile);
    // 純改名：alpha 必須看得見，alpha_self 必須吸收掉。
    assert.notEqual(h1.hashAlpha, h2.hashAlpha, "hash_alpha 把宣告自身的名字吸收掉了");
    assert.equal(h1.hashAlphaSelf, h2.hashAlphaSelf);
    // 兩者相等就代表 alpha_self 沒有多做任何事，L3b 與 L3 再也分不開。
    assert.notEqual(h1.hashAlpha, h1.hashAlphaSelf);
  });
}

test("實體範圍從裝飾器開始，不是從 def 開始", async () => {
  const source = "class C:\n    @property\n    def size(self):\n        return 1\n";
  const decl = await declarationNamed(source, "C.size");
  assert.ok(
    source.slice(decl.node.startIndex, decl.node.endIndex).startsWith("@property"),
    source.slice(decl.node.startIndex, decl.node.endIndex),
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

/**
 * 測試檔的檔名慣例是語言的一部分，目錄慣例不是。實測：psf/requests 的 205 條
 * `.py` 路徑裡，只認 JS/TS 慣例時命中 25 條，補上 Python 慣例後 30 條——
 * 根目錄的 `test_requests.py` 原本整份出現在「被推翻的做法」清單裡。
 */
test("測試檔判準認得 Python 慣例，也沒有放寬 TypeScript 那一側", () => {
  // Python 慣例
  assert.equal(isTestPath("test_requests.py"), true);
  assert.equal(isTestPath("requests/test_utils.py"), true);
  assert.equal(isTestPath("models_test.py"), true);
  // 設定不是測試：conftest 裡的 fixture 被推翻是值得看見的決定
  assert.equal(isTestPath("conftest.py"), false);
  // 不得誤傷正常模組
  assert.equal(isTestPath("requests/models.py"), false);
  assert.equal(isTestPath("requests/latest.py"), false);
  assert.equal(isTestPath("requests/contest.py"), false);
  assert.equal(isTestPath("src/protest/x.py"), false);
  // TypeScript 那一側行為不變
  assert.equal(isTestPath("packages/a/__tests__/x.spec.ts"), true);
  assert.equal(isTestPath("src/x.test.ts"), true);
  assert.equal(isTestPath("e2e/flow.ts"), true);
  assert.equal(isTestPath("src/latest.ts"), false);
  // Python 的檔名慣例不得外溢到別的語言
  assert.equal(isTestPath("src/test_helper.ts"), false);
  // 目錄慣例跨語言通用
  assert.equal(isTestPath("tests/anything.py"), true);
  // 認不得的副檔名沒有檔名規則可套
  assert.equal(isTestPath("test_notes.md"), false);
});
