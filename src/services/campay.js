import { env } from "../config/env.js";

const TIMEOUT_MS = 25_000;
let cachedToken = null; // { value, expiresAt }

async function getToken() {
  if (env.campay.permanentToken) return env.campay.permanentToken;

  if (cachedToken && cachedToken.expiresAt > Date.now())
    return cachedToken.value;

  const response = await fetch(`${env.campay.baseUrl}/token/`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username: env.campay.username,
      password: env.campay.password,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok || !data.token) {
    throw new Error(
      data.message || "Unable to authenticate with the payment gateway.",
    );
  }

  cachedToken = {
    value: data.token,
    expiresAt:
      Date.now() + Math.max(60, (data.expires_in || 3600) - 120) * 1000,
  };
  return cachedToken.value;
}

async function request(method, path, body) {
  const token = await getToken();
  const response = await fetch(`${env.campay.baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Token ${token}`,
      "content-type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(
      data.message ||
        data.detail ||
        `Payment gateway error (${response.status}).`,
    );
    error.status = response.status;
    error.details = data;
    throw error;
  }
  return data;
}

export const collectPayment = ({
  amount,
  phone,
  description,
  externalReference,
}) =>
  request("POST", "/collect/", {
    amount: String(amount),
    currency: "XAF",
    from: phone,
    description,
    external_reference: String(externalReference),
  });

export const getTransaction = (reference) =>
  request("GET", `/transaction/${encodeURIComponent(reference)}/`);

export const sendPayout = ({ amount, phone, description, externalReference }) =>
  request("POST", "/withdraw/", {
    amount: String(amount),
    currency: "XAF",
    to: phone,
    description,
    external_reference: String(externalReference),
  });
