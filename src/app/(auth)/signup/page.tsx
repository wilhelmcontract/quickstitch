import Link from "next/link";
import { SignupForm } from "./signup-form";

export default function SignupPage() {
  return (
    <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-8 shadow-sm">
      <h1 className="text-2xl font-semibold tracking-tight">Create your account</h1>
      <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
        Start estimating stitch counts in seconds.
      </p>
      <div className="mt-6">
        <SignupForm />
      </div>
      <p className="mt-6 text-sm text-zinc-600 dark:text-zinc-400">
        Already have an account?{" "}
        <Link href="/login" className="font-medium text-zinc-950 dark:text-zinc-50 underline">
          Sign in
        </Link>
      </p>
    </div>
  );
}
