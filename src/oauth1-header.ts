// The `Authorization: OAuth ...` header of an OAuth 1.0a request. Kept apart from
// oauth1.ts so auth.ts can read it without a circular import. It runs for every
// request, so a malformed header reads as empty instead of throwing.

const decode = (s: string) => {
	try {
		return decodeURIComponent(s.replace(/\+/g, " "));
	} catch {
		return s;
	}
};

// the percent-decoded fields of the header
export function headerParams(req: Request): Record<string, string> {
	const out: Record<string, string> = {};
	const raw = /^OAuth\s+(.*)$/is.exec(req.headers.get("authorization") ?? "")?.[1];
	if (!raw) return out;
	for (const part of raw.split(",")) {
		const m = /^\s*([^=\s]+)\s*=\s*"?([^"]*)"?\s*$/.exec(part);
		if (m) out[decode(m[1]!)] = decode(m[2]!);
	}
	return out;
}

// the token a signed request names, for auth.ts to look up as a session
export const oauth1Token = (req: Request): string | undefined => headerParams(req).oauth_token || undefined;
