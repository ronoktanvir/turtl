import type { CaseDetail, CodeNetwork, CodeRef, FixOption, Project, PullRequest, Screenshot, Span } from "../types";
import { shots } from "./screenshots";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const started = Date.now();
const ago = (ms: number) => started - ms;

type Part = string | [text: string, cite: string];
const spans = (...parts: Part[]): Span[] =>
  parts.map((part) => (typeof part === "string" ? { text: part } : { text: part[0], cite: part[1] }));

export type ProjectSeed = Pick<
  Project,
  "id" | "name" | "iconUrl" | "summary" | "repoUrl" | "productionUrl" | "approvals"
>;

export const projectSeeds: ProjectSeed[] = [
  {
    id: "still-booking-demo",
    name: "Still booking demo",
    summary: "A salon's booking app. Customers pick a service and a time, then book.",
    repoUrl: "https://github.com/turtl-demo/still-booking-demo",
    productionUrl: "https://still-booking-demo.example.com",
    approvals: "you",
  },
  {
    id: "guardian",
    name: "Guardian",
    summary: "Shows a family whether the doors and gates at home are locked.",
    repoUrl: "https://github.com/turtl-demo/guardian",
    productionUrl: "https://guardian.example.com",
    approvals: "you",
  },
  {
    id: "tide-journal",
    name: "Tide journal",
    summary: "A one-line-a-day journal.",
    repoUrl: "https://github.com/turtl-demo/tide-journal",
    productionUrl: "https://tide-journal.example.com",
    approvals: "auto",
  },
];

export type StepSeed = {
  key: string;
  title: string;
  detail: string;
  summary: string;
  ms?: number;
  effect?: "open_pr" | "checks" | "merge_gate";
  question?: { text: string; fixes: FixOption[] };
};

const pullRequestSteps = (what: string, verify: string): StepSeed[] => [
  {
    key: "write",
    title: "Write the change",
    detail: what,
    summary: "The change is written and matches the evidence in this case.",
    ms: 2200,
  },
  {
    key: "open_pr",
    title: "Open a pull request",
    detail: "turtl puts the change on its own branch and opens a pull request. Nothing reaches customers until you merge.",
    summary: "Pull request opened.",
    ms: 1600,
    effect: "open_pr",
  },
  {
    key: "checks",
    title: "Run the checks",
    detail: "The project's own checks run on the change, then turtl runs the journey on a test phone.",
    summary: "Every check passed.",
    ms: 1300,
    effect: "checks",
  },
  {
    key: "merge",
    title: "Merge and deploy",
    detail: "This step waits for you. Once you merge, the change goes live.",
    summary: "Merged and live.",
    ms: 2000,
    effect: "merge_gate",
  },
  {
    key: "verify",
    title: verify,
    detail: "turtl walks through the live app the way a customer would and keeps the screenshots.",
    summary: "Checked on the live app. It works.",
    ms: 2000,
  },
];

const slowProviderQuestion: StepSeed["question"] = {
  text: "The new check needs a slow provider to test against, and the real one can't be slowed down safely. How should turtl do it?",
  fixes: [
    {
      key: "recorded_slow_response",
      title: "Replay today's slow responses",
      kind: "prevention",
      recommended: true,
      why: spans(
        "turtl kept the provider's answers from today's outage. Replaying them makes the check fail in exactly the way customers saw, without touching the real provider.",
      ),
      whatChanges: "The check uses a recording of today's slow answers.",
      whatMightBeLost: "If the provider fails in a new way later, this check won't know about it.",
      howChecked: "The check must fail on today's code and pass once booking no longer waits.",
    },
    {
      key: "test_delay_switch",
      title: "Add a delay switch for tests",
      kind: "prevention",
      recommended: false,
      why: spans("A switch that only exists in tests can slow any provider down on demand, so future checks can reuse it."),
      whatChanges: "Adds a small test-only setting to the app's code.",
      whatMightBeLost: "It is more code to keep, and it takes a little longer to build.",
      howChecked: "The check must fail on today's code and pass once booking no longer waits.",
    },
  ],
};

