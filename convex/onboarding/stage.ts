// The Preparation screen's stage, from the stored inspection and preparation. No imports, so tests load it.

type Inspection = {
  status: "running" | "done" | "failed";
  stack?: { supported: boolean };
  items: { status: "found" | "missing" | "unknown" }[];
  hasManifest?: boolean;
};
type Preparation = {
  neverBreak: { addCheck: boolean }[];
  answeredAt?: number;
  approvedAt?: number;
  openError?: string;
  number?: number;
  snapshot?: { state: "open" | "merged" | "closed" };
  mergedAt?: number;
  registration?: { status: "checking" | "done" | "failed" };
};

export function hasWork(inspection: Inspection, preparation: Preparation) {
  return inspection.items.some((item) => item.status !== "found") || !inspection.hasManifest || preparation.neverBreak.some((item) => item.addCheck);
}

export function stageOf(inspection: Inspection | null, preparation: Preparation) {
  if (preparation.registration) return preparation.registration.status === "checking" ? "registering" : "registered";
  if (preparation.mergedAt !== undefined) return "registering";
  if (preparation.snapshot?.state === "closed") return "closed";
  if (preparation.openError) return "opening_failed";
  if (preparation.number !== undefined && preparation.snapshot) return "pr_open";
  if (preparation.approvedAt !== undefined) return "opening";
  if (!inspection || inspection.status === "running") return "inspecting";
  if (inspection.status === "failed") return "inspection_failed";
  if (!inspection.stack?.supported) return "unsupported";
  if (preparation.answeredAt === undefined) return "asking";
  return hasWork(inspection, preparation) ? "ready" : "nothing_to_add";
}
