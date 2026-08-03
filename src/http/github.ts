import type { HttpFetcher } from "./types.ts";

export interface GitHubFetcherOptions {
  token?: string;
  userAgent?: string;
}

/**
 * 唯一直接碰網路的產品模組。其餘 linked 程式只依賴 HttpFetcher。
 */
export function createGitHubFetcher(options: GitHubFetcherOptions = {}): HttpFetcher {
  return async (url) => {
    const target = new URL(url);
    if (target.protocol !== "https:" || target.hostname !== "api.github.com") {
      throw new Error(`GitHub adapter 拒絕非 api.github.com URL：${url}`);
    }
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2026-03-10",
      "User-Agent": options.userAgent ?? "ostracon-indexer",
    };
    if (options.token) headers.Authorization = `Bearer ${options.token}`;

    const response = await fetch(target, { headers });
    return {
      status: response.status,
      headers: Object.fromEntries(
        [...response.headers.entries()].map(([name, value]) => [name.toLowerCase(), value]),
      ),
      body: await response.text(),
    };
  };
}
