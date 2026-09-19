import { defineString } from "firebase-functions/params";

/** The web project's origin: Stripe redirect targets and the allowed CORS origin. */
export const frontendUrl = defineString("FRONTEND_URL", {
  default: "http://localhost:8080",
});

/**
 * Firebase Hosting projects whose preview channels may call the API, comma separated.
 * Empty means none, so production only accepts FRONTEND_URL.
 */
export const previewProjects = defineString("PREVIEW_PROJECTS", { default: "" });
