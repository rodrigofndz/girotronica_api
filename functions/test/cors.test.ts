import { beforeAll, afterAll, describe, expect, it } from "vitest";

import { apiFetch, startApi, stopApi } from "./helpers";

const FRONTEND = "http://localhost:8080";
const PREVIEW_PROJECT = "cs-poc-oorvxxydyz5a4aqpaieeeye";

const preflight = (origin: string, method = "GET") =>
  apiFetch("OPTIONS", "/me", {
    headers: {
      Origin: origin,
      "Access-Control-Request-Method": method,
      "Access-Control-Request-Headers": "authorization",
    },
  });

const allowedOrigin = async (origin: string) =>
  (await preflight(origin)).headers.get("access-control-allow-origin");

beforeAll(async () => {
  process.env.PREVIEW_PROJECTS = PREVIEW_PROJECT;
  await startApi();
});
afterAll(stopApi);

describe("cross-origin access", () => {
  it("answers the preflight without a token", async () => {
    const res = await preflight(FRONTEND);

    expect(res.status).not.toBe(401);
    expect(res.headers.get("access-control-allow-origin")).toBe(FRONTEND);
  });

  it("allows the Authorization header and caches the answer", async () => {
    const res = await preflight(FRONTEND);

    expect(res.headers.get("access-control-allow-headers")?.toLowerCase()).toContain("authorization");
    expect(res.headers.get("access-control-max-age")).toBe("3600");
  });

  it("advertises only the methods the API uses", async () => {
    const res = await preflight(FRONTEND, "DELETE");

    expect(res.headers.get("access-control-allow-methods")).toBe("GET,POST,DELETE,OPTIONS");
  });

  it("allows a hosting preview channel of a configured project", async () => {
    const preview = `https://${PREVIEW_PROJECT}--pr18-test-api-ve74tkw1.web.app`;

    expect(await allowedOrigin(preview)).toBe(preview);
  });

  it.each([
    ["an unrelated site", "https://evil.example"],
    ["another project's preview", "https://someone-else--pr1.web.app"],
    ["a lookalike domain", `https://${PREVIEW_PROJECT}.web.app.evil.com`],
    ["an insecure preview", `http://${PREVIEW_PROJECT}--pr18.web.app`],
    ["the project id used as the channel", `https://evil--${PREVIEW_PROJECT}.web.app`],
  ])("blocks %s", async (_label, origin) => {
    expect(await allowedOrigin(origin)).toBeNull();
  });

  it("does not let CORS stand in for authentication", async () => {
    const res = await apiFetch("GET", "/me", { headers: { Origin: FRONTEND } });

    expect(res.status).toBe(401);
  });
});
