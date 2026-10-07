// Single source of truth for the agency identity used by emails, PDF tickets and API messages.
// To launch for another agency, edit this file and the .env credentials only.
import { env } from "./env.js";

export const brand = {
  name: process.env.AGENCY_NAME || "Vatican Express",
  legalName: "Vatican Express Co. Ltd",
  monogram: "VE",
  descriptor: "Intercity Coaches",
  tagline: "Intercity Travel across Cameroon",
  // Prefix of generated booking references, e.g. VE-7K2M9Q
  refPrefix: "VE",
  website: env.frontendUrl,

  support: {
    phone: "(+237) 677 00 00 00",
    whatsapp: "237677000000",
    email: process.env.SUPPORT_EMAIL || "support@vaticantravels.cm",
    hours: "Daily, 05:00 to 22:00",
  },

  headOffice: "Commercial Avenue, Bamenda, North West Region, Cameroon",

  // Email sender identity (the address must be verified in Brevo).
  sender: {
    name: process.env.SENDER_NAME || "Vatican Express",
    email: process.env.SENDER_EMAIL || "tickets@vaticantravels.cm",
  },

  colors: {
    primary: "#0c1b33",
    primaryDark: "#07122a",
    accent: "#c8942a",
    accentSoft: "#fbf4e4",
    text: "#0f172a",
    muted: "#64748b",
    line: "#e2e8f0",
    surface: "#f4f6fa",
    success: "#047857",
  },

  currency: "XAF",
  timezone: "Africa/Douala",

  boarding: {
    arriveMinutesBefore: 30,
    onlineSalesCutoffMinutes: 30,
    seatHoldMinutes: 5,
  },

  // Fees added on top of the base fare for online (Mobile Money) purchases.
  pricing: {
    terminalFeePerSeat: 100, // paid out to the agency
    serviceFeePerSeat: 200, // paid out to the platform operator
    gatewayRate: 0.01, // Mobile Money gateway fee on the subtotal
  },
};
