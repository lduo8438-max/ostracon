export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** 網路邊界：產品注入 live adapter，測試與 golden 注入 replay。 */
export interface HttpFetcher {
  (url: string): Promise<HttpResponse>;
}