const plans: Record<string, StepSeed[]> = {
  turn_off_recommendations: [
    {
      key: "flag",
      title: "Turn off recommendations",
      detail: "Switches the recommendations setting off. The booking screen stops asking the provider for suggestions.",
      summary: "Recommendations are off.",
      ms: 1800,
    },
    {
      key: "journey",
      title: "Run the booking journey",
      detail: "turtl opens the app the way a customer would and walks through a booking.",
      summary: "The booking form appears in under a second.",
      ms: 2200,
    },
    {
      key: "test_booking",
      title: "Save a test booking",
      detail: "turtl books a test appointment, confirms it was saved, then removes it.",
      summary: "Test booking saved and removed.",
      ms: 2000,
    },
    {
      key: "watch",
      title: "Watch the next real bookings",
      detail: "turtl watches real customers for new failures before calling this fixed.",
      summary: "No new failures. Customers are booking again.",
      ms: 2200,
    },
  ],
  load_recommendations_async: pullRequestSteps(
    "Changes the booking screen so the form shows straight away and suggestions are added when they arrive.",
    "Run the booking journey on the live app",
  ),
  recommendations_time_limit: pullRequestSteps(
    "Changes the booking screen to wait at most two seconds for suggestions, then carry on without them.",
    "Run the booking journey on the live app",
  ),
  check_slow_provider: [
    {
      key: "write",
      title: "Write the check",
      detail: "A new check that walks through booking while the recommendations provider answers slowly.",
      summary: "The check is written.",
      ms: 2000,
    },
    {
      key: "try",
      title: "Try it against a slow provider",
      detail: "The check has to fail on today's code, or it would not have caught this outage.",
      summary: "The check fails on today's code, as it should.",
      ms: 2200,
      question: slowProviderQuestion,
    },
    ...pullRequestSteps("", "Confirm the check runs on the next change").slice(1),
  ],
};

export function planFor(fix: FixOption): StepSeed[] {
  return (
    plans[fix.key] ??
    pullRequestSteps(fix.whatChanges, fix.kind === "change" ? "Take the after screenshots" : "Check it on the live app")
  );
}

const learned: Record<string, string> = {
  turn_off_recommendations:
    "When the recommendations provider is slow, turning recommendations off gets customers booking again in under a minute. turtl will offer this first next time.",
  load_recommendations_async:
    "Booking should never wait on recommendations. With this change a slow provider only hides suggestions; it can no longer stop a booking.",
  check_slow_provider:
    "A check with a slow provider would have caught this before customers did. It now runs on every change to the booking screen.",
};

export function learnedFor(fix: FixOption): string {
  return learned[fix.key] ?? '"' + fix.title + '" worked and was checked on the live app. turtl will reach for it sooner next time.';
}

export function pullRequestFor(c: CaseDetail, fix: FixOption): PullRequest {
  const repo = "turtl-demo/" + c.projectId;
  const number = 40 + c.number;
  return {
    repo,
    number,
    title: fix.title,
    url: "https://github.com/" + repo + "/pull/" + number,
    headSha: "9f2c1ab",
    state: "open",
    checks: "pending",
    checkRuns: [
      { name: "Typecheck", status: "pending" },
      { name: "Tests", status: "pending" },
      { name: c.type === "fix" ? "Journey on a test phone" : "Screenshots on a test phone", status: "pending" },
    ],
    mergeable: false,
  };
}

const after: Record<string, Screenshot[]> = {
  "booking-10": [
    {
      id: "s-10-after",
      url: shots.bookingRestored,
      caption: "After the fix: turtl's test booking went through.",
      phase: "after",
      takenAt: started,
    },
  ],
};

export function afterShots(caseId: string): Screenshot[] {
  return (after[caseId] ?? []).map((shot) => ({ ...shot, takenAt: Date.now() }));
}

export const proposals: Record<string, { text: string; fix: FixOption; code?: CodeRef }> = {
  "booking-10": {
    text: "Here is one more option. It keeps suggestions on, but stops them from holding up a booking for more than two seconds.",
    fix: {
      key: "recommendations_time_limit",
      title: "Give recommendations two seconds, then carry on",
      kind: "repair",
      recommended: false,
      proposedInChat: true,
      why: spans(
        "If you would rather keep suggestions on, ",
        ["the booking screen can stop waiting after two seconds", "c-limit"],
        " and show the form without them. Customers on a good day see no difference.",
      ),
      whatChanges: "A small code change to the booking screen, shipped as a pull request that you merge.",
      whatMightBeLost:
        "On a slow day customers wait two seconds and then see no suggestions. Customers stay blocked until you merge.",
      howChecked: "The project's checks run on the pull request, then turtl runs the booking journey on a test phone.",
      confidence: 0.78,
      codeIds: ["code-limit"],
    },
    code: {
      id: "code-limit",
      path: "app/booking/BookingScreen.tsx",
      startLine: 41,
      language: "tsx",
      before: "const suggestions = await getRecommendations(service.id);\nsetSuggestions(suggestions);\nsetReady(true);",
      after:
        "const suggestions = await Promise.race([\n  getRecommendations(service.id),\n  wait(2000).then(() => []),\n]);\nsetSuggestions(suggestions);\nsetReady(true);",
      note: "The booking screen would wait two seconds at most, then show the form with no suggestions.",
    },
  },
};

export const caseReplies: Record<string, string[]> = {
  "booking-10": [
    "The booking screen asks an outside provider for service suggestions and waits for the answer before it shows the form. Since about 12 minutes ago that answer has been taking longer than the 10 seconds the app allows, so the form never appears.",
    "Nothing you shipped caused this: the last change to the booking screen was nine days ago. The provider slowed down on its own.",
    "Bookings that were already saved are untouched. The only thing customers can't do right now is make a new one.",
  ],
  default: [
    "Here is what I know so far: the evidence in Overview is everything I have found, and each highlighted phrase opens the log line or code behind it.",
    "I have not seen this exact problem in this project before, so I am being careful about what I recommend.",
    "If you want a different approach, tap New fix and I will look for one.",
  ],
};

