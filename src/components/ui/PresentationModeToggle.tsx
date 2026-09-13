"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import type { PresentationMode } from "@/lib/accounting/presentation-mode";
import { presentationModeLabel } from "@/lib/ux/presentation-mode";

export function PresentationModeToggle({ mode }: { mode: PresentationMode }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  async function toggle() {
    const next: PresentationMode = mode === "owner" ? "accountant" : "owner";
    await fetch("/api/ux/presentation-mode", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: next }),
    });
    startTransition(() => router.refresh());
  }

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={pending}
      className="rounded-lg border border-white/20 px-3 py-2 text-left text-xs text-white/80 hover:bg-white/8"
      title="Switch between plain-language owner view and full accountant terminology"
    >
      <span className="block text-[10px] uppercase tracking-wider text-white/45">View</span>
      <span className="font-medium text-white">{presentationModeLabel(mode)}</span>
    </button>
  );
}
