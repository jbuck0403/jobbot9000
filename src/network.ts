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

// Follow a few GET redirects ourselves so a hop to LinkedIn is refused.
// Non-GET redirects are refused so a paid POST (TheirStack) cannot be replayed
// at an unexpected host with its Authorization header.
export const liveFetch: typeof fetch = async (input, init) => {
  let current = asUrl(input);
  let method = (init?.method ?? "GET").toUpperCase();
  let nextInit: RequestInit | undefined = init;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    assertPublicFetchUrl(current);
    const res = await fetch(current, { ...nextInit, redirect: "manual" });
    if (res.status < 300 || res.status >= 400) return res;
    const location = res.headers.get("location");
    if (!location || hop === MAX_REDIRECTS) throw new Error("redirect refused");
    if (method !== "GET" && method !== "HEAD") throw new Error("redirect refused for non-GET fetch");
    current = new URL(location, current);
    method = "GET";
    nextInit = { ...nextInit, method: "GET", body: undefined };
  }
  throw new Error("redirect refused");
};

export const disabledFetch: typeof fetch = async () => {
  throw new Error(NETWORK_DISABLED);
};

export const configuredFetch: typeof fetch = (input, init) =>
  (networkEnabled() ? liveFetch : disabledFetch)(input, init);
