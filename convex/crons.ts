import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Checks every registered journey; it does nothing while PROTECTED_APP_URL is not set.
crons.interval("check registered journeys", { minutes: 1 }, internal.monitor.tick, {});

export default crons;
