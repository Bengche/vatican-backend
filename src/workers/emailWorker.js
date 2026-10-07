import { Worker } from "bullmq";
import redis from "../services/redis.js";
import { sendBookingReceiptEmail, sendBroadcastEmail } from "../services/emailService.js";

let emailWorker = null;

if (redis) {
  try {
    emailWorker = new Worker(
      "emailQueue",
      async (job) => {
        if (job.name === "send-ticket-receipt") return sendBookingReceiptEmail(job.data);
        if (job.name === "send-broadcast-notice") return sendBroadcastEmail(job.data);
        return null;
      },
      { connection: redis, concurrency: 5 },
    );

    emailWorker.on("failed", (job, err) => {
      console.error(`[Queue] Job ${job?.id} (${job?.name}) failed:`, err.message);
    });
    emailWorker.on("error", () => {});
  } catch {
    emailWorker = null;
  }
}

export default emailWorker;
