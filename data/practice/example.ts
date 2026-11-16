import { useMemo, useSyncExternalStore } from "react";
import { PRACTICE_PROJECT_ID, practiceCase, practiceProject } from "../example/practice";
import * as store from "../example/store";
import type { Practice, PracticeFailure } from "./types";

// The example build's practice app, in memory. The example build has no backend and no accounts, so the practice app is
// offered here for the screens to be seen and tried: Create adds it to the example projects, Break opens its issue a
// moment later, and approving the fix plays it through as any example fix does. Nothing leaves the device.

const BREAKS_PER_DAY = 10;
const OPEN = ["new", "investigating", "needs_approval", "enacting", "ready_to_merge"];
const NOTICE_MS = 1500;

let made = false;
let failure: PracticeFailure | null = null;
let lastFailure: PracticeFailure | null = null;
let brokenAt: number | undefined;
let caseId: string | undefined;
let breaks = 0;
let cases = 0;

const words = {
  alreadyBroken: "Your practice app is already broken. turtl notices within a minute or two and opens an issue under Fix.",
  caseOpen: "turtl is already working on an issue on your practice app. Finish it first: approve or decline its fixes under Fix.",
  caseOpenMend: "turtl is working on an issue on your practice app. Decline its fixes under Fix first if you want to put it back yourself.",
  limit: `You have broken your practice app ${BREAKS_PER_DAY} times today, the most for one day. You can break it again tomorrow.`,
  notPractice: "That project is not a practice app.",
};

const statusOf = (id: string | undefined) => (id ? store.getCase(id)?.status : undefined);

function snapshot(): Practice {
  if (!made) return { available: true, breaksPerDay: BREAKS_PER_DAY, project: null };
  const status = statusOf(caseId);
  const open = status !== undefined && OPEN.includes(status);
  // A fixed issue leaves the practice app working, with what the fix switched; a declined one leaves it broken.
  const fixed = status === "resolved";
  const now = fixed ? null : failure;
  const note = fixed ? (lastFailure === "recommendations" ? "Recommendations are off since turtl's last fix." : "Bookings go to the backup store since turtl's last fix.") : undefined;
  return {
    available: true,
    breaksPerDay: BREAKS_PER_DAY,
    project: {
      projectId: PRACTICE_PROJECT_ID,
      name: practiceProject.name,
      failure: now,
      ...(now && brokenAt !== undefined && { brokenAt }),
      ...(open && caseId && { caseId }),
      breaksLeft: BREAKS_PER_DAY - breaks,
      ...(note && { note }),
    },
  };
}

export function usePractice(): Practice | undefined {
  const version = useSyncExternalStore(store.subscribe, store.getVersion, store.getVersion);
  return useMemo(snapshot, [version]);
}

export async function createPractice(): Promise<{ projectId: string }> {
  if (!made) {
    made = true;
    store.addProjectSeed(practiceProject);
  }
  return { projectId: PRACTICE_PROJECT_ID };
}

export async function breakPractice(projectId: string, chosen: PracticeFailure): Promise<void> {
  if (!made || projectId !== PRACTICE_PROJECT_ID) throw new Error(words.notPractice);
  const current = snapshot().project!;
  if (current.failure) throw new Error(words.alreadyBroken);
  if (current.caseId) throw new Error(words.caseOpen);
  if (breaks >= BREAKS_PER_DAY) throw new Error(words.limit);
  breaks += 1;
  failure = chosen;
  lastFailure = chosen;
  brokenAt = Date.now();
  caseId = undefined;
  store.addProjectSeed(practiceProject);
  // turtl's next check notices: the issue arrives a moment later, as on a live backend.
  setTimeout(() => {
    cases += 1;
    const item = practiceCase(chosen, cases, Date.now());
    caseId = item.id;
    store.addCase(item);
  }, NOTICE_MS);
}

export async function mendPractice(projectId: string): Promise<void> {
  if (!made || projectId !== PRACTICE_PROJECT_ID) throw new Error(words.notPractice);
  if (snapshot().project?.caseId) throw new Error(words.caseOpenMend);
  failure = null;
  brokenAt = undefined;
  caseId = undefined;
  store.addProjectSeed(practiceProject);
}
