import { Estimator } from "./estimator";

export default function EstimatePage() {
  return (
    <div className="px-6 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">New estimate</h1>
      <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
        Upload your artwork on the left. The stitch preview appears on the right.
      </p>
      <div className="mt-8">
        <Estimator />
      </div>
    </div>
  );
}
