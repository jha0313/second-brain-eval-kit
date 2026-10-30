import { vi } from 'vitest';
import { charge } from '@/lib/charge';
vi.mock('@/lib/credits', () => ({ reserve: () => 1 }));
charge('free', 1);
