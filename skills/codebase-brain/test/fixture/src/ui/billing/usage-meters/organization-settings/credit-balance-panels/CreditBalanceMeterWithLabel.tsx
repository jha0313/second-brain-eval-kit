import { Meter } from '@/ui/Meter';

// a path longer than any table column: refs must print it whole
export function CreditBalanceMeterWithLabel({ value }: { value: number }) {
  return <label>credits <Meter value={value} /> <Meter value={value * 2} /></label>;
}
