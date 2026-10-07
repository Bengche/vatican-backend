import { alertAdmin } from "../services/alerts.js";
import { captureError } from "../services/monitoring.js";

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Wraps an async Express handler so thrown HttpErrors become JSON responses. */
export const handle =
  (fn, fallbackMessage = "Something went wrong. Please try again.") =>
  async (req, res) => {
    try {
      await fn(req, res);
    } catch (error) {
      if (error instanceof HttpError) {
        return res
          .status(error.status)
          .json({ success: false, message: error.message });
      }
      console.error(`[${req.method} ${req.originalUrl}]`, error);
      captureError(error);
      alertAdmin(
        `Server error on ${req.method} ${req.path}`,
        error.stack || String(error),
      );
      return res.status(500).json({ success: false, message: fallbackMessage });
    }
  };