const series = [0.3, 0.3, 0.4, 0.3, 0.4, 0.6, 1.8, 6.5, 10, 10, 10, 10];

const booking10: CaseDetail = {
  id: "booking-10",
  projectId: "still-booking-demo",
  type: "fix",
  number: 10,
  title: "Customers can't complete bookings",
  category: "outage",
  status: "needs_approval",
  health: "affected",
  happenedAt: ago(12 * MIN),
  reportCount: 14,
  summary: "Customers can't book right now. The booking screen is stuck waiting for recommendations.",
  overview: [
    {
      kind: "paragraph",
      spans: spans(
        "For the last 12 minutes, customers who open the booking screen have been getting stuck. The screen waits for service suggestions, and ",
        ["the recommendations provider is timing out", "c-timeout"],
        ".",
      ),
    },
    {
      kind: "visualization",
      title: "Where the booking journey stops",
      viz: {
        type: "journey",
        steps: [
          { label: "Open the app", state: "passed" },
          { label: "Choose a service", state: "passed" },
          { label: "Recommendations", state: "failed" },
          { label: "Choose a time", state: "not_reached" },
          { label: "Confirm booking", state: "not_reached" },
        ],
      },
    },
    {
      kind: "paragraph",
      spans: spans(
        "The booking screen ",
        ["waits for suggestions before it shows the form", "c-await"],
        ". When the provider is slow the form never appears, so nobody can finish a booking. turtl's own check of the journey ",
        ["failed at the same step", "c-journey"],
        ".",
      ),
    },
    {
      kind: "visualization",
      title: "How long recommendations take to answer",
      viz: {
        type: "series",
        label: "Answer time",
        unit: "s",
        points: series.map((v, i) => ({ t: ago((series.length - 1 - i) * 3 * MIN), v })),
        markerAt: ago(12 * MIN),
      },
    },
    {
      kind: "paragraph",
      spans: spans(
        "Bookings already made are safe. Nothing has been changed yet: turtl is waiting for you to choose a fix.",
      ),
    },
  ],
  citations: [
    { id: "c-timeout", kind: "log", logId: "l-10-4" },
    { id: "c-journey", kind: "log", logId: "l-10-6" },
    { id: "c-await", kind: "code", codeId: "code-await" },
    { id: "c-flag", kind: "code", codeId: "code-flag" },
    { id: "c-check", kind: "code", codeId: "code-check" },
    { id: "c-limit", kind: "code", codeId: "code-limit" },
  ],
  logs: [
    { id: "l-10-1", at: ago(31 * MIN), level: "info", source: "Booking app", text: "Recommendations answered in 0.3s" },
    { id: "l-10-2", at: ago(16 * MIN), level: "warn", source: "Booking app", text: "Recommendations answered in 1.8s (slow)" },
    { id: "l-10-3", at: ago(13 * MIN), level: "warn", source: "Recommendations provider", text: "Answers are taking longer than 5s" },
    {
      id: "l-10-4",
      at: ago(12 * MIN),
      level: "error",
      source: "Booking app",
      text: "RECOMMENDATIONS_TIMEOUT: The recommendation provider timed out. Your booking was not saved.",
    },
    { id: "l-10-5", at: ago(12 * MIN), level: "error", source: "Booking app", text: "Booking journey stopped at step: recommendations" },
    {
      id: "l-10-6",
      at: ago(11 * MIN),
      level: "error",
      source: "turtl check",
      text: "Booking journey failed at the recommendations step, 3 tries out of 3",
    },
    { id: "l-10-7", at: ago(9 * MIN), level: "error", source: "Booking app", text: "RECOMMENDATIONS_TIMEOUT again. 14 customers so far." },
    { id: "l-10-8", at: ago(8 * MIN), level: "info", source: "turtl", text: "Opened error #10 and paused for your decision" },
  ],
  code: [
    {
      id: "code-await",
      path: "app/booking/BookingScreen.tsx",
      startLine: 41,
      language: "tsx",
      before: "const suggestions = await getRecommendations(service.id);\nsetSuggestions(suggestions);\nsetReady(true);",
      after: "setReady(true);\ngetRecommendations(service.id)\n  .then(setSuggestions)\n  .catch(() => setSuggestions([]));",
      note: "This is where the booking screen asks for suggestions. Today the form only appears after the answer arrives.",
    },
    {
      id: "code-flag",
      path: "config/features.ts",
      startLine: 7,
      language: "ts",
      before: "recommendations: true,",
      after: "recommendations: false,",
      note: "This setting decides whether the booking screen asks for suggestions at all.",
    },
    {
      id: "code-check",
      path: "checks/booking-journey.test.ts",
      startLine: 18,
      language: "ts",
      before: "// No check covers a slow recommendations provider yet.",
      after:
        'test("booking works when recommendations are slow", async () => {\n  slowDown("recommendations", 8000);\n  await bookHaircut();\n  expect(await bookingSaved()).toBe(true);\n});',
      note: "The checks that run before every release. None of them tries a slow provider.",
    },
  ],
  screenshots: [
    {
      id: "s-10-1",
      url: shots.bookingStuck,
      caption: "The booking screen never gets past loading suggestions.",
      phase: "failure",
      takenAt: ago(11 * MIN),
    },
    {
      id: "s-10-2",
      url: shots.bookingError,
      caption: "After 10 seconds customers see an error and the booking is not saved.",
      phase: "failure",
      takenAt: ago(11 * MIN),
    },
  ],
  fixes: [
    {
      key: "turn_off_recommendations",
      title: "Turn off recommendations",
      kind: "recovery",
      recommended: true,
      why: spans(
        "Booking is stuck because the screen waits for suggestions. ",
        ["One setting turns suggestions off", "c-flag"],
        ", so the booking screen stops waiting for the provider and customers can book again within a minute.",
      ),
      whatChanges: "Turns off service suggestions so booking stops waiting for the provider.",
      whatMightBeLost:
        "Customers won't see suggested services until they are turned back on. Bookings already made don't change. The slow provider itself is not fixed.",
      howChecked: "turtl runs the booking journey and saves a test booking.",
      usersCantNow: "Complete a booking.",
      confidence: 0.92,
      codeIds: ["code-flag"],
    },
    {
      key: "load_recommendations_async",
      title: "Load recommendations without blocking booking",
      kind: "repair",
      recommended: false,
      why: spans(
        "The real fault is that ",
        ["the booking screen waits for suggestions", "c-await"],
        " before it shows the form. This change shows the form first and adds suggestions when they arrive, so a slow provider can never block a booking again.",
      ),
      whatChanges: "A code change to the booking screen, shipped as a pull request that you merge.",
      whatMightBeLost:
        "It is slower than turning recommendations off: customers stay blocked until the checks pass and you merge. Suggestions may appear a moment after the form.",
      howChecked: "The project's checks run on the pull request, then turtl runs the booking journey on a test phone.",
      usersCantNow: "Complete a booking.",
      confidence: 0.84,
      codeIds: ["code-await"],
    },
    {
      key: "check_slow_provider",
      title: "Check the booking journey when the provider is slow",
      kind: "prevention",
      recommended: false,
      why: spans(
        "turtl only noticed this after customers were stuck. ",
        ["A check that books with a slow provider", "c-check"],
        " would catch the same mistake before it ships.",
      ),
      whatChanges: "Adds a check that runs on every change to the booking screen.",
      whatMightBeLost:
        "It does not help the customers who are stuck right now, and every change takes about a minute longer to check.",
      howChecked: "The check must fail on today's code and pass once booking no longer waits.",
      confidence: 0.7,
      codeIds: ["code-check"],
    },
  ],
};

