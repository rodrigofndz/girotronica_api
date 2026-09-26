import { cors } from "hono/cors";

import { frontendUrl, previewProjects } from "./config";

const DEV_ORIGINS = ["http://localhost:8080", "http://127.0.0.1:8080"];

const stripSlash = (url: string) => url.replace(/\/+$/, "");

/**
 * Preview channels are `<project>--<channel>-<hash>.web.app`, and the hash changes
 * whenever a channel is recreated, so they're matched by project rather than listed.
 */
function isPreviewOf(host: string, projects: string[]): boolean {
  const site = host.endsWith(".web.app")
    ? host.slice(0, -".web.app".length)
    : host.endsWith(".firebaseapp.com")
      ? host.slice(0, -".firebaseapp.com".length)
      : null;
  if (site === null) return false;

  const [project, ...rest] = site.split("--");
  if (!projects.includes(project)) return false;

  return rest.length === 0 || (rest.length === 1 && /^[a-z0-9-]+$/.test(rest[0]));
}

function isAllowed(origin: string): boolean {
  if ([stripSlash(frontendUrl.value()), ...DEV_ORIGINS].includes(stripSlash(origin))) {
    return true;
  }

  const projects = previewProjects.value().split(",").map((p) => p.trim()).filter(Boolean);
  if (projects.length === 0) return false;

  let url;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }

  return url.protocol === "https:" && isPreviewOf(url.host, projects);
}

export const corsMiddleware = cors({
  origin: (origin) => (isAllowed(origin) ? origin : null),
  allowHeaders: ["Authorization", "Content-Type"],
  allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  maxAge: 3600,
});
