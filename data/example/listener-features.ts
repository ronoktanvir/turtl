import type { CaseDetail, Screenshot } from "../types";
import type { StepSeed } from "./content";
import { listenerCases } from "./listener-ladder";
import { listenerComparisonScreenshots, listenerScreenshots } from "./listener-ladder-screenshots";
import { featureImages } from "./listener-feature-images";

const proposedAt = Date.now();
const baselineAnswer = listenerCases[0].code.find((code) => code.id === "ll-rank-wait")!;
const baselineSave = listenerCases[0].code.find((code) => code.id === "ll-score-save")!;

export function featureAfterShots(caseId: string): Screenshot[] {
  const concepts: Record<string, { image: string; caption: string }> = {
    "listener-daily": { image: featureImages.daily, caption: "Proposed daily challenge — design concept showing a shared 10-round ladder, date, progress and streak comparison." },
    "listener-share": { image: featureImages.share, caption: "Proposed streak sharing — design concept with a seven-answer streak, Share and Copy link." },
    "listener-genre": { image: featureImages.genre, caption: "Proposed genre selection — design concept for All genres, Pop, Hip-hop and Electronic; artist metadata still needs to be added." },
  };
  const concept = concepts[caseId];
  return concept ? [{ id: `${caseId}-proposal`, url: concept.image, caption: concept.caption, phase: "after", takenAt: proposedAt }] : [];
}

