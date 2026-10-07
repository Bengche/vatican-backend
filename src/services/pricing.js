import { brand } from "../config/brand.js";

/**
 * Authoritative fare breakdown for online purchases.
 * Never trust amounts sent by the browser; always derive them from the trip price.
 */
export function quoteFare(unitPrice, seatCount) {
  const seats = Math.max(1, Number(seatCount) || 1);
  const unit = Number(unitPrice) || 0;
  const { terminalFeePerSeat, serviceFeePerSeat, gatewayRate } = brand.pricing;

  const baseFare = unit * seats;
  const terminalFee = terminalFeePerSeat * seats;
  const serviceFee = serviceFeePerSeat * seats;
  const subtotal = baseFare + terminalFee + serviceFee;
  const gatewayFee = Math.ceil(subtotal * gatewayRate);

  return {
    seatCount: seats,
    unitPrice: unit,
    baseFare,
    terminalFee,
    serviceFee,
    gatewayFee,
    totalAmount: subtotal + gatewayFee,
  };
}
