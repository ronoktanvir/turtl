import { defineTable } from "convex/server";
import {
  vExternalApp, vProbeRun, vBrowserScreenshot, vAgentThread,
  vAgentMessage, vPullRequestChanges, vRepairProof,
} from "./validators";

export const externalAppTables = {
  externalApps: defineTable(vExternalApp).index("by_app", ["appId"]),
  probeRuns: defineTable(vProbeRun)
    .index("by_completed", ["completedAt"])
    .index("by_case", ["caseId"])
    .index("by_app", ["appId"]),
  browserScreenshots: defineTable(vBrowserScreenshot)
    .index("by_case", ["caseId"])
    .index("by_probe_run", ["probeRunId"]),
  agentThreads: defineTable(vAgentThread)
    .index("by_pull_request", ["pullRequestId"])
    .index("by_done", ["done"]),
  agentMessages: defineTable(vAgentMessage)
    .index("by_case", ["caseId", "createdAt"])
    .index("by_thread_and_message", ["threadId", "messageId"]),
  pullRequestChanges: defineTable(vPullRequestChanges).index("by_pull_request", ["pullRequestId"]),
  repairProofs: defineTable(vRepairProof)
    .index("by_case", ["caseId"])
    .index("by_deployment_status", ["deployment.status"]),
};