const booking9: CaseDetail = {
  id: "booking-9",
  projectId: "still-booking-demo",
  type: "fix",
  number: 9,
  title: "Confirmation email shows the wrong time",
  category: "bug",
  status: "investigating",
  health: "working",
  happenedAt: ago(3 * HOUR),
  reportCount: 3,
  summary: "Three customers got a confirmation email one hour off. Their bookings are saved at the right time.",
  overview: [
    {
      kind: "paragraph",
      spans: spans(
        "Three customers wrote in because their confirmation email showed a time one hour later than the one they chose. The booking itself is right; only ",
        ["the email is wrong", "c-email"],
        ".",
      ),
    },
    {
      kind: "visualization",
      title: "Where the time goes wrong",
      viz: {
        type: "journey",
        steps: [
          { label: "Customer picks 2:00 PM", state: "passed" },
          { label: "Booking saved at 2:00 PM", state: "passed" },
          { label: "Email says 3:00 PM", state: "failed" },
        ],
      },
    },
    {
      kind: "paragraph",
      spans: spans(
        "The email is written using ",
        ["the server's clock instead of the salon's", "c-zone"],
        ", and the two have been an hour apart since the clocks changed.",
      ),
    },
  ],
  citations: [
    { id: "c-email", kind: "log", logId: "l-9-2" },
    { id: "c-zone", kind: "code", codeId: "code-zone" },
  ],
  logs: [
    { id: "l-9-1", at: ago(3 * HOUR), level: "info", source: "Booking app", text: "Booking saved for Tue 2:00 PM (salon time)" },
    { id: "l-9-2", at: ago(3 * HOUR), level: "warn", source: "Email", text: "Confirmation sent with time Tue 3:00 PM" },
    { id: "l-9-3", at: ago(2 * HOUR), level: "info", source: "Support inbox", text: "\"My email says 3 but I booked 2\" (3 messages)" },
  ],
  code: [
    {
      id: "code-zone",
      path: "lib/confirmationEmail.ts",
      startLine: 22,
      language: "ts",
      before: "const when = formatTime(booking.startsAt);",
      after: "const when = formatTime(booking.startsAt, salon.timeZone);",
      note: "This line writes the time into the confirmation email.",
    },
  ],
  screenshots: [
    {
      id: "s-9-1",
      url: shots.emailWrongTime,
      caption: "The email says 3:00 PM for a booking made at 2:00 PM.",
      phase: "failure",
      takenAt: ago(3 * HOUR),
    },
  ],
  fixes: [
    {
      key: "email_salon_time_zone",
      title: "Write email times in the salon's time zone",
      kind: "repair",
      recommended: true,
      why: spans(
        "The booking is saved correctly, so only the email needs to change. ",
        ["One line picks the wrong clock", "c-zone"],
        "; pointing it at the salon's time zone fixes every email from now on.",
      ),
      whatChanges: "A one-line code change, shipped as a pull request that you merge.",
      whatMightBeLost: "Emails already sent stay wrong. turtl can list the three customers so you can write to them.",
      howChecked: "turtl books a test appointment and reads the time in the email it receives.",
      confidence: 0.88,
      codeIds: ["code-zone"],
    },
    {
      key: "email_time_check",
      title: "Check email times after every clock change",
      kind: "prevention",
      recommended: false,
      why: spans("This appeared when the clocks changed. A check that compares the email with the booking would catch it the same day."),
      whatChanges: "Adds a check to the email tests.",
      whatMightBeLost: "It does not correct today's emails.",
      howChecked: "The check must fail on today's code.",
      confidence: 0.66,
    },
  ],
};

