import type { IncomingMessage, ServerResponse } from "node:http";
import { CACHE, sendJson } from "../http.js";
import { HolderError } from "./errors.js";
import type { FundingStep, HolderService } from "./service.js";
import type { HolderSession } from "./sessions.js";

/**
 * `/api/holder/*`: POST + JSON, same-origin only (no CORS headers), bearer-token sessions from
 * Sign-In-With-Cardano. Every funding route also needs a fresh holder proof, which the
 * HOLDER_PRESENT client checks before anything is signed.
 */
const MAX_BODY = 1024 * 1024;

type Handler = (session: HolderSession | null, body: unknown) => unknown;

interface Route {
  method: "GET" | "POST";
  auth: boolean;
  fn: Handler;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const type = String(req.headers["content-type"] ?? "");
  if (!type.startsWith("application/json")) throw new HolderError(415, "send application/json");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new HolderError(413, "request body too large");
    chunks.push(c as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HolderError(400, "request body is not JSON");
  }
}

export function createHolderHandler(service: HolderService) {
  const must = (s: HolderSession | null): HolderSession => {
    if (!s) throw new HolderError(401, "sign in with your wallet first");
    return s;
  };
  const funding = (step: FundingStep): Route => ({
    method: "POST",
    auth: true,
    fn: (s, b) => service.funding(must(s), step, b),
  });
  const routes: Record<string, Route> = {
    "session/challenge": { method: "POST", auth: false, fn: (_s, b) => service.challenge(b) },
    session: { method: "POST", auth: false, fn: (_s, b) => service.signIn(b) },
    me: { method: "GET", auth: true, fn: (s) => service.me(must(s)) },
    attest: { method: "POST", auth: true, fn: (s, b) => service.attest(must(s), b) },
    "account/check": { method: "POST", auth: true, fn: (s) => service.accountCheck(must(s)) },
    "connect/start": { method: "POST", auth: true, fn: (s) => service.connectStart(must(s)) },
    "connect/finish": {
      method: "POST",
      auth: true,
      fn: (s, b) => service.connectFinish(must(s), b),
    },
    "deposit/quote": funding("deposit/quote"),
    "deposit/build": funding("deposit/build"),
    "deposit/confirm": funding("deposit/confirm"),
    "withdraw/estimate": funding("withdraw/estimate"),
    "withdraw/quote": funding("withdraw/quote"),
    "withdraw/confirm": funding("withdraw/confirm"),
    "tx/merge": { method: "POST", auth: true, fn: (s, b) => service.merge(must(s), b) },
    "consent/start": { method: "POST", auth: true, fn: (s, b) => service.consentStart(must(s), b) },
    "consent/finish": {
      method: "POST",
      auth: true,
      fn: (s, b) => service.consentFinish(must(s), b),
    },
    stop: { method: "POST", auth: true, fn: (s) => service.stop(must(s)) },
  };

  return {
    async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
      const name = url.pathname.slice("/api/holder/".length);
      const route = Object.hasOwn(routes, name) ? routes[name] : undefined;
      try {
        if (name === "session/end" && req.method === "POST") {
          service.sessions.end(req.headers.authorization);
          sendJson(req, res, 200, { ok: true }, CACHE.none);
          return;
        }
        if (!route) throw new HolderError(404, "no such holder route");
        if (req.method === "OPTIONS") {
          res.writeHead(204, { Allow: `${route.method}, OPTIONS` });
          res.end();
          return;
        }
        if (req.method !== route.method) {
          throw new HolderError(405, `use ${route.method}`);
        }
        const session = route.auth ? service.sessions.require(req.headers.authorization) : null;
        const body = route.method === "POST" ? await readJson(req) : undefined;
        const out = await route.fn(session, body);
        sendJson(req, res, 200, out, CACHE.none);
      } catch (err) {
        if (err instanceof HolderError) {
          sendJson(req, res, err.status, { error: err.message, ...err.extra }, CACHE.none);
          return;
        }
        throw err;
      }
    },
  };
}

export type HolderHandler = ReturnType<typeof createHolderHandler>;
