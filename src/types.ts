export type Row = Record<string, any>;
export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  SESSION_SECRET: string;
  APP_NAME?: string;
  ENABLE_PLAY_PROXY?: string;
}
export interface ViewerEnv {
  id?: number | null;
  name: string;
  carrier: string;
  supports_ipv4: boolean;
  supports_ipv6: boolean;
  supports_iptv: boolean;
  region: string;
  automatic: boolean;
  label: string;
}
export interface IPInfo {
  ip: string;
  version: number | null;
  carrier: string;
  region: string;
  isp: string;
  location: string;
  source: string;
  message: string;
}
export interface Resolved {
  viewer: ViewerEnv;
  source: string;
  info: IPInfo;
}
export interface Variables {
  user: Row;
  store: import('./store').Store;
}
