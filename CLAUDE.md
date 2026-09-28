# Kanabco Room Designer

- Next.js 16 App Router. Read the relevant guide in `node_modules/next/dist/docs/` before changing framework APIs.
- The live public route must keep the 13 ordered checks in `src/app/api/room-design/route.ts`, its Redis fail-closed guards, and the server-only OpenAI key. Never put secrets in a client bundle, source control, or test outputs.
- `scripts/local-e2e/` is a loopback-only development harness. Cloudflare dummy keys and `KANABCO_LOCAL_TURNSTILE_TEST=true` must never be used in public deployment.
- Beds, kitchens, wardrobes, dressers, and dressing rooms are exploratory concepts, not confirmed Kanabco product lines. The AI result has no automatic price or order promise.
- Run `npm run typecheck`, `npm test`, and `npm run build` after changes. Use a disposable Redis container for the separate integration suite; never point it at a shared Redis database.
- Keep `.env.local` gitignored. Share deployment access through the owner's project and hosting secret manager, never through this repository.
