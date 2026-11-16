import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Checks every registered journey; it does nothing while PROTECTED_APP_URL is not set.
crons.interval("check registered journeys", { minutes: 1 }, internal.monitor.tick, {});

// Keeps pull requests that are being opened or are still open fresh; it does nothing while there are none.
crons.interval("refresh pull requests", { seconds: 30 }, internal.pullRequests.refreshActive, {});

// Keeps onboarding preparation pull requests fresh; it does nothing while there are none.
crons.interval("refresh onboarding pull requests", { minutes: 1 }, internal.onboarding.prepare.refreshActive, {});

export default crons;