const booking8: CaseDetail = {
  id: "booking-8",
  projectId: "still-booking-demo",
  type: "fix",
  number: 8,
  title: "Service photos load slowly",
  category: "bug",
  status: "investigating",
  health: "working",
  happenedAt: ago(26 * HOUR),
  reportCount: 1,
  summary: "The services page takes about six seconds to show its photos on a phone connection.",
  overview: [
    {
      kind: "paragraph",
      spans: spans(
        "One customer said the services page felt broken. It is not broken, but ",
        ["each photo is far larger than a phone needs", "c-photo"],
        ", so the page takes about six seconds to fill in.",
      ),
    },
    {
      kind: "visualization",
      title: "Time until the photos appear",
      viz: {
        type: "series",
        label: "Load time",
        unit: "s",
        points: [5.8, 6.1, 5.9, 6.4, 6.0, 6.2].map((v, i) => ({ t: ago((6 - i) * 4 * HOUR), v })),
      },
    },
  ],
  citations: [{ id: "c-photo", kind: "log", logId: "l-8-1" }],
  logs: [
    { id: "l-8-1", at: ago(26 * HOUR), level: "warn", source: "Booking app", text: "Service photo is 4.2 MB (shown at 140 points wide)" },
    { id: "l-8-2", at: ago(25 * HOUR), level: "info", source: "turtl check", text: "Services page showed photos after 6.1s on a phone connection" },
  ],
  code: [
    {
      id: "code-photo",
      path: "app/services/ServiceCard.tsx",
      startLine: 12,
      language: "tsx",
      before: "<Image source={{ uri: service.photoUrl }} />",
      after: "<Image source={{ uri: resized(service.photoUrl, 420) }} />",
      note: "This shows each service's photo at full size.",
    },
  ],
  screenshots: [
    {
      id: "s-8-1",
      url: shots.photosSlow,
      caption: "Six seconds in, the photos are still loading.",
      phase: "failure",
      takenAt: ago(25 * HOUR),
    },
  ],
  fixes: [
    {
      key: "resize_service_photos",
      title: "Send photos at the size the phone shows them",
      kind: "repair",
      recommended: true,
      why: spans("The photos are ten times larger than the space they fill. Sending a smaller copy makes the page appear in about a second."),
      whatChanges: "A code change to the services page, shipped as a pull request that you merge.",
      whatMightBeLost: "Photos look the same on a phone. On a large tablet they may look slightly softer.",
      howChecked: "turtl opens the services page on a test phone and times it.",
      confidence: 0.8,
      codeIds: ["code-photo"],
    },
  ],
};

const feature = (
  base: Pick<CaseDetail, "id" | "projectId" | "number" | "title" | "category" | "happenedAt" | "reportCount" | "summary">,
  detail: Pick<CaseDetail, "overview" | "citations" | "logs" | "code" | "screenshots" | "fixes">,
): CaseDetail => ({ ...base, ...detail, type: "feature", status: "investigating", health: "clear" });

