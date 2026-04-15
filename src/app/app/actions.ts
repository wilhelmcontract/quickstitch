"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export async function deleteProject(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  if (!id) return;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: project } = await supabase
    .from("projects")
    .select("storage_path")
    .eq("id", id)
    .single();

  if (project?.storage_path) {
    await supabase.storage.from("art").remove([project.storage_path]);
  }

  await supabase.from("projects").delete().eq("id", id);
  revalidatePath("/app");
}

export type SaveProjectInput = {
  name: string;
  stitchCount: number;
  gridW: number;
  gridH: number;
  artBlob: Blob;
  artExt: string;
};

export async function saveProject(formData: FormData) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const name = String(formData.get("name") ?? "").trim() || "Untitled";
  const stitchCount = Number(formData.get("stitchCount") ?? 0);
  const gridW = Number(formData.get("gridW") ?? 0);
  const gridH = Number(formData.get("gridH") ?? 0);
  const file = formData.get("art");

  if (!(file instanceof File) || file.size === 0) {
    return { error: "Artwork file is required." };
  }

  const ext = file.name.split(".").pop()?.toLowerCase() || "png";
  const storagePath = `${user.id}/${crypto.randomUUID()}.${ext}`;

  const { error: uploadErr } = await supabase.storage
    .from("art")
    .upload(storagePath, file, {
      contentType: file.type || "image/png",
      upsert: false,
    });

  if (uploadErr) {
    return { error: `Upload failed: ${uploadErr.message}` };
  }

  const { error: insertErr } = await supabase.from("projects").insert({
    user_id: user.id,
    name,
    storage_path: storagePath,
    stitch_count: stitchCount,
    grid_w: gridW,
    grid_h: gridH,
  });

  if (insertErr) {
    await supabase.storage.from("art").remove([storagePath]);
    return { error: `Save failed: ${insertErr.message}` };
  }

  revalidatePath("/app");
  redirect("/app");
}
