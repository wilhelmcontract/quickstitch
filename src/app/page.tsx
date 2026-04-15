import Link from "next/link";
import { createClient } from "@/lib/supabase/server";

export default async function Home() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return (
    <div className="flex flex-1 flex-col bg-zinc-50 dark:bg-zinc-950">
      <header className="flex items-center justify-between px-6 py-5 max-w-6xl w-full mx-auto">
        <Link href="/" className="font-semibold tracking-tight">
          Stitch Estimator
        </Link>
        <nav className="flex items-center gap-3 text-sm">
          {user ? (
            <Link
              href="/app"
              className="rounded-md bg-zinc-900 px-4 py-2 text-zinc-50 font-medium hover:bg-zinc-800 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
            >
              Open app
            </Link>
          ) : (
            <>
              <Link href="/login" className="font-medium">
                Sign in
              </Link>
              <Link
                href="/signup"
                className="rounded-md bg-zinc-900 px-4 py-2 text-zinc-50 font-medium hover:bg-zinc-800 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
              >
                Get started
              </Link>
            </>
          )}
        </nav>
      </header>

      <main className="flex-1 flex flex-col items-center justify-center px-6 text-center">
        <div className="max-w-2xl py-24">
          <p className="text-sm font-medium uppercase tracking-wider text-zinc-500">
            For embroiderers &amp; decorators
          </p>
          <h1 className="mt-4 text-4xl sm:text-5xl font-semibold tracking-tight leading-tight">
            Instant stitch count estimates from any artwork.
          </h1>
          <p className="mt-6 text-lg text-zinc-600 dark:text-zinc-400">
            Upload a logo or design, preview it rendered as stitches, and quote
            jobs in seconds. Full digitizing tools coming soon.
          </p>
          <div className="mt-10 flex items-center justify-center gap-3">
            <Link
              href={user ? "/app" : "/signup"}
              className="rounded-md bg-zinc-900 px-6 py-3 text-zinc-50 font-medium hover:bg-zinc-800 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
            >
              {user ? "Open app" : "Start free"}
            </Link>
            {!user && (
              <Link
                href="/login"
                className="rounded-md border border-zinc-300 dark:border-zinc-700 px-6 py-3 font-medium hover:bg-zinc-100 dark:hover:bg-zinc-900"
              >
                Sign in
              </Link>
            )}
          </div>
        </div>

        <div className="grid gap-6 sm:grid-cols-3 max-w-4xl w-full pb-24 text-left">
          {[
            {
              title: "Upload any artwork",
              body: "PNG, JPG, or SVG. Drop a logo and see it in seconds.",
            },
            {
              title: "Stitch-view preview",
              body: "We render your art as cross-stitches at the density you choose.",
            },
            {
              title: "Quote faster",
              body: "Get an estimated stitch count to price jobs on the spot.",
            },
          ].map((f) => (
            <div
              key={f.title}
              className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-6"
            >
              <h3 className="font-semibold">{f.title}</h3>
              <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
                {f.body}
              </p>
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}