const bookingRequest4 = feature(
  {
    id: "booking-r4",
    projectId: "still-booking-demo",
    number: 4,
    title: "Let customers reschedule a booking",
    category: "feature_request",
    happenedAt: ago(2 * DAY),
    reportCount: 9,
    summary: "Nine customers asked to move a booking without cancelling it first.",
  },
  {
    overview: [
      {
        kind: "paragraph",
        spans: spans(
          "Nine customers asked for this in the last month. Today the only way to move a booking is to cancel it and book again, and ",
          ["four of them lost their slot doing that", "c-lost"],
          ".",
        ),
      },
      {
        kind: "visualization",
        title: "What rescheduling takes today",
        viz: {
          type: "journey",
          steps: [
            { label: "Open the booking", state: "passed" },
            { label: "Cancel it", state: "passed" },
            { label: "Find the same slot again", state: "failed" },
          ],
        },
      },
      {
        kind: "paragraph",
        spans: spans("The booking page ", ["only offers Cancel", "c-page"], ". The option below adds Reschedule next to it."),
      },
    ],
    citations: [
      { id: "c-lost", kind: "log", logId: "l-r4-2" },
      { id: "c-page", kind: "code", codeId: "code-reschedule" },
    ],
    logs: [
      { id: "l-r4-1", at: ago(2 * DAY), level: "info", source: "Support inbox", text: "\"Can I just move my appointment?\" (9 messages this month)" },
      { id: "l-r4-2", at: ago(5 * DAY), level: "warn", source: "Booking app", text: "4 customers cancelled and could not rebook the same slot" },
    ],
    code: [
      {
        id: "code-reschedule",
        path: "app/booking/BookingDetail.tsx",
        startLine: 58,
        language: "tsx",
        before: '<Button label="Cancel booking" onPress={cancel} />',
        after: '<Button label="Reschedule" onPress={pickNewTime} />\n<Button label="Cancel booking" onPress={cancel} />',
        note: "The buttons at the bottom of a customer's booking.",
      },
    ],
    screenshots: [
      { id: "s-r4-1", url: shots.rescheduleBefore, caption: "Before: the booking page only offers Cancel.", phase: "before", takenAt: ago(2 * DAY) },
      { id: "s-r4-2", url: shots.rescheduleAfter, caption: "After: Reschedule sits above Cancel.", phase: "after", takenAt: ago(2 * DAY) },
    ],
    fixes: [
      {
        key: "reschedule_button",
        title: "Add Reschedule to the booking page",
        kind: "change",
        recommended: true,
        why: spans(
          "Customers already open the booking page to cancel. ",
          ["Adding Reschedule there", "c-page"],
          " lets them pick a new time and keeps their old slot until the new one is saved.",
        ),
        whatChanges: "A new button and a time picker on the booking page, shipped as a pull request that you merge.",
        whatMightBeLost: "Customers could move a booking at the last minute. turtl keeps your existing 24-hour rule for that.",
        howChecked: "turtl moves a test booking on a test phone and takes before and after screenshots.",
        confidence: 0.82,
        codeIds: ["code-reschedule"],
      },
      {
        key: "reschedule_from_email",
        title: "Add a reschedule link to the confirmation email",
        kind: "change",
        recommended: false,
        why: spans("Some customers never open the app again after booking. A link in the email reaches them where they already are."),
        whatChanges: "A link in the email that opens the time picker.",
        whatMightBeLost: "It is more work, and anyone with the email could move the booking.",
        howChecked: "turtl follows the link from a test email and moves a test booking.",
        confidence: 0.6,
      },
    ],
  },
);

const bookingRequest3 = feature(
  {
    id: "booking-r3",
    projectId: "still-booking-demo",
    number: 3,
    title: "Apple Pay for the deposit",
    category: "feature_request",
    happenedAt: ago(6 * DAY),
    reportCount: 4,
    summary: "Four customers asked to pay the deposit with Apple Pay instead of typing a card number.",
  },
  {
    overview: [
      {
        kind: "paragraph",
        spans: spans(
          "Four customers asked for Apple Pay. The deposit page ",
          ["only takes a typed card number", "c-pay"],
          ", and about one in five people leave at that step.",
        ),
      },
      {
        kind: "visualization",
        title: "People who reach each step",
        viz: {
          type: "series",
          label: "Customers",
          unit: "%",
          points: [100, 86, 81, 64].map((v, i) => ({ t: ago((4 - i) * DAY), v })),
        },
      },
    ],
    citations: [{ id: "c-pay", kind: "code", codeId: "code-pay" }],
    logs: [
      { id: "l-r3-1", at: ago(6 * DAY), level: "info", source: "Support inbox", text: "\"Do you take Apple Pay?\" (4 messages)" },
      { id: "l-r3-2", at: ago(6 * DAY), level: "info", source: "Booking app", text: "17% of customers leave on the deposit page" },
    ],
    code: [
      {
        id: "code-pay",
        path: "app/checkout/Deposit.tsx",
        startLine: 30,
        language: "tsx",
        before: "<CardForm onPaid={confirm} />",
        after: "<ApplePayButton onPaid={confirm} />\n<CardForm onPaid={confirm} />",
        note: "The deposit page, where customers pay before a booking is confirmed.",
      },
    ],
    screenshots: [
      { id: "s-r3-1", url: shots.payBefore, caption: "Before: card only.", phase: "before", takenAt: ago(6 * DAY) },
      { id: "s-r3-2", url: shots.payAfter, caption: "After: Apple Pay above the card form.", phase: "after", takenAt: ago(6 * DAY) },
    ],
    fixes: [
      {
        key: "apple_pay_button",
        title: "Add an Apple Pay button above the card form",
        kind: "change",
        recommended: true,
        why: spans(
          "Your payment provider already supports Apple Pay. ",
          ["The deposit page just doesn't show the button", "c-pay"],
          ".",
        ),
        whatChanges: "A new button on the deposit page, shipped as a pull request that you merge.",
        whatMightBeLost: "Nothing for customers. You will need to switch Apple Pay on in your payment account once.",
        howChecked: "turtl pays a test deposit on a test phone and takes before and after screenshots.",
        confidence: 0.75,
        codeIds: ["code-pay"],
      },
    ],
  },
);

