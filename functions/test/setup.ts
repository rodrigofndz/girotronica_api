// Values the function reads at runtime; the emulator hosts come from `firebase emulators:exec`
process.env.GCLOUD_PROJECT ??= "girotronica-api";
process.env.FUNCTIONS_EMULATOR = "true";
process.env.STRIPE_SECRET_KEY ??= "sk_test_dummy";
process.env.STRIPE_WEBHOOK_SECRET ??= "whsec_test_dummy";
process.env.FRONTEND_URL ??= "http://localhost:8080";
