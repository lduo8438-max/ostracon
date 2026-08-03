import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createRetryingFetcher,
  describeRetry,
  type RetryEvent,
} from "../src/http/retry.ts";
import type { HttpFetcher, HttpResponse } from "../src/http/types.ts";

const ok = (body = "{}"): HttpResponse => ({ status: 200, headers: {}, body });
const status = (code: number): HttpResponse => ({ status: code, headers: {}, body: "" });

/** 測試一律注入假的 sleep：真的等 1+2+4+8 秒會讓測試套件變成 15 秒。 */
function harness(responses: Array<HttpResponse | Error>) {
  const urls: string[] = [];
  const slept: number[] = [];
  const events: RetryEvent[] = [];
  let i = 0;
  const inner: HttpFetcher = async (url) => {
    urls.push(url);
    const next = responses[Math.min(i++, responses.length - 1)]!;
    if (next instanceof Error) throw next;
    return next;
  };
  const fetcher = createRetryingFetcher(inner, {
    baseDelayMs: 10,
    sleep: async (ms) => { slept.push(ms); },
    onRetry: (e) => events.push(e),
  });
  return { fetcher, urls, slept, events, calls: () => i };
}

describe("暫時性失敗的重試", () => {
  it("網路錯誤後重試，成功就回傳", async () => {
    const h = harness([new Error("fetch failed"), new Error("ECONNRESET"), ok('{"n":1}')]);
    const response = await h.fetcher("https://api.github.com/x");
    assert.equal(response.status, 200);
    assert.equal(h.calls(), 3, "前兩次失敗、第三次成功");
    assert.deepEqual(h.slept, [10, 20], "退避必須是指數的");
  });

  it("**429 不得被重試**——rate limit 由呼叫端優雅處理", async () => {
    // 呼叫端讀 x-ratelimit-reset、保住水位線、讓人稍後續跑。在這裡用幾秒的
    // 退避去重試，等於把「暫停，稍後再來」變成盲目敲門，而 reset 可能在一小時後。
    const h = harness([status(429)]);
    const response = await h.fetcher("https://api.github.com/x");
    assert.equal(response.status, 429);
    assert.equal(h.calls(), 1, "429 必須立刻回傳給呼叫端");
    assert.deepEqual(h.slept, []);
  });

  it("403 與 404 也不重試——那是事實不是暫時性失敗", async () => {
    for (const code of [403, 404, 401, 422]) {
      const h = harness([status(code)]);
      const response = await h.fetcher("https://api.github.com/x");
      assert.equal(response.status, code);
      assert.equal(h.calls(), 1, `${code} 不該被重試`);
    }
  });

  it("5xx 會重試，因為那是伺服器端的暫時性問題", async () => {
    const h = harness([status(502), status(503), ok()]);
    const response = await h.fetcher("https://api.github.com/x");
    assert.equal(response.status, 200);
    assert.equal(h.calls(), 3);
    assert.equal(h.events.length, 2);
    assert.deepEqual(
      h.events.map((e) => e.reason),
      [{ kind: "status", status: 502 }, { kind: "status", status: 503 }],
    );
  });

  it("用完次數時把**原始錯誤**照原樣拋出，不包一層自己的", async () => {
    // 包一層會蓋掉 ECONNRESET 這種對排查有用的資訊。
    const boom = new Error("Client network socket disconnected");
    const h = harness([boom]);
    await assert.rejects(
      () => h.fetcher("https://api.github.com/x"),
      (error: unknown) => error === boom,
    );
    assert.equal(h.calls(), 5, "預設嘗試 5 次");
    assert.deepEqual(h.slept, [10, 20, 40, 80]);
  });

  it("用完次數時的 5xx 照原樣回傳，不轉成例外", async () => {
    // 呼叫端對非 200 已經有 stopped 路徑，轉成例外會繞過它。
    const h = harness([status(503)]);
    const response = await h.fetcher("https://api.github.com/x");
    assert.equal(response.status, 503);
    assert.equal(h.calls(), 5);
  });

  it("成功時不呼叫 sleep，也不產生事件", async () => {
    const h = harness([ok()]);
    await h.fetcher("https://api.github.com/x");
    assert.equal(h.calls(), 1);
    assert.deepEqual(h.slept, []);
    assert.deepEqual(h.events, []);
  });

  it("**重試不得靜默**——看不見的降級等於沒有降級", async () => {
    const h = harness([new Error("fetch failed"), ok()]);
    await h.fetcher("https://api.github.com/issues/194/comments");
    assert.equal(h.events.length, 1);
    const line = describeRetry(h.events[0]!);
    assert.match(line, /fetch failed/);
    assert.match(line, /issues\/194\/comments/, "訊息要指得出是哪個請求");
  });

  it("maxAttempts = 1 代表完全不重試", async () => {
    let calls = 0;
    const fetcher = createRetryingFetcher(
      async () => { calls++; throw new Error("boom"); },
      { maxAttempts: 1, sleep: async () => {} },
    );
    await assert.rejects(() => fetcher("https://api.github.com/x"));
    assert.equal(calls, 1);
  });

  it("非法的 maxAttempts 立刻拒絕，不等到執行時才壞", async () => {
    assert.throws(
      () => createRetryingFetcher(async () => ok(), { maxAttempts: 0 }),
      /maxAttempts/,
    );
  });
});
