import Stripe from "stripe";
import { env } from "../config/env";
import { ApiError } from "../utils/ApiError";

let stripe: Stripe | null = null;

export function getStripe(): Stripe {
  if (!env.STRIPE_SECRET_KEY) {
    throw new ApiError(503, "Payment gateway is not configured (STRIPE_SECRET_KEY missing)");
  }
  if (!stripe) stripe = new Stripe(env.STRIPE_SECRET_KEY);
  return stripe;
}
