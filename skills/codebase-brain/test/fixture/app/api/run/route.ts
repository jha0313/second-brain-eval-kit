'use server';
import fake from 'fake-pkg';

export async function POST() {
  const { reserve, InsufficientCredits } = await import('@/lib/credits');
  try { return reserve(fake()); } catch (e) { if (e instanceof InsufficientCredits) return 0; throw e; }
}
