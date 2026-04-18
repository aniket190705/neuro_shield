/**
 * Rolling 30s fatigue: server stores 0–10; UI shows round(score × 10) as 0–100.
 * Risk bands (rounded percent): 0–30 LOW, 31–59 MEDIUM, 60+ HIGH.
 * Keep logic in sync with riskFromFatigueScore in ../server.js
 */
export const RISK_PERCENT_LOW_MAX = 30;
export const RISK_PERCENT_MEDIUM_MAX = 59;
export const RISK_PERCENT_HIGH_MIN = 60;

/** One-line legend for gauges / footers */
export const RISK_BANDS_LEGEND = "0–30 LOW · 31–59 MEDIUM · 60+ HIGH";

export function rollingPercentFromScore0to10(score) {
  const s = Number(score);
  if (!Number.isFinite(s)) return 0;
  return Math.max(0, Math.min(100, Math.round(s * 10)));
}

/** @returns {"HIGH"|"MEDIUM"|"LOW"|null} null if score is not a finite number */
export function rollingRiskFromScore0to10(score) {
  const s = Number(score);
  if (!Number.isFinite(s)) return null;
  const p = rollingPercentFromScore0to10(s);
  if (p >= RISK_PERCENT_HIGH_MIN) return "HIGH";
  if (p > RISK_PERCENT_LOW_MAX) return "MEDIUM";
  return "LOW";
}
