import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { HttpFetcher, HttpResponse } from "./types.ts";

interface HttpFixture {
  version: 1;
  request: { url: string };
  response: HttpResponse;
}

const SECRET_HEADER = /^(authorization|cookie|set-cookie|proxy-authorization)$/i;
const TOKEN_LIKE = /(?:bearer\s+|token\s+|github_pat_|gh[pousr]_[A-Za-z0-9_])/i;
// replay 只需要分頁與退避；其餘 request-id、日期、rate remaining 都會讓重錄產生雜訊。
const REPLAY_HEADER = /^(content-type|link|retry-after|x-ratelimit-reset)$/i;

export function fixtureName(url: string): string {
  return `${createHash("sha256").update(url).digest("hex")}.json`;
}

/** 錄檔前最後一道防線：敏感 header 名稱與 token-like 值都不落盤。 */
export function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([name, value]) =>
      REPLAY_HEADER.test(name) && !SECRET_HEADER.test(name) && !TOKEN_LIKE.test(value)
    ),
  );
}

export function createRecordingFetcher(
  live: HttpFetcher,
  fixtureDir: string,
): HttpFetcher {
  return async (url) => {
    const response = await live(url);
    const fixture: HttpFixture = {
      version: 1,
      request: { url },
      response: {
        status: response.status,
        headers: sanitizeHeaders(response.headers),
        body: response.body,
      },
    };
    mkdirSync(fixtureDir, { recursive: true });
    writeFileSync(
      path.join(fixtureDir, fixtureName(url)),
      `${JSON.stringify(fixture, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    return response;
  };
}

export function createReplayFetcher(fixtureDir: string): HttpFetcher {
  return async (url) => {
    const file = path.join(fixtureDir, fixtureName(url));
    const fixture = JSON.parse(readFileSync(file, "utf8")) as HttpFixture;
    if (fixture.version !== 1 || fixture.request.url !== url) {
      throw new Error(`HTTP fixture 與請求不符：${file}`);
    }
    return fixture.response;
  };
}
