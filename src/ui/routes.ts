/**
 * 端點路徑的**唯一來源**。伺服器、靜態匯出與前端都從這裡導出。
 *
 * **一律不帶前導斜線。** 前端把它解析在 `document.baseURI` 之下，所以
 * `ostracon ui`（服務於網域根）拿到 `/api/…`，而靜態站台掛在
 * `/ostracon-demo/vuejs-core/` 之下時拿到 `/ostracon-demo/vuejs-core/api/…`。
 * 寫成 `/api/…` 的絕對形式在前者完全正常、在後者會逃到網域根目錄——
 * **同一份產物、兩種部署位置，本機只驗得到其中一種。**
 *
 * `export.ts` 早就寫著「手寫字串就是分岔的開始」，而分岔真的發生了：
 * 前端自己抄了一份，抄的是絕對形式。所以這一份要被兩邊 import，
 * 不是被兩邊各寫一次。
 */

export const SUMMARY_ROUTE = "api/summary.json";
export const ENTITIES_ROUTE = "api/entities.json";
/**
 * 宣告搜尋目錄。`entities.json` 是策展入口，這一份才回答「我那個宣告在哪」。
 * 伺服器回全索引；靜態匯出只回確實有 timeline 的集合，兩者都由 coverage 說明。
 */
export const ENTITY_SEARCH_ROUTE = "api/entity-search.json";
export const OSTRACISED_ROUTE = "api/ostracised.json";
export const LADDER_ROUTE = "api/ladder.json";
export const DISCONTINUITIES_ROUTE = "api/discontinuities.json";
export const HOTSPOTS_ROUTE = "api/hotspots.json";
/** 以（引文、commit、kind）為單位的理由；不再把扇出誤算成理由數。 */
export const RATIONALES_ROUTE = "api/rationales.json";
export const evolutionRoute = (stableKey: string) =>
  `api/evolution/${stableKey}.json`;

/** 固定端點的完整清單。測試用它逐條檢查，不必再抄一份。 */
export const FIXED_ROUTES = [
  SUMMARY_ROUTE,
  ENTITIES_ROUTE,
  ENTITY_SEARCH_ROUTE,
  OSTRACISED_ROUTE,
  LADDER_ROUTE,
  DISCONTINUITIES_ROUTE,
  HOTSPOTS_ROUTE,
  RATIONALES_ROUTE,
] as const;

/**
 * 伺服器與匯出要的絕對形式。**只是加一條斜線**，不是第二份清單。
 * `url.pathname` 一定以斜線開頭，寫檔時 `path.join` 也吃得下。
 */
export const absolute = (route: string) => `/${route}`;