const guardianRequest2 = feature(
  {
    id: "guardian-r2",
    projectId: "guardian",
    number: 2,
    title: "Dark mode",
    category: "feature_request",
    happenedAt: ago(4 * DAY),
    reportCount: 12,
    summary: "Twelve people asked for a dark mode, mostly because they check the app at night.",
  },
  {
    overview: [
      {
        kind: "paragraph",
        spans: spans(
          "Twelve people asked for this. Most of them check their doors last thing at night, and ",
          ["the app is bright white at any hour", "c-colors"],
          ".",
        ),
      },
      {
        kind: "visualization",
        title: "When people open Guardian",
        viz: {
          type: "series",
          label: "Opens",
          unit: "%",
          points: [6, 9, 12, 10, 14, 49].map((v, i) => ({ t: ago((6 - i) * 4 * HOUR), v })),
        },
      },
    ],
    citations: [{ id: "c-colors", kind: "code", codeId: "code-colors" }],
    logs: [
      { id: "l-g2-1", at: ago(4 * DAY), level: "info", source: "App reviews", text: "\"Blinding at night, please add dark mode\" (12 requests)" },
      { id: "l-g2-2", at: ago(4 * DAY), level: "info", source: "Guardian app", text: "49% of opens happen after 9 PM" },
    ],
    code: [
      {
        id: "code-colors",
        path: "theme/colors.ts",
        startLine: 1,
        language: "ts",
        before: 'export const colors = { background: "#ffffff", text: "#1c1e22" };',
        after: "export const colors = useColorScheme() === \"dark\" ? darkColors : lightColors;",
        note: "Every screen takes its colors from this one file.",
      },
    ],
    screenshots: [
      { id: "s-g2-1", url: shots.guardianLight, caption: "Before: one bright theme.", phase: "before", takenAt: ago(4 * DAY) },
      { id: "s-g2-2", url: shots.guardianDark, caption: "After: follows the phone's dark setting.", phase: "after", takenAt: ago(4 * DAY) },
    ],
    fixes: [
      {
        key: "follow_phone_theme",
        title: "Follow the phone's light or dark setting",
        kind: "change",
        recommended: true,
        why: spans(
          "Every screen already takes its colors from ",
          ["one file", "c-colors"],
          ", so a dark set of colors there reaches the whole app at once.",
        ),
        whatChanges: "Adds dark colors and switches with the phone's setting, shipped as a pull request that you merge.",
        whatMightBeLost: "Two screens use their own colors and will need a second look.",
        howChecked: "turtl opens every screen in both settings on a test phone and takes before and after screenshots.",
        confidence: 0.86,
        codeIds: ["code-colors"],
      },
    ],
  },
);

export const caseSeeds: CaseDetail[] = [booking10, booking9, booking8, bookingRequest4, bookingRequest3, guardianRequest2];

