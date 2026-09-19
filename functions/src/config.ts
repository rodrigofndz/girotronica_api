import { defineString } from "firebase-functions/params";

/** The web project's origin: Stripe redirect targets and the allowed CORS origin. */
export const frontendUrl = defineString("FRONTEND_URL", {
  default: "http://localhost:8080",
});
