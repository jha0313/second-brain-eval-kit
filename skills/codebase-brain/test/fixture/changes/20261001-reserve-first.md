---
type: fix
title_en: "Reserve credits before the model call"
---
- A run could start with no credits; `reserve` now runs first and throws InsufficientCredits (#12).
- Shipped in build 4e5f6a7b; it replaces the old src/lib/legacy-credits.ts.
- The route (Next.js) answers with NextResponse.json() and its snapshot lives in __tests__/charge.test.ts.snap.
- The old handler app/api/run/[id]/route.ts was folded into app/api/run/route.ts.
