import { defineTable } from "convex/server";
import { v } from "convex/values";

export const vAgreedService = v.object({ id: v.string(), version: v.string() });

export const consentTables = {
  // Each answer an account gave on the AI permission screen; the newest row is the one in force. "allowed" names the
  // services and the version of each that was on the screen; "declined" names none. Taking permission back stamps
  // withdrawnAt on the row in force, and the gate refuses from that moment.
  aiConsents: defineTable({
    account: v.string(),
    answer: v.union(v.literal("allowed"), v.literal("declined")),
    services: v.array(vAgreedService),
    listVersion: v.string(),
    answeredAt: v.number(),
    withdrawnAt: v.optional(v.number()),
  }).index("by_account", ["account"]),
};
