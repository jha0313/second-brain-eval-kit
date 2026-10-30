# Credits

Every paid call goes through `reserve` in src/lib/credits.ts. We throw InsufficientCredits instead of
returning false because the route must stop before any model call (see #12).

Every widget and job exports its own `displayName`, so a doc that names one links to none of them.
