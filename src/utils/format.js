import { brand } from "../config/brand.js";

const HTML_ESCAPES = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export const escapeHtml = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);

export const formatXAF = (amount) =>
  `${Number(amount || 0).toLocaleString("en-GB")} ${brand.currency}`;

// '2026-10-07' -> 'Wed 7 Oct 2026'
export function formatDate(value) {
  const match = String(value ?? "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return String(value ?? "");
  const date = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])),
  );
  return date.toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

// '07:30:00' -> '07:30'
export const formatTime = (value) => String(value ?? "").slice(0, 5);

export function formatDateTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: brand.timezone,
  });
}

export const shiftLabel = (shift) =>
  shift === "evening"
    ? "Evening"
    : shift === "morning"
      ? "Morning"
      : "Scheduled";

// Accepts 6XXXXXXXX, 2376XXXXXXXX or +2376XXXXXXXX and returns the 9-digit national number, or null.
export function toNationalPhone(input) {
  let digits = String(input ?? "").replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("237"))
    digits = digits.slice(3);
  return /^6\d{8}$/.test(digits) ? digits : null;
}

export const toInternationalPhone = (input) => {
  const national = toNationalPhone(input);
  return national ? `237${national}` : null;
};

export const isValidEmail = (value) =>
  typeof value === "string" &&
  value.length <= 254 &&
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