export const listenerFeatures: CaseDetail[] = [
  {
    id: "listener-daily", projectId: "listener-ladder", type: "feature", number: 3,
    title: "A daily challenge for friends", category: "feature_request", status: "needs_approval", health: "affected",
    happenedAt: Date.parse("2026-11-13T19:20:00Z"), reportCount: 42,
    summary: "Friends cannot compare fair daily streaks because they do not play the same challenge.",
    overview: [
      { kind: "paragraph", spans: [{ text: "Give everyone the same ten comparisons each day, with a clear date and progress indicator. A shared ladder makes a streak meaningful between friends instead of comparing different runs." }] },
      { kind: "paragraph", spans: [{ text: "The current game has " }, { text: "20 artists with synthetic listener counts", cite: "daily-catalog" }, { text: ". Ten comparisons need eleven ordered artists. Freeze the day’s artist order and counts so a catalog edit cannot change an answer halfway through the day." }] },
      { kind: "paragraph", spans: [{ text: "The existing " }, { text: "answer and ranking handler", cite: "daily-handler" }, { text: " ends a run on a wrong answer. The proposed daily mode instead completes all ten comparisons, tracks the best consecutive streak, and keeps daily results separate from classic scores. This does not repair the existing large-history ranking timeout." }] },
      { kind: "visualization", title: "Proposed daily journey", viz: { type: "journey", steps: [{ label: "Open today’s challenge", state: "passed" }, { label: "Play the same 10 rounds", state: "passed" }, { label: "Compare daily streaks", state: "not_reached" }] } },
    ],
    citations: [{ id: "daily-catalog", kind: "log", logId: "daily-scope" }, { id: "daily-handler", kind: "code", codeId: "daily-code" }],
    logs: [
      { id: "daily-scope", at: proposedAt, level: "info", source: "Feature planning · artist catalog", text: "lib/artists.ts contains 20 artists with synthetic listener counts. Proposed scope: one UTC-day snapshot, ten comparisons, daily-only results." },
      { id: "daily-risk", at: proposedAt, level: "warn", source: "Feature planning", text: "Acceptance work remains: UTC rollover, replay policy, stable artist counts, streak reset after a miss, and exactly-once completion." },
    ],
    code: [{ ...baselineAnswer, id: "daily-code", after: "const daily = await loadDailySnapshot(utcDate);\nconst correct = compare(daily.pairs[round], direction);\nconst currentStreak = correct ? game.currentStreak + 1 : 0;\nconst bestStreak = Math.max(game.bestStreak, currentStreak);\nconst finished = round + 1 === 10;", note: "Proposed daily-mode addition to lib/game.ts; snapshot loading and ten-round streak tracking are new helpers." }],
    screenshots: [{ ...listenerScreenshots[1], id: "daily-before", caption: "Current gameplay: an ordinary Higher or Lower run, without a shared daily date or progress track." }, ...featureAfterShots("listener-daily")],
    fixes: [
      { key: "listener_daily_snapshot", title: "One shared daily ladder", kind: "change", delivery: "pull_request", recommended: true,
        why: [{ text: "A server-owned daily snapshot keeps the questions and listener counts identical for every friend. It makes the comparison fair without relying on each browser’s clock." }],
        whatChanges: "Add a UTC-date challenge snapshot and daily start mode around app/api/start/route.ts and lib/game.ts. Record ten comparisons, best consecutive streak and one completion per participant in a separate daily result store. Add the date, progress and comparison screen.",
        whatMightBeLost: "More persistence and rollover logic to maintain. Anonymous users can still reset browser identity, so this is friendly comparison rather than a cheat-proof competition.",
        howChecked: "Verify identical snapshots across sessions, a UTC rollover during a run, all ten rounds after a miss, retries without duplicate results, and unchanged classic gameplay.", codeIds: ["daily-code"], usersCantNow: "Friends cannot compare streaks from the same daily questions." },
      { key: "listener_daily_seed", title: "Generate the daily ladder from a seed", kind: "change", delivery: "pull_request", recommended: false,
        why: [{ text: "A date seed plus a pinned catalog version can reproduce the same order without storing every day’s questions." }],
        whatChanges: "Use a server-provided UTC date and catalog version to generate a deterministic ten-round ladder. Persist daily completions separately and retain old catalog versions for active runs.",
        whatMightBeLost: "Catalog versioning becomes part of correctness. A changed shuffle algorithm or missing old catalog can make the same day differ between clients.",
        howChecked: "Compare generated pairs across runtimes and catalog versions; test UTC boundaries, replay handling and completion retries.", codeIds: ["daily-code"] },
    ],
  },
  {
    id: "listener-share", projectId: "listener-ladder", type: "feature", number: 4,
    title: "Share a finished streak", category: "feature_request", status: "enacting", health: "working",
    happenedAt: Date.parse("2026-11-14T21:05:00Z"), reportCount: 24,
    summary: "A shareable streak card is being prepared; its checks are still running.",
    overview: [
      { kind: "paragraph", spans: [{ text: "Players want to send a finished streak to friends without taking and cropping a screenshot. Add Share and Copy link beside the completed-run result, keeping the result readable even if sharing is unavailable." }] },
      { kind: "paragraph", spans: [{ text: "Use only a " }, { text: "successfully saved final result", cite: "share-save" }, { text: ". Sharing must not insert a score again or expose a game’s mutable identifier. A public link should use an opaque, read-only result token." }] },
      { kind: "paragraph", spans: [{ text: "Native browser sharing is not universal: " }, { text: "offer a copy-link fallback", cite: "share-fallback" }, { text: " and a selectable link if clipboard permission is denied." }] },
    ],
    citations: [{ id: "share-save", kind: "code", codeId: "share-code" }, { id: "share-fallback", kind: "log", logId: "share-scope" }],
    logs: [
      { id: "share-scope", at: proposedAt, level: "info", source: "Feature planning · browser compatibility", text: "Plan for navigator.share when available and called from a user gesture. Fall back to Copy link; if clipboard access fails, show a selectable URL. A user-cancelled share is not an error or a reason to copy silently." },
      { id: "share-state", at: proposedAt, level: "info", source: "Sharing checks", text: "Check cancellation, clipboard permission denial and invalid result tokens before enabling merge." },
    ],
    code: [{ ...baselineSave, id: "share-code", startLine: 1, before: "The completed-run screen has no result-sharing action.", after: "const result = await getSavedResult(readOnlyToken);\nconst payload = { title: 'Listener Ladder', text: `${result.streak} in a row!`, url: result.publicUrl };\nif (navigator.share) await navigator.share(payload);\nelse showCopyLink(result.publicUrl);", note: "Proposed result-page addition consuming a saved score; the score-save transaction stays unchanged." }],
    screenshots: [{ ...listenerComparisonScreenshots[0], id: "share-before", caption: "Current completed-run screen: a saved streak of three, without the proposed share card." }, ...featureAfterShots("listener-share")],
    fixes: [
      { key: "listener_share_result", title: "Share a result card and link", kind: "change", delivery: "pull_request", recommended: true,
        why: [{ text: "A readable result card gives friends context, while a read-only link works across browsers and messaging apps without requiring image sharing." }],
        whatChanges: "Create an opaque read-only result link from a saved completion. Add a streak card, Web Share action, explicit Copy link fallback and selectable URL when clipboard access is blocked. Leave score saving unchanged.",
        whatMightBeLost: "Public result links require a small read endpoint and a retention policy. Avoid names and session identifiers; anyone with the link can read that result.",
        howChecked: "Check saved-only results, native sharing, share cancellation, missing Web Share support, clipboard denial, invalid tokens and no duplicate score writes. Checks are pending.", codeIds: ["share-code"] },
      { key: "listener_share_text", title: "Share text with a play link", kind: "change", delivery: "pull_request", recommended: false,
        why: [{ text: "Sharing the streak as text plus a generic play link avoids a public result endpoint and stores no new public result data." }],
        whatChanges: "Add a text share action and a copyable message to the final screen using only the saved streak and game homepage URL.",
        whatMightBeLost: "Friends cannot open a persistent result card, and the score in a copied message is not independently verifiable.",
        howChecked: "Check text formatting, long share targets, user cancellation and copy permission failures without changing saved scores.", codeIds: ["share-code"] },
    ],
    enactment: {
      fixKey: "listener_share_result", state: "running",
      steps: [
        { key: "write", title: "Build sharing and its fallback", status: "done", summary: "Result card and sharing fallback prepared.", startedAt: proposedAt - 180000, finishedAt: proposedAt - 60000 },
        { key: "open_pr", title: "Open the change for review", status: "done", summary: "Sharing changes opened for review.", startedAt: proposedAt - 60000, finishedAt: proposedAt - 30000 },
        { key: "checks", title: "Check sharing across browsers", status: "running", startedAt: proposedAt - 30000, detail: "Native sharing, cancellation, clipboard fallback and saved-score integrity." },
        { key: "merge", title: "Wait for your merge decision", status: "pending" },
        { key: "verify", title: "Verify the deployed sharing flow", status: "pending" },
      ],
      pullRequest: { repo: "aryan-gupta123/listener-ladder-demo", number: 44, title: "Add streak sharing and browser fallback", url: "https://github.com/aryan-gupta123/listener-ladder-demo/compare", headSha: "7d3a9f2", state: "open", checks: "pending", mergeable: false, checkRuns: [{ name: "Typecheck", status: "pending" }, { name: "Share and clipboard fallbacks", status: "pending" }, { name: "Saved-score integrity", status: "pending" }] },
    },
  },
  {
    id: "listener-genre", projectId: "listener-ladder", type: "feature", number: 5,
    title: "Choose a genre before playing", category: "feature_request", status: "new", health: "clear",
    happenedAt: Date.parse("2026-11-15T23:30:00Z"), reportCount: 13,
    summary: "Players want Pop, Hip-hop and Electronic rounds alongside All genres.",
    overview: [
      { kind: "paragraph", spans: [{ text: "Let players pick a music scene before starting, while keeping All genres as the default. This is a new request: no genre mode has shipped." }] },
      { kind: "paragraph", spans: [{ text: "The current catalog has " }, { text: "only 20 artists", cite: "genre-catalog" }, { text: ". Add reviewed genre metadata and check how many distinct artists remain before enabling each choice." }] },
      { kind: "paragraph", spans: [{ text: "Keep the " }, { text: "answer calculation and classic rank semantics", cite: "genre-handler" }, { text: " intact. Filter at game creation, then store the chosen pool and mode with the run. Genre-specific runs should not silently compete with unrestricted classic scores." }] },
    ],
    citations: [{ id: "genre-catalog", kind: "log", logId: "genre-scope" }, { id: "genre-handler", kind: "code", codeId: "genre-code" }],
    logs: [{ id: "genre-scope", at: proposedAt, level: "info", source: "Feature planning · artist catalog", text: "lib/artists.ts has 20 artists with synthetic listener counts. Reviewed genre metadata, eligible-pool sizes and score separation remain implementation work." }],
    code: [{ ...baselineAnswer, id: "genre-code", startLine: 1, before: "Existing mode has no genre selection.", after: "const pool = genre === 'all' ? artists : artists.filter(artist => artist.genres.includes(genre));\nif (pool.length < minimumArtists) return genreUnavailable();\nreturn createGame({ artists: shuffle(pool), mode: genre });", note: "Proposed addition to game creation, not a replacement for answer handling. Genre metadata, pool validation and mode-aware creation need to be added." }],
    screenshots: [{ ...listenerScreenshots[1], id: "genre-before", caption: "Current gameplay: artists from the existing catalog; no proposed genre-selection screen is present." }, ...featureAfterShots("listener-genre")],
    fixes: [
      { key: "listener_genre_metadata", title: "Add reviewed genre filters", kind: "change", delivery: "pull_request", recommended: true,
        why: [{ text: "Reviewed artist tags make genre choices understandable and testable. Keeping All genres as the default preserves the existing way to play." }],
        whatChanges: "Add curated genre tags in lib/artists.ts, validate the chosen pool in the start flow and present All genres, Pop, Hip-hop and Electronic. Disable undersized pools with an explanation and keep genre results separate from classic ranking.",
        whatMightBeLost: "Some choices may remain unavailable until enough artists are tagged. Multi-genre artists need a consistent editorial rule; fewer artists also make repeat play more predictable.",
        howChecked: "Test every eligible pool, mixed tags, unknown genre inputs, insufficient artists, no repeated artist within a run, classic defaults and mode-separated results.", codeIds: ["genre-code"] },
      { key: "listener_genre_playlists", title: "Start with curated genre playlists", kind: "change", delivery: "pull_request", recommended: false,
        why: [{ text: "Explicit artist lists give the owner direct control over each genre’s difficulty without designing a general tagging system." }],
        whatChanges: "Maintain versioned Pop, Hip-hop and Electronic artist-ID playlists beside the existing catalog. Validate references and minimum sizes at build time, and preserve All genres.",
        whatMightBeLost: "The lists duplicate editorial work and need updates as the catalog changes. Small playlists reveal the same comparisons quickly.",
        howChecked: "Validate playlist IDs and minimum sizes, deterministic availability, no repeated artists and unchanged unrestricted runs.", codeIds: ["genre-code"] },
    ],
  },
];

