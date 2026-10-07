import { Queue } from "bullmq";
import redis, { isRedisAvailable } from "./redis.js";
import { sendBookingReceiptEmail, sendBroadcastEmail } from "./emailService.js";

let emailQueue = null;

if (redis) {
  try {
    emailQueue = new Queue("emailQueue", {
      connection: redis,
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: "exponential", delay: 3000 },
        removeOnComplete: 200,
        removeOnFail: 1000,
      },
    });
    emailQueue.on("error", () => {});
  } catch {
    emailQueue = null;
  }
}

const canQueue = () => Boolean(emailQueue && isRedisAvailable);

/** Queues the ticket email when Redis is available, otherwise sends it directly. */
export async function queueTicketReceiptEmail(bookingId) {
  if (canQueue()) return emailQueue.add("send-ticket-receipt", { bookingId });
  return sendBookingReceiptEmail({ bookingId });
}

export async function queueBroadcastEmail(payload) {
  if (canQueue()) return emailQueue.add("send-broadcast-notice", payload);
  return sendBroadcastEmail(payload);
}
