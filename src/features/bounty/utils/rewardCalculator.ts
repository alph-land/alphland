// Reward calculation utilities
import { Reward, TieredReward } from "../types";

export const TIER_PERCENTAGES_3 = [
  { position: 1, percentage: 0.5 }, // 50%
  { position: 2, percentage: 0.3 }, // 30%
  { position: 3, percentage: 0.2 }, // 20%
];

export const TIER_PERCENTAGES_5 = [
  { position: 1, percentage: 0.4 }, // 40%
  { position: 2, percentage: 0.25 }, // 25%
  { position: 3, percentage: 0.15 }, // 15%
  { position: 4, percentage: 0.1 }, // 10%
  { position: 5, percentage: 0.1 }, // 10%
];

export const TIER_PERCENTAGES_10 = [
  { position: 1, percentage: 0.25 }, // 25%
  { position: 2, percentage: 0.18 }, // 18%
  { position: 3, percentage: 0.14 }, // 14%
  { position: 4, percentage: 0.11 }, // 11%
  { position: 5, percentage: 0.09 }, // 9%
  { position: 6, percentage: 0.07 }, // 7%
  { position: 7, percentage: 0.06 }, // 6%
  { position: 8, percentage: 0.04 }, // 4%
  { position: 9, percentage: 0.03 }, // 3%
  { position: 10, percentage: 0.03 }, // 3%
];

export function generateTieredRewards(
  reward: Reward,
  tierCount: number = 5,
): TieredReward[] {
  const totalAmount = reward.amount;
  let percentages;

  switch (tierCount) {
    case 3:
      percentages = TIER_PERCENTAGES_3;
      break;
    case 10:
      percentages = TIER_PERCENTAGES_10;
      break;
    case 5:
    default:
      percentages = TIER_PERCENTAGES_5;
      break;
  }

  return percentages.map((tier) => ({
    position: tier.position,
    percentage: tier.percentage,
    amount: Math.round(totalAmount * tier.percentage),
    token: reward.token,
    usd_equivalent: Math.round(reward.usd_equivalent * tier.percentage),
  }));
}

export function formatRewardAmount(amount: number, token: string): string {
  return `${amount.toLocaleString()} ${token}`;
}

export function formatUSDAmount(amount: number): string {
  return `$${amount.toLocaleString()}`;
}

/**
 * One-line reward label for lists. A USD-denominated bounty promises the USD
 * figure and its ALPH amount is re-derived at each daily valuation, so it
 * leads with USD and marks ALPH as approximate. Everything else promises the
 * ALPH amount and shows only that.
 */
export function formatBountyReward(r: {
  denomination?: string | null;
  amount: number;
  token?: string | null;
  usd?: number | null;
}): string {
  const token = r.token || "ALPH";
  if (r.denomination === "usd" && r.usd) {
    return `${formatUSDAmount(r.usd)} (≈ ${formatRewardAmount(Math.round(r.amount), token)})`;
  }
  return formatRewardAmount(r.amount, token);
}
