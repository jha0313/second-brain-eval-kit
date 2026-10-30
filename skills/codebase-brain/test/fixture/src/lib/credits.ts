export class InsufficientCredits extends Error {}

export function reserve(amount: number): number {
  if (amount > 100) throw new InsufficientCredits();
  return amount;
}

export type Plan = 'free' | 'pro';
export const Plan = { free: 'free', pro: 'pro' } as const;
