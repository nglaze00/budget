// SimpleFIN sign convention: positive = money IN, negative = money OUT.
// Account type is user-set (depository | credit | investment) since SimpleFIN doesn't tell us.
// Ported verbatim from the desktop app (src/lib/classify.ts) — pure, no platform deps.

export type FlowType = "spend" | "earn" | "transfer" | "cc_payment" | "unknown";

const CC_PAYMENT_HINTS = [/credit card payment/i, /\bcc pmt\b/i, /chase\s*card/i, /capital one\s*(crcard|pmt)/i, /\bautopay\b.*card/i];
const TRANSFER_HINTS = [/transfer/i, /xfer/i, /zelle/i, /venmo cashout/i];

export interface ClassifyInput {
  accountType: string | null;
  amount: number;
  description: string | null;
  payee: string | null;
}

export interface ClassifyOutput {
  flowType: FlowType;
  isPaycheck: boolean;
}

export function classify(t: ClassifyInput): ClassifyOutput {
  const text = `${t.description ?? ""} ${t.payee ?? ""}`;
  const isPaycheck = false;

  if (t.accountType === "credit") {
    return { flowType: t.amount < 0 ? "spend" : "cc_payment", isPaycheck };
  }

  if (CC_PAYMENT_HINTS.some((r) => r.test(text)) && t.amount < 0) {
    return { flowType: "cc_payment", isPaycheck };
  }
  if (TRANSFER_HINTS.some((r) => r.test(text))) {
    return { flowType: "transfer", isPaycheck };
  }
  return { flowType: t.amount > 0 ? "earn" : "spend", isPaycheck };
}