export const featurePlans: Record<string, StepSeed[]> = Object.fromEntries(
  listenerFeatures.flatMap((item) => item.fixes.map((fix) => [fix.key, [
    { key: "write", title: "Build the selected feature", detail: fix.whatChanges, summary: "Candidate implementation prepared for review." },
    { key: "open_pr", title: "Open the change for review", detail: "Keep the feature on its own branch; approval does not change the live game.", summary: "The candidate is ready for code review.", effect: "open_pr" },
    { key: "checks", title: "Check the feature and existing gameplay", detail: fix.howChecked, summary: "The planned candidate checks completed.", effect: "checks" },
    { key: "merge", title: "Wait for your merge decision", detail: "Require passing checks and an explicit owner decision. Never merge automatically.", summary: "The owner approved the merge.", effect: "merge_gate" },
    { key: "verify", title: "Verify the deployed feature", detail: `Confirm the merged revision is running, then exercise “${item.title}” and the classic answer flow.`, summary: "The feature journey was checked after deployment." },
  ] satisfies StepSeed[]])),
);

export const featureReplies: Record<string, string[]> = {
  "listener-daily": ["The daily ladder needs the same date, order and listener counts for everyone. I recommend a server-owned snapshot and daily-only results, so friends compare like with like.", "Ten comparisons need eleven ordered artists. The existing catalog has twenty, but a run must keep its original snapshot across UTC midnight and catalog changes. A wrong answer resets the current streak without ending the daily ten rounds."],
  "listener-share": ["Share only a saved final result. Use a read-only token rather than exposing a game identifier, and leave the score-save transaction unchanged.", "The browser can refuse sharing or clipboard access. Keep an explicit Copy link fallback and a selectable URL; cancellation should leave the result alone."],
  "listener-genre": ["The existing twenty-artist catalog needs reviewed genre metadata first. Keep a genre unavailable until its pool has enough distinct artists.", "All genres should remain the default. Genre runs need separate score context so a streak from a smaller, more predictable pool does not silently compete with classic scores."],
};
