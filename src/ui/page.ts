/**
 * 三欄 UI 的整個前端：HTML + CSS + JS，一個字串。
 *
 * **沒有建置流程，沒有新相依。** 寫成 TypeScript 模組而不是獨立的 .html 檔，
 * 是為了讓 `tsc` 直接把它帶進 `dist`——`package.json` 的 `files` 白名單只有
 * `dist`，額外的資產檔要另外接一套複製步驟，那就是安裝摩擦的開始。
 *
 * 設計方向由一個實測事實決定：**理由是稀有的**（Osiris 4%、create-t3-app
 * 約 17% 的 commit 說得出為什麼）。所以意圖欄替**每一次**改動保留一格，
 * 沒有證據的就留白——捲動時直接看見「為什麼」有多稀薄。把空格填滿或摺疊掉
 * 都是對資料說謊。
 *
 * 另外兩個刻意的選擇：
 *
 * - **整個介面是等寬字，只有逐字引文用比例字體並放大。** 路徑、符號、sha、
 *   tier 都是機器座標；引文是人說的話。排版的分野就是認識論的分野。
 * - **版面上唯一的暖色只給引文。** 其餘一律冷灰。看到赭色就是看到有人真的
 *   寫下了那句話，不是系統推論出來的。
 */
export const PAGE = `<!doctype html>
<html lang="zh-Hant">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ostracon</title>
<style>
:root {
  /* 冷灰，不是米白——陶片的聯想很誘人，但那正是所有「考古風」都會做的事。 */
  --ground: #eceff1;
  --surface: #ffffff;
  --ink: #16191d;
  --muted: #6a7279;
  --rule: #d4d9dd;
  --rule-strong: #aeb6bc;
  /* 唯一的暖色，只給逐字引文。 */
  --voice: #8a5116;
  --voice-ground: #fbf4ea;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  --prose: ui-sans-serif, system-ui, "Helvetica Neue", Arial, sans-serif;
}
* { box-sizing: border-box; }
html, body { height: 100%; }
body {
  margin: 0;
  background: var(--ground);
  color: var(--ink);
  font: 12px/1.5 var(--mono);
  -webkit-font-smoothing: antialiased;
  /* 直欄 flex 而不是替 main 算 calc(100% - 41px)：標頭上方可能多出一條
     說明帶，寫死的高度會讓三欄整個被推出視窗底下。 */
  display: flex; flex-direction: column;
}
header {
  display: flex; align-items: baseline; gap: 16px; flex-wrap: wrap;
  padding: 10px 16px; border-bottom: 1px solid var(--rule-strong);
  background: var(--surface);
}
header h1 {
  margin: 0; font-size: 12px; font-weight: 700;
  letter-spacing: .22em; text-transform: uppercase;
}
header .repo { color: var(--muted); overflow: hidden; text-overflow: ellipsis; }
/* 稀疏度是頭條數字，不是腳註。 */
header .density { margin-left: auto; color: var(--muted); }
header .density b { color: var(--ink); font-weight: 700; }

main {
  display: grid; grid-template-columns: 22rem 1fr 24rem;
  flex: 1; min-height: 0;
}
/* 無法歸因的聚合證據。**空白必須有解釋**，否則會被讀成「沒有人寫理由」。 */
.aggregate {
  margin: 0; padding: 8px 16px;
  border-bottom: 1px solid var(--rule-strong);
  background: var(--voice-ground); color: var(--voice);
}
section { overflow: auto; border-right: 1px solid var(--rule); background: var(--surface); }
section:last-child { border-right: 0; background: var(--ground); }
h2 {
  position: sticky; top: 0; z-index: 1; margin: 0;
  padding: 8px 14px; background: var(--surface);
  border-bottom: 1px solid var(--rule);
  font-size: 10px; font-weight: 700; letter-spacing: .2em; text-transform: uppercase;
  color: var(--muted);
}
section:last-child h2 { background: var(--ground); }
h2 span { float: right; letter-spacing: 0; text-transform: none; font-weight: 400; }

#filter {
  width: 100%; border: 0; border-bottom: 1px solid var(--rule);
  padding: 9px 14px; font: inherit; background: var(--surface); color: inherit;
}
#filter:focus { outline: 2px solid var(--ink); outline-offset: -2px; }

.entity {
  display: block; width: 100%; text-align: left; cursor: pointer;
  border: 0; border-bottom: 1px solid var(--rule); background: none;
  padding: 8px 14px; font: inherit; color: inherit;
}
.entity:hover { background: var(--ground); }
.entity[aria-current="true"] { background: var(--ink); color: var(--surface); }
.entity[aria-current="true"] .path,
.entity[aria-current="true"] .meta { color: #b9c1c8; }
.entity .symbol { font-weight: 700; }
.entity .path, .entity .meta { color: var(--muted); font-size: 11px; }
.tabs { display: flex; border-bottom: 1px solid var(--rule); }
.tab {
  flex: 1; border: 0; background: none; cursor: pointer; font: inherit;
  padding: 7px 10px; color: var(--muted);
  border-bottom: 2px solid transparent;
}
.tab[aria-selected="true"] { color: var(--ink); border-bottom-color: var(--ink); }
/* 已消亡：左邊界與時間軸的 death 同一個粗細，兩邊講的是同一件事。 */
.entity.gone { border-left: 4px solid var(--ink); padding-left: 10px; }
.entity .days { font-weight: 700; color: var(--ink); }
.note-line { padding: 8px 14px; color: var(--muted); border-bottom: 1px solid var(--rule); }
.entity .meta { display: flex; gap: 10px; margin-top: 2px; }

/* 改動的層級由左邊界的粗細表達——那是四層雜湊階梯的裁決，不是裝飾。 */
.rev { display: grid; grid-template-columns: 1fr; gap: 2px;
  padding: 9px 14px 9px 12px; border-bottom: 1px solid var(--rule);
  border-left: 2px solid var(--rule); }
.rev[data-level="alpha"] { border-left-color: var(--rule-strong); }
.rev[data-level="shape"], .rev[data-level="birth"], .rev[data-level="death"] {
  border-left: 4px solid var(--ink); padding-left: 10px;
}
.rev .line1 { display: flex; gap: 10px; align-items: baseline; }
.rev .sha { font-weight: 700; }
.rev .when, .rev .where, .rev .tier { color: var(--muted); }
.rev .tier { margin-left: auto; }
.rev .subject { color: var(--muted); overflow-wrap: anywhere; }
.rev .rename { color: var(--ink); }

/* 意圖欄：每一次改動一格，**沒有證據的留白**。 */
.slot { border-bottom: 1px solid var(--rule); padding: 9px 14px; }
.slot.empty { min-height: 34px; }
.slot.empty::after {
  content: ""; display: block; height: 1px; width: 28px; background: var(--rule-strong);
}
.claim { margin: 0 0 8px; }
.claim:last-child { margin-bottom: 0; }
.claim .type {
  font-size: 10px; letter-spacing: .16em; text-transform: uppercase;
  color: var(--muted);
}
.claim .type b { color: var(--ink); font-weight: 700; }
/* 引文：唯一的比例字體，唯一的暖色。 */
.claim q {
  display: block; margin-top: 3px; padding: 7px 9px;
  background: var(--voice-ground); border-left: 2px solid var(--voice);
  color: var(--voice); font: 400 14px/1.45 var(--prose); quotes: "「" "」";
  overflow-wrap: anywhere;
}
.claim .prov { color: var(--muted); font-size: 10px; margin-top: 3px; }
/* 整批理由降一階：**唯一的暖色只留給專屬引文**，否則色彩本身就在誇大。 */
.claim.batch q {
  background: var(--surface); border-left-color: var(--rule-strong);
  color: var(--muted);
}
.claim .tag {
  margin-left: 8px; padding: 1px 5px; border: 1px solid var(--rule-strong);
  border-radius: 2px; letter-spacing: 0; text-transform: none; font-size: 10px;
}

.hint { padding: 14px; color: var(--muted); }
.hint b { color: var(--ink); }
@media (max-width: 900px) {
  main { grid-template-columns: 1fr; height: auto; }
  section { max-height: 60vh; border-right: 0; border-bottom: 1px solid var(--rule-strong); }
}
@media (prefers-reduced-motion: no-preference) {
  .entity, .slot { transition: background-color 90ms linear; }
}
</style>

<header>
  <h1>Ostracon</h1>
  <span class="repo" id="repo"></span>
  <span class="density" id="density"></span>
</header>
<p class="aggregate" id="aggregate" hidden></p>

<main>
  <section aria-label="結構">
    <h2><span id="list-title">結構</span> <span id="entity-count"></span></h2>
    <div class="tabs" role="tablist">
      <button id="tab-live" class="tab" role="tab" aria-selected="true">全部宣告</button>
      <button id="tab-gone" class="tab" role="tab" aria-selected="false">被推翻的做法</button>
    </div>
    <input id="filter" type="search" placeholder="篩選路徑或符號" autocomplete="off">
    <div id="entities"></div>
  </section>
  <section aria-label="演化">
    <h2>演化 <span id="evolution-count"></span></h2>
    <div id="evolution"></div>
  </section>
  <section aria-label="意圖">
    <h2>意圖 <span id="intent-count"></span></h2>
    <div id="intent"></div>
  </section>
</main>

<script>
const $ = (id) => document.getElementById(id);
const text = (value) => {
  const node = document.createElement("span");
  node.textContent = value;
  return node.innerHTML;
};
const LEVEL = {
  birth: "誕生", death: "消亡", none: "無變更", raw: "格式／註解",
  token: "區域改名", alpha: "字面量或呼叫目標", shape: "結構重構",
};
const TYPE = {
  why: "理由",
  constraint: "約束",
  tradeoff: "被拒絕的替代方案",
  abandoned_reason: "放棄理由",
};

const EMPTY_EVOLUTION = '<p class="hint">從左邊挑一個宣告。</p>';
const EMPTY_INTENT =
  '<p class="hint">意圖只在原文說得出來時才有。<b>空白是真實的觀測值</b>，不是還沒載入。</p>';

let entities = [];
let ostracised = { rows: [], hiddenTests: 0 };
let tab = "live";
let current = null;

async function boot() {
  const summary = await (await fetch("./api/summary.json")).json();
  $("repo").textContent = summary.rootPath;
  const pct = summary.changes === 0
    ? 0 : (summary.changesWithEntityIntent / summary.changes) * 100;
  // 稀疏度講在最上面，而且**專屬理由與整批理由分開數**。合起來會誇大一個
  // 數量級：實測 vuejs/core 是 34 對 508。
  $("density").innerHTML =
    \`<b>\${summary.changesWithEntityIntent}</b> / \${summary.changes} 次改動有專屬理由\`
    + \`（\${pct.toFixed(1)}%）\`
    + (summary.changesWithBatchIntent > 0
      ? \`　另有 \${summary.changesWithBatchIntent} 次只有整批理由\`
      : "")
    + (summary.untouched > 0
      ? \`　時間軸另列出 \${summary.untouched} 次「檔案動了但這裡沒動」\`
      : "");
  // **抑制不能靜默。** 沒有這一行，使用者會把大片空白讀成「這個團隊不寫理由」，
  // 而實情是理由寫了、squash 把它跟改動的對應關係銷毀了。
  if (summary.aggregate.quotes > 0) {
    $("aggregate").textContent =
      \`另有 \${summary.aggregate.quotes} 條引文來自 \${summary.aggregate.commits} 顆聚合 commit\`
      + \`（squash 合併了多個 PR），會影響 \${summary.aggregate.candidates} 次改動。\`
      + \`證據仍在，但無法歸因到單一改動，因此意圖欄留白。\`;
    $("aggregate").hidden = false;
  }

  clearSelection();
  entities = await (await fetch("./api/entities.json")).json();
  // 被推翻的做法與 landing 的頭條數字**來自同一份 JSON**，畫面不自己數。
  ostracised = await (await fetch("./api/ostracised.json")).json();
  renderEntities("");
}

/** 目前這一頁在看哪一份名單。兩份名單的列都連到同一個時間軸端點。 */
function currentList() {
  return tab === "gone" ? ostracised.rows : entities;
}

function renderEntities(query) {
  const q = query.trim().toLowerCase();
  const all = currentList();
  const shown = q === ""
    ? all
    : all.filter((e) => (e.path + ":" + e.symbol).toLowerCase().includes(q));
  $("list-title").textContent = tab === "gone" ? "被推翻的做法" : "宣告";
  $("entity-count").textContent = all.length + " 個";
  if (tab === "gone") {
    // **排除不得靜默**，而且這行的數字與 CLI 是同一個 predicate 算出來的。
    // **排除不得靜默**，而且這兩個數字與 CLI 是同一個 predicate 算出來的。
    // C 級是「僅生命週期符合、未經證實」，不進清單也不進頭條。
    const aside = [
      ostracised.hiddenTests > 0
        ? \`另有 \${ostracised.hiddenTests} 條在測試檔裡（測試骨架，不是被推翻的做法）\`
        : "",
      ostracised.suspected > 0
        ? \`另有 \${ostracised.suspected} 條 C 級疑似，未經證實，不列入\`
        : "",
    ].filter(Boolean).join("；");
    const note = aside === ""
      ? ""
      : \`<div class="note-line">\${aside}</div>\`;
    $("entities").innerHTML = note + shown.map((r) => \`
      <button class="entity gone" data-id="\${r.stableKey}"
              aria-current="\${r.stableKey === current}">
        <div class="symbol">\${text(r.symbol)}</div>
        <div class="path">\${text(r.path)}</div>
        <div class="meta"><span><span class="days">\${r.durationDays.toFixed(0)}</span> 天</span><span>A 確證</span></div>
        <div class="path">\${text(r.diedSubject)}</div>
      </button>\`).join("");
    return;
  }
  $("entities").innerHTML = shown.map((e) => \`
    <button class="entity\${e.dead ? " gone" : ""}" data-id="\${e.stableKey}"
            aria-current="\${e.stableKey === current}">
      <div class="symbol">\${text(e.symbol)}</div>
      <div class="path">\${text(e.path)}</div>
      <div class="meta"><span>\${e.dead ? "已消亡 · " : ""}\${e.revisions} 次改動\${
        e.untouched > 0 ? " · " + e.untouched + " 次未動" : ""
      }</span><span>\${
        e.withEntityIntent > 0
          ? e.withEntityIntent + " 次有專屬理由"
          : e.withBatchIntent > 0
            ? e.withBatchIntent + " 次只有整批理由"
            : "沒有理由可查"
      }</span></div>
    </button>\`).join("");
}

/** 回到「還沒挑」的狀態。初始提示與這裡只有一份文字，不會分岔。 */
function clearSelection() {
  current = null;
  $("evolution").innerHTML = EMPTY_EVOLUTION;
  $("intent").innerHTML = EMPTY_INTENT;
  $("evolution-count").textContent = "";
  $("intent-count").textContent = "";
}

async function select(stableKey) {
  current = stableKey;
  renderEntities($("filter").value);
  // 對外身分一律是 stable_key：rowid 會隨全量重建漂移，而舊網址在重建後
  // 可能**成功回傳另一個 entity**——那比 404 難發現得多。
  const rows = await (await fetch("./api/evolution/" + stableKey + ".json")).json();
  // 「幾次」要與結構欄用同一個定義，否則同一個宣告在兩欄顯示兩個數字。
  const changed = rows.filter((r) => r.changeLevel !== "none").length;
  $("evolution-count").textContent = changed + " 次改動"
    + (rows.length > changed ? "　共 " + rows.length + " 列" : "");
  const entityLevel = rows.filter(
    (r) => r.intent.some((c) => c.scope === "entity"),
  ).length;
  const batchOnly = rows.filter(
    (r) => r.intent.length > 0 && r.intent.every((c) => c.scope === "batch"),
  ).length;
  $("intent-count").textContent = entityLevel + " / " + rows.length
    + (batchOnly > 0 ? "（另 " + batchOnly + " 整批）" : "");

  $("evolution").innerHTML = rows.map((r) => \`
    <div class="rev" data-level="\${text(r.changeLevel)}">
      <div class="line1">
        <span class="sha">\${text(r.shortSha)}</span>
        <span class="when">\${text(r.committedAt.slice(0, 10))}</span>
        <span class="where">\${LEVEL[r.changeLevel] ?? text(r.changeLevel)}</span>
        <span class="tier">\${r.tier ? text(r.tier) : ""}\${
          r.ambiguitySize > 1 ? "，" + r.ambiguitySize + " 個等價候選" : ""
        }</span>
      </div>
      <div class="subject">\${text(r.subject)}</div>
      <div class="where">\${text(r.path)}:\${r.lineStart}-\${r.lineEnd}</div>
    </div>\`).join("");

  // 意圖欄逐列對齊演化欄：**每一次改動都有一格**，沒有證據的留白。
  $("intent").innerHTML = rows.map((r) => r.intent.length === 0
    ? '<div class="slot empty"></div>'
    : \`<div class="slot">\${r.intent.map((c) => \`
        <div class="claim\${c.scope === "batch" ? " batch" : ""}">
          <div class="type"><b>\${TYPE[c.claimType] ?? text(c.claimType)}</b>\${
            c.scope === "batch"
              ? '<span class="tag">整批 · 同時歸給 ' + c.affectedEntities + " 次改動</span>"
              : ""
          }</div>
          <q>\${text(c.text)}</q>
          <div class="prov">\${
            c.scope === "batch"
              ? "這句話是在講這次 commit 的整批改動，不是專講這個宣告"
              : c.tier === "stated"
                ? "作者在這次 commit 的訊息裡寫的"
                : "來自被參照的討論串，關聯可信度 " + c.confidence
          }</div>
        </div>\`).join("")}</div>\`).join("");

  // 兩欄的列高必須相同，否則對齊就是假的。逐列量測後補齊。
  requestAnimationFrame(alignRows);
}

/**
 * 讓意圖欄的第 n 格與演化欄的第 n 列等高。
 *
 * 用 CSS grid 對齊需要兩欄在同一個 grid 裡，那會犧牲各自捲動。逐列量測比較笨，
 * 但它保證「這條理由屬於這次改動」在視覺上是真的——對齊錯了就是把 A 的理由
 * 印在 B 底下，而那是這個工具最不能犯的錯。
 */
function alignRows() {
  const revs = [...$("evolution").children];
  const slots = [...$("intent").children];
  if (revs.length !== slots.length) return;
  for (let i = 0; i < revs.length; i++) {
    revs[i].style.minHeight = "";
    slots[i].style.minHeight = "";
  }
  for (let i = 0; i < revs.length; i++) {
    // offsetHeight 會把子像素捨入成整數；長時間軸會把每列的小誤差累積成
    // 看得見的錯位。實際渲染高度保留小數，才能讓第 n 列的上下界都吻合。
    const tallest = Math.max(
      revs[i].getBoundingClientRect().height,
      slots[i].getBoundingClientRect().height,
    );
    revs[i].style.minHeight = tallest + "px";
    slots[i].style.minHeight = tallest + "px";
  }
}

$("entities").addEventListener("click", (event) => {
  const button = event.target.closest(".entity");
  if (button) select(button.dataset.id);
});
$("filter").addEventListener("input", (event) => renderEntities(event.target.value));
for (const [id, which] of [["tab-live", "live"], ["tab-gone", "gone"]]) {
  $(id).addEventListener("click", () => {
    tab = which;
    $("tab-live").setAttribute("aria-selected", String(which === "live"));
    $("tab-gone").setAttribute("aria-selected", String(which === "gone"));
    $("filter").value = "";
    // 切換時清掉選取。留著的話右邊還是上一個宣告的時間軸，左邊卻可能沒有
    // 任何 aria-current 列——畫面看起來像右側資料失去來源。
    // （兩份名單**不是**互斥的：「被推翻的做法」是「全部宣告」的子集。）
    clearSelection();
    renderEntities("");
  });
}
// 兩欄各自捲動會讓對齊在視覺上斷掉，所以**雙向**同步。只有一個方向的話，
// 滑鼠停在意圖欄捲動時仍會立刻拆開；Chrome 實測第一版正是這個 bug。
const evolutionPane = $("evolution").parentElement;
const intentPane = $("intent").parentElement;
const mirrorScroll = (source, target) => {
  if (target.scrollTop !== source.scrollTop) target.scrollTop = source.scrollTop;
};
evolutionPane.addEventListener("scroll", () => mirrorScroll(evolutionPane, intentPane));
intentPane.addEventListener("scroll", () => mirrorScroll(intentPane, evolutionPane));
addEventListener("resize", alignRows);
boot();
</script>
`;
