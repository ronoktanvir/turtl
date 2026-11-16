import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Checks registered journeys. The demo checks its one app and does nothing while PROTECTED_APP_URL is not set; with
// accounts on, each tick starts a check of every project that is due, each with its own token, and a project with
// nothing to check takes no turn (convex/protectedApp/watching.ts).
crons.interval("check registered journeys", { minutes: 1 }, internal.monitor.tick, {});

// Keeps pull requests that are being opened or are still open fresh; it does nothing while there are none.
crons.interval("refresh pull requests", { seconds: 30 }, internal.pullRequests.refreshActive, {});

// Fills in agent run outcomes once their cases verify, fail or close; it does nothing when no run is waiting.
crons.interval("settle agent run outcomes", { minutes: 2 }, internal.routing.log.settlePending, {});

// Keeps onboarding preparation pull requests fresh; it does nothing while there are none.
crons.interval("refresh onboarding pull requests", { minutes: 1 }, internal.onboarding.prepare.refreshActive, {});

// Starts again an account deletion whose run stopped (convex/account); it does nothing while none has.
crons.interval("resume account deletions", { minutes: 15 }, internal.account.deletion.resumeStalled, {});

// Forgets emailed codes a day after they were sent, and starts deleting password accounts that never confirmed their
// email address (convex/auth/codes.ts, convex/auth/confirmation.ts). Both do nothing while there are none.
crons.interval("forget old emailed codes", { hours: 1 }, internal.auth.codes.prune, {});
crons.interval("remove unconfirmed accounts", { hours: 1 }, internal.auth.confirmation.sweep, {});

// Forgets the phones whose sign-in session has ended, so they stop being any account's (convex/push/devices.ts).
// Delivery already skips them; it does nothing in the demo or while there are none.
crons.interval("forget phones whose sign-in ended", { hours: 1 }, internal.push.devices.sweep, {});

export default crons;
