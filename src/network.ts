// Public read fetches for gather (ATS boards, optional TheirStack, public GitHub).
// Live by default so a real assistant can pull boards. Set JOBBOT_NETWORK=off
// (disabled/0/false) to keep a process hermetic — tests do this. Injected fetch
// functions still bypass this module entirely.
//
// This switch does not enable the offline discovery loop, people collection,
// review delivery, or the executor. Nothing here applies to a job or sends a message.
// LinkedIn hosts are refused, including as a redirect target.

export const NETWORK_DISABLED =
  "Network disabled: JOBBOT_NETWORK=off keeps this run hermetic. Unset it, or set JOBBOT_NETWORK=live, to fetch public ATS boards. No messages are sent and nothing is auto-applied.";

const OFF = new Set(["off", "disabled", "0", "false", "no"]);
const ON = new Set(["live", "on", "1", "true", "yes"]);

export function networkEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.JOBBOT_NETWORK;
  if (raw === undefined || raw.trim() === "") return true;
  const value = raw.trim().toLowerCase();
  if (OFF.has(value)) return false;
  if (ON.has(value)) return true;
  throw new Error(`JOBBOT_NETWORK must be live or off (got ${raw})`);
}

export function linkedInHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return host === "linkedin.com" || host.endsWith(".linkedin.com")
    || host === "linkedin.cn" || host.endsWith(".linkedin.cn")
    || host === "lnkd.in" || host.endsWith(".lnkd.in");
}

export function assertPublicFetchUrl(raw: URL): void {
  const host = raw.hostname.toLowerCase().replace(/\.$/, "");
  if (raw.protocol !== "https:" || raw.username || raw.password || (raw.port && raw.port !== "443"))
    throw new Error("only credential-free https fetches are allowed");
  if (linkedInHost(host)) throw new Error("blocked host: LinkedIn is not fetched");
}

function asUrl(input: Parameters<typeof fetch>[0]): URL {
  if (typeof input === "string") return new URL(input);
  if (input instanceof URL) return new URL(input.href);
  return new URL(input.url);
}

const MAX_REDIRECTS = 3;

export function fetchTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.JOBBOT_FETCH_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === "") return 20_000;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1) throw new Error("JOBBOT_FETCH_TIMEOUT_MS must be a positive number of milliseconds");
  return value;
}
export function fetchRetryCount(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.JOBBOT_FETCH_RETRIES;
  if (raw === undefined || raw.trim() === "") return 2;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 5) throw new Error("JOBBOT_FETCH_RETRIES must be an integer from 0 to 5");
  return value;
}
function fetchBackoffMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.JOBBOT_FETCH_BACKOFF_MS;
  if (raw === undefined || raw.trim() === "") return 200;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error("JOBBOT_FETCH_BACKOFF_MS must be a non-negative number");
  return value;
}
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function armTimeout(ms: number): { signal: AbortSignal; disarm: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    const error = new Error("The operation was aborted due to timeout");
    error.name = "TimeoutError";
    controller.abort(error);
  }, ms);
  return { signal: controller.signal, disarm: () => clearTimeout(timer) };
}
function timedInit(init: RequestInit | undefined, ms: number): { init: RequestInit; disarm: () => void } {
  const armed = armTimeout(ms);
  const signal = init?.signal ? AbortSignal.any([init.signal, armed.signal]) : armed.signal;
  return { init: { ...init, signal }, disarm: armed.disarm };
}
function isTimeout(error: unknown): boolean {
  const name = (error as { name?: string })?.name;
  const message = error instanceof Error ? error.message : String(error);
  return name === "TimeoutError" || name === "AbortError" || /timed out|timeout/i.test(message);
}
function retryableFailure(error: unknown): boolean {
  if (isTimeout(error)) return true;
  const message = error instanceof Error ? error.message : String(error);
  if (/blocked host|redirect refused|only credential-free/i.test(message)) return false;
  return /fetch failed|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket/i.test(message);
}

// Follow a few GET redirects ourselves so a hop to LinkedIn is refused.
// Non-GET redirects are refused so a paid POST (TheirStack) cannot be replayed
// at an unexpected host with its Authorization header.
async function liveFetchOnce(input: Parameters<typeof fetch>[0], init: RequestInit | undefined, timeoutMs: number): Promise<Response> {
  let current = asUrl(input);
  let method = (init?.method ?? "GET").toUpperCase();
  let armed = timedInit(init, timeoutMs);
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      assertPublicFetchUrl(current);
      let res: Response;
      try { res = await fetch(current, { ...armed.init, redirect: "manual" }); }
      catch (error) {
        if (isTimeout(error)) throw new Error(`fetch timed out after ${timeoutMs}ms`);
        throw error;
      } finally { armed.disarm(); }
      if (res.status < 300 || res.status >= 400) return res;
      const location = res.headers.get("location");
      if (!location || hop === MAX_REDIRECTS) throw new Error("redirect refused");
      if (method !== "GET" && method !== "HEAD") throw new Error("redirect refused for non-GET fetch");
      current = new URL(location, current);
      method = "GET";
      armed = timedInit({ ...armed.init, method: "GET", body: undefined }, timeoutMs);
    }
  } finally { armed.disarm(); }
  throw new Error("redirect refused");
}

export const liveFetch: typeof fetch = async (input, init) => {
  const method = (init?.method ?? "GET").toUpperCase();
  const retries = fetchRetryCount();
  const timeoutMs = fetchTimeoutMs();
  const backoff = fetchBackoffMs();
  let last: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await liveFetchOnce(input, init, timeoutMs);
      const retryStatus = method === "GET" || method === "HEAD" ? (res.status === 429 || res.status >= 500) : false;
      if (retryStatus && attempt < retries) {
        await pause(backoff * (2 ** attempt));
        continue;
      }
      return res;
    } catch (error) {
      last = error;
      if (!retryableFailure(error) || attempt === retries) throw error;
      await pause(backoff * (2 ** attempt));
    }
  }
  throw last instanceof Error ? last : new Error("fetch failed");
};

export const disabledFetch: typeof fetch = async () => {
  throw new Error(NETWORK_DISABLED);
};

export const configuredFetch: typeof fetch = (input, init) =>
  (networkEnabled() ? liveFetch : disabledFetch)(input, init);
