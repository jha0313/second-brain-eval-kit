import { reserve, type Plan } from './credits';

export function charge(plan: Plan, n: number) {
  return reserve(n);
}
