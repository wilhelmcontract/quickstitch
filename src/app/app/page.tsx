import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { deleteProject } from "./actions";

type Project = {
  id: string;
  name: string;
  stitch_count: number | null;
  grid_w: number | null;
  grid_h: number | null;
  created_at: string;
};

export default async function Dashboard() {
  const supabase = await createClient();
  const { data: projects } = await supabase
    .from("projects")
    .select("id, name, stitch_count, grid_w, grid_h, created_at")
    .order("created_at", { ascending: false });

  const list: Project[] = projects ?? [];

  return (
    <div className="max-w-6xl mx-auto px-6 py-10">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            Your saved stitch estimates.
          </p>
        </div>
        <Link
          href="/app/estimate"
          className="rounded-md bg-zinc-900 px-4 py-2 text-sm text-zinc-50 font-medium hover:bg-zinc-800 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
        >
          New estimate
        </Link>
      </div>

      {list.length === 0 ? (
        <div className="mt-10 rounded-xl border border-dashed border-zinc-300 dark:border-zinc-700 p-12 text-center">
          <p className="text-zinc-600 dark:text-zinc-400">
            No projects yet. Start by creating your first estimate.
          </p>
          <Link
            href="/app/estimate"
            className="mt-4 inline-block rounded-md bg-zinc-900 px-4 py-2 text-sm text-zinc-50 font-medium hover:bg-zinc-800 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
          >
            New estimate
          </Link>
        </div>
      ) : (
        <ul className="mt-8 grid gap-3">
          {list.map((p) => (
            <li
              key={p.id}
              className="flex items-center justify-between rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4"
            >
              <div>
                <p className="font-medium">{p.name}</p>
                <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
                  {p.stitch_count?.toLocaleString() ?? "—"} stitches
                  {p.grid_w && p.grid_h ? ` · ${p.grid_w}×${p.grid_h}` : ""}
                  {" · "}
                  {new Date(p.created_at).toLocaleDateString()}
                </p>
              </div>
              <form action={deleteProject}>
                <input type="hidden" name="id" value={p.id} />
                <button
                  type="submit"
                  className="rounded-md border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-sm font-medium hover:bg-zinc-100 dark:hover:bg-zinc-800"
                >
                  Delete
                </button>
              </form>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
