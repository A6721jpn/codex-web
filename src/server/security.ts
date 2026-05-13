export type CsrfCheck = {
  expectedToken?: string;
  headers: Record<string, string | undefined>;
  method: string;
  publicOrigin: string;
};

export type SecurityDecision = {
  ok: boolean;
  reason?: string;
};

export function validateCsrf(check: CsrfCheck): SecurityDecision {
  if (["GET", "HEAD", "OPTIONS"].includes(check.method.toUpperCase())) {
    return { ok: true };
  }
  const fetchSite = check.headers["sec-fetch-site"];
  if (fetchSite === "cross-site") {
    return { ok: false, reason: "cross-site fetch metadata rejected" };
  }

  const origin = check.headers.origin;
  const referer = check.headers.referer;
  if (origin) {
    if (origin !== check.publicOrigin) {
      return { ok: false, reason: "origin rejected" };
    }
  } else if (referer) {
    if (!referer.startsWith(`${check.publicOrigin}/`)) {
      return { ok: false, reason: "referer rejected" };
    }
  } else {
    return { ok: false, reason: "missing origin" };
  }

  if (!check.expectedToken || check.headers["x-csrf-token"] !== check.expectedToken) {
    return { ok: false, reason: "csrf token rejected" };
  }
  return { ok: true };
}

export function requestHeaders(request: Request): Record<string, string | undefined> {
  return {
    origin: request.headers.get("origin") ?? undefined,
    referer: request.headers.get("referer") ?? undefined,
    "sec-fetch-site": request.headers.get("sec-fetch-site") ?? undefined,
    "x-csrf-token": request.headers.get("x-csrf-token") ?? undefined,
  };
}
