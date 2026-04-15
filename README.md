# Stitch Estimator

SaaS for embroidery stitch-count estimates. Upload artwork, preview it as stitches, save projects.

Built on Next.js 16 (App Router) + Supabase (auth + Postgres + storage) + Tailwind v4.

## Quick start

### 1. Install

```bash
npm install
```

### 2. Supabase setup

Go to your Supabase project dashboard.

**a. Run the schema.** Open the SQL editor and paste the contents of [`supabase/schema.sql`](./supabase/schema.sql). This creates:

- `public.projects` table with per-user RLS
- `art` storage bucket (private) with per-user folder policies

**b. Confirm auth is enabled.** In **Authentication → Providers**, make sure **Email** is on. For dev, you may want to disable "Confirm email" under **Authentication → Sign In / Providers → Email** so signup-then-login works without a mail round-trip.

### 3. Environment variables

Copy `.env.local.example` to `.env.local` and fill in:

- `NEXT_PUBLIC_SUPABASE_URL` — from Supabase → Settings → API
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` — the publishable / anon key
- `SUPABASE_SECRET_KEY` — the secret / service-role key (server-only)

### 4. Run

```bash
npm run dev
```

Open http://localhost:3000.

## Deploy to Vercel

1. Push to GitHub.
2. Import the repo at [vercel.com/new](https://vercel.com/new).
3. Add the three env vars from step 3 above in the Vercel project settings (Production + Preview).
4. Deploy.

## Project layout

```
src/
  app/
    (auth)/               login + signup pages + server actions
    app/                  authenticated area (dashboard + estimator)
    page.tsx              marketing landing
  lib/supabase/           browser, server, and proxy Supabase clients
  proxy.ts                session refresh + route protection (was middleware.ts in Next ≤15)
supabase/
  schema.sql              DB + storage setup
```
