import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";

import { AUDIT_ACTION_NAMES } from "../src/audit/audit";
import { apiFetch, startApi, stopApi } from "./helpers";

// With online sales on, so their routes (buying, pricing, promotion codes) are checked too
vi.mock("../src/features", () => ({ ONLINE_SALES: true, ONLINE_SALES_MODE: "public" }));

beforeAll(startApi);
afterAll(stopApi);

// A new endpoint that changes data has to say what it logs, or this fails
describe("every data-changing endpoint", () => {
  it("declares which actions it records, all of them real, or that it changes nothing", async () => {
    const spec = (await apiFetch("GET", "/openapi.json")).body as {
      paths: Record<string, Record<string, { "x-audit"?: string[] }>>;
    };

    const undeclared: string[] = [];
    const unknown: string[] = [];
    for (const [path, operations] of Object.entries(spec.paths)) {
      for (const [method, operation] of Object.entries(operations)) {
        if (method === "get") continue;
        const actions = operation["x-audit"];
        if (!actions) undeclared.push(`${method.toUpperCase()} ${path}`);
        for (const action of actions ?? []) {
          if (!AUDIT_ACTION_NAMES.includes(action as never)) unknown.push(action);
        }
      }
    }

    expect(Object.keys(spec.paths)).toEqual(expect.arrayContaining(["/api/v1/tickets", "/api/v1/tickets/quote"]));
    expect(undeclared).toEqual([]);
    expect(unknown).toEqual([]);
  });

  it("only says it changes nothing where that's true", async () => {
    const spec = (await apiFetch("GET", "/openapi.json")).body as {
      paths: Record<string, Record<string, { "x-audit"?: string[] }>>;
    };

    const silent = Object.entries(spec.paths).flatMap(([path, operations]) =>
      Object.entries(operations)
        .filter(([method, operation]) => method !== "get" && operation["x-audit"]?.length === 0)
        .map(([method]) => `${method.toUpperCase()} ${path}`));

    // Add a route here only after checking it writes nothing
    expect(silent).toEqual(["POST /api/v1/tickets/quote"]);
  });
});
