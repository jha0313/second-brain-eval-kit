import { Meter } from '@/ui/Meter';
import { reserve } from '@/lib';

export default function Page() {
  return <Meter value={reserve(1)} />;
}