const bookingNetwork: CodeNetwork = {
  projectId: "still-booking-demo",
  generatedAt: ago(40 * MIN),
  clusters: [
    { id: "booking", name: "Booking flow", summary: "Everything a customer touches to book: choosing a service, choosing a time and confirming.", health: "affected" },
    { id: "recs", name: "Recommendations", summary: "Suggests extra services while a customer books. It depends on an outside provider.", health: "affected" },
    { id: "accounts", name: "Accounts", summary: "Signing in and keeping each customer's details.", health: "clear" },
    { id: "payments", name: "Payments", summary: "Takes the deposit that confirms a booking.", health: "clear" },
    { id: "notify", name: "Notifications", summary: "Confirmation emails and reminders.", health: "working" },
    { id: "data", name: "Data", summary: "Where bookings, services and customers are kept.", health: "clear" },
  ],
  nodes: [
    { id: "booking-screen", clusterId: "booking", label: "Booking screen", kind: "screen", path: "app/booking/BookingScreen.tsx", summary: "The screen where a customer books. It asks for suggestions and waits for them before showing the form.", weight: 2 },
    { id: "service-picker", clusterId: "booking", label: "Service picker", kind: "screen", path: "app/services/ServicePicker.tsx", summary: "Lists the salon's services with photos and prices." },
    { id: "time-picker", clusterId: "booking", label: "Time picker", kind: "screen", path: "app/booking/TimePicker.tsx", summary: "Shows the free slots for the chosen service." },
    { id: "confirm", clusterId: "booking", label: "Confirm booking", kind: "screen", path: "app/booking/Confirm.tsx", summary: "The last step: review, pay the deposit, and save." },
    { id: "journey", clusterId: "booking", label: "Booking journey", kind: "module", path: "lib/bookingJourney.ts", summary: "The steps of a booking in order. turtl walks this same path when it checks the app.", weight: 1.5 },
    { id: "get-recs", clusterId: "recs", label: "Get recommendations", kind: "module", path: "lib/recommendations.ts", summary: "Asks the outside provider which services to suggest. It gives up after 10 seconds.", weight: 1.5 },
    { id: "recs-row", clusterId: "recs", label: "Suggestions row", kind: "screen", path: "app/booking/Suggestions.tsx", summary: "The row of suggested services on the booking screen." },
    { id: "features", clusterId: "recs", label: "Feature settings", kind: "module", path: "config/features.ts", summary: "On and off settings, including the one for recommendations." },
    { id: "recs-provider", clusterId: "recs", label: "Recommendations provider", kind: "external", summary: "An outside service the app does not control. It is the part timing out today." },
    { id: "sign-in", clusterId: "accounts", label: "Sign in", kind: "screen", path: "app/account/SignIn.tsx", summary: "Signs a customer in with their email." },
    { id: "profile", clusterId: "accounts", label: "Profile", kind: "screen", path: "app/account/Profile.tsx", summary: "A customer's name, phone number and past bookings." },
    { id: "session", clusterId: "accounts", label: "Session", kind: "module", path: "lib/session.ts", summary: "Remembers who is signed in." },
    { id: "deposit", clusterId: "payments", label: "Deposit page", kind: "screen", path: "app/checkout/Deposit.tsx", summary: "Takes the deposit by card." },
    { id: "payments-lib", clusterId: "payments", label: "Payments", kind: "module", path: "lib/payments.ts", summary: "Talks to the payment provider and records what was paid." },
    { id: "stripe", clusterId: "payments", label: "Payment provider", kind: "external", summary: "The outside service that charges cards." },
    { id: "email", clusterId: "notify", label: "Confirmation email", kind: "module", path: "lib/confirmationEmail.ts", summary: "Writes and sends the email after a booking. Error #9 is in here." },
    { id: "reminders", clusterId: "notify", label: "Reminders", kind: "service", path: "jobs/reminders.ts", summary: "Sends a reminder the day before each booking." },
    { id: "email-provider", clusterId: "notify", label: "Email provider", kind: "external", summary: "The outside service that delivers email." },
    { id: "booking-store", clusterId: "data", label: "Booking store", kind: "service", path: "server/bookings.ts", summary: "Saves and reads bookings. Every booking passes through it.", weight: 2 },
    { id: "bookings", clusterId: "data", label: "Bookings", kind: "data", summary: "Every booking, with its service, time and customer." },
    { id: "services", clusterId: "data", label: "Services", kind: "data", summary: "The salon's list of services, prices and photos." },
    { id: "customers", clusterId: "data", label: "Customers", kind: "data", summary: "Customer names and contact details." },
  ],
  edges: [
    { from: "booking-screen", to: "journey", relation: "imports" },
    { from: "booking-screen", to: "get-recs", relation: "calls" },
    { from: "booking-screen", to: "recs-row", relation: "imports" },
    { from: "booking-screen", to: "time-picker", relation: "imports" },
    { from: "service-picker", to: "services", relation: "reads" },
    { from: "service-picker", to: "booking-screen", relation: "calls" },
    { from: "time-picker", to: "booking-store", relation: "reads" },
    { from: "confirm", to: "booking-store", relation: "writes" },
    { from: "confirm", to: "deposit", relation: "calls" },
    { from: "journey", to: "confirm", relation: "calls" },
    { from: "get-recs", to: "recs-provider", relation: "depends_on" },
    { from: "get-recs", to: "features", relation: "reads" },
    { from: "recs-row", to: "services", relation: "reads" },
    { from: "sign-in", to: "session", relation: "calls" },
    { from: "profile", to: "session", relation: "reads" },
    { from: "profile", to: "customers", relation: "reads" },
    { from: "profile", to: "bookings", relation: "reads" },
    { from: "booking-screen", to: "session", relation: "reads" },
    { from: "deposit", to: "payments-lib", relation: "calls" },
    { from: "payments-lib", to: "stripe", relation: "depends_on" },
    { from: "booking-store", to: "bookings", relation: "writes" },
    { from: "booking-store", to: "customers", relation: "reads" },
    { from: "booking-store", to: "email", relation: "calls" },
    { from: "email", to: "email-provider", relation: "depends_on" },
    { from: "reminders", to: "bookings", relation: "reads" },
    { from: "reminders", to: "email-provider", relation: "depends_on" },
  ],
};

export const networks: Record<string, CodeNetwork> = { "still-booking-demo": bookingNetwork };
