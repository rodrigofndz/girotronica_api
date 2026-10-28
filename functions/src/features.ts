/**
 * Online sales through Stripe, from the function's environment (ONLINE_SALES):
 * - "off" (default, or anything unrecognised): no checkout endpoint, no webhook, no webhook secret
 * - "staff": open only to staff and admins, for testing a deployed setup with Stripe's test key
 * - "public": anyone signed in can buy
 * functions/.env.local sets it for the emulator only, since deploys never read that file;
 * the deploy workflow writes production's value into .env.<project>.
 */
export const ONLINE_SALES_MODES = ["off", "staff", "public"] as const;
export type OnlineSalesMode = (typeof ONLINE_SALES_MODES)[number];

const configured = process.env.ONLINE_SALES as OnlineSalesMode | undefined;

export const ONLINE_SALES_MODE: OnlineSalesMode =
  configured && ONLINE_SALES_MODES.includes(configured) ? configured : "off";

export const ONLINE_SALES = ONLINE_SALES_MODE !== "off";
