import Redis from "ioredis";
import { env } from "../config/env.js";

let redis = null;
export let isRedisAvailable = false;

if (env.redisUrl) {
  try {
    redis = new Redis(env.redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    retryStrategy(times) {
      if (times > 3) {
        console.warn("[Redis] Server unreachable. Continuing in direct database mode.");
        return null;
      }
      return 1000;
    },
  });

  redis.on("connect", () => {
    isRedisAvailable = true;
    console.log("[Redis] Connected. Seat holds and email queue active.");
  });

  redis.on("error", (err) => {
    isRedisAvailable = false;
    if (err.code !== "ECONNREFUSED") {
      console.warn("[Redis]", err.message);
    }
  });

  redis.on("end", () => {
    isRedisAvailable = false;
  });
  } catch (err) {
    redis = null;
    console.warn("[Redis] Invalid REDIS_URL, continuing in direct database mode:", err.message);
  }
} else {
  console.log("[Redis] REDIS_URL not set. Running in direct database mode.");
}

export default redis;
