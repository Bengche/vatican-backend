import rateLimit from "express-rate-limit";

const limiter = ({ windowMs, limit, message }) =>
  rateLimit({
    windowMs,
    limit,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { success: false, message },
  });

export const loginLimiter = limiter({
  windowMs: 15 * 60 * 1000,
  limit: 15,
  message: "Too many sign-in attempts. Please try again in a few minutes.",
});

export const registerLimiter = limiter({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  message: "Too many registration attempts. Please try again later.",
});

export const paymentLimiter = limiter({
  windowMs: 10 * 60 * 1000,
  limit: 20,
  message: "Too many payment requests. Please wait a moment and try again.",
});

export const webhookLimiter = limiter({
  windowMs: 60 * 1000,
  limit: 120,
  message: "Too many requests.",
});
