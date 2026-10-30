# Credits

Every paid call goes through `reserve` in src/lib/credits.ts. We throw InsufficientCredits instead of
returning false because the route must stop before any model call (see #12).
