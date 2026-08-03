import type { HttpFetcher, HttpResponse } from "./types.ts";

/**
 * 暫時性失敗的重試包裝。**它自己不碰網路**，只包住一個 `HttpFetcher`，
 * 所以「網路只准出現在 `github.ts`」這條規則不受影響。
 *
 * 為什麼需要它：demo 語料的 linked 收取跑了 51 分鐘、3,229 個請求，其中出現
 * **4 次 `fetch failed`**（TLS `ECONNRESET` 之類）。每一次都會讓整趟拋例外中止。
 * per-commit transaction 與水位線讓它不會損壞資料、可以續跑，但要人守著重跑四次
 * 才做得完——那不是「可恢復」該有的體驗。
 */

/** 預設最多嘗試幾次（含第一次）。1+2+4+8 = 15 秒的總等待上限。 */
export const DEFAULT_MAX_ATTEMPTS = 5;
export const DEFAULT_BASE_DELAY_MS = 1000;

export interface RetryEvent {
  url: string;
  /** 第幾次嘗試失敗了（從 1 起算）。 */
  attempt: number;
  /** 下一次嘗試前要等多久。 */
  delayMs: number;
  /** 丟出來的錯誤，或收到的 5xx 狀態碼。 */
  reason: { kind: "threw"; error: unknown } | { kind: "status"; status: number };
}

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  /** 每次重試前呼叫。**預設不靜默重試**——看不見的降級等於沒有降級。 */
  onRetry?: (event: RetryEvent) => void;
  /** 測試注入用；預設是真的等待。 */
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 這個狀態碼值不值得重試。
 *
 * **4xx 一律不重試，rate limit 尤其不能。** 429 與觸發次級限制的 403 由呼叫端
 * 以 `stopped` 優雅處理：它會讀 `x-ratelimit-reset`、保住水位線、讓人稍後續跑。
 * 在這裡用幾秒的退避去重試，等於把一個乾淨的「暫停，稍後再來」變成盲目敲門，
 * 而 reset 可能在一小時之後。404 也不重試——那是「這個 issue 不存在」的事實，
 * 不是暫時性失敗。
 *
 * 5xx 才是伺服器端的暫時性問題。
 */
const retryableStatus = (status: number): boolean => status >= 500 && status <= 599;

export function createRetryingFetcher(
  inner: HttpFetcher,
  options: RetryOptions = {},
): HttpFetcher {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const sleep = options.sleep ?? realSleep;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error(`maxAttempts 必須是 >= 1 的整數，收到 ${maxAttempts}`);
  }

  return async (url) => {
    let delayMs = baseDelayMs;
    for (let attempt = 1; ; attempt++) {
      const last = attempt >= maxAttempts;
      let response: HttpResponse;
      try {
        response = await inner(url);
      } catch (error) {
        // 用完次數就把原始錯誤照原樣往上拋。包一層自己的錯誤會蓋掉
        // ECONNRESET 這種對排查有用的資訊。
        if (last) throw error;
        options.onRetry?.({ url, attempt, delayMs, reason: { kind: "threw", error } });
        await sleep(delayMs);
        delayMs *= 2;
        continue;
      }
      if (!retryableStatus(response.status) || last) return response;
      options.onRetry?.({
        url,
        attempt,
        delayMs,
        reason: { kind: "status", status: response.status },
      });
      await sleep(delayMs);
      delayMs *= 2;
    }
  };
}

/** 把重試事件轉成一行人看得懂的訊息。 */
export function describeRetry(event: RetryEvent): string {
  const why = event.reason.kind === "status"
    ? `HTTP ${event.reason.status}`
    : String(
      event.reason.error instanceof Error
        ? event.reason.error.message
        : event.reason.error,
    ).slice(0, 80);
  return `第 ${event.attempt} 次嘗試失敗（${why}），${event.delayMs} ms 後重試：${event.url}`;
}
