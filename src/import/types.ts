import type { FetchResult } from "../extract";
import type { SearchProvider } from "../search";
import type { ProviderFetch } from "../search-providers";

export type FeedResult = {
  feedId: string;
  runId: string;
  status: "completed" | "failed";
  valid: number;
  invalid: number;
  error?: string;
};

export type ArticleFetcher = (url: string) => Promise<FetchResult>;

export type Intake = {
  runId: string;
  parseError: string | null;
  settled: boolean;
};

export type SearchCollectionOptions = {
  apiKey: string;
  monthlyCallBudget?: number;
  limit?: number;
  now?: Date;
  fetchFn?: ProviderFetch;
  fetchArticle?: ArticleFetcher;
};

export type SearchCollectionResult =
  | {
      status: "completed";
      runId: string;
      valid: number;
      invalid: number;
      usage: { calls: number; costDollars?: number };
    }
  | { status: "paused"; runId: string; reason: string };
