import { useState } from "react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import type { ChatMessage, ChatScope, CodeNetwork } from "../types";
import { errorMessage, liveClient, useLiveQuery } from "./client";

const resolveNetwork = api.screens.network.resolve;

export function useCodeNetwork(projectId: string): (CodeNetwork & { repo: string; source: "seed" | "built" }) | null | undefined {
  const resolved = useLiveQuery(resolveNetwork, projectId ? { projectId } : "skip");
  const network = useLiveQuery(api.codeNetwork.network.get, resolved ? { projectId: resolved.projectId } : "skip");
  if (!liveClient || !projectId || resolved === null) return null;
  if (resolved === undefined || network === undefined) return undefined;
  return network ? { ...network, projectId, repo: resolved.repo, source: resolved.source } : null;
}

export function useChat(scope: ChatScope): {
  messages: ChatMessage[];
  send(text: string): Promise<void>;
  requestNewFix?(): Promise<void>;
  busy: boolean;
} {
  const resolved = useLiveQuery(resolveNetwork, scope.kind !== "case" && scope.projectId ? { projectId: scope.projectId } : "skip");
  const networkScope = scope.kind !== "case" && resolved ? { ...scope, projectId: resolved.projectId } : null;
  const caseMessages = useLiveQuery(api.fixes.messages, scope.kind === "case" && scope.caseId ? { caseId: scope.caseId } : "skip");
  const networkMessages = useLiveQuery(api.codeNetwork.network.messages, networkScope ? { scope: networkScope } : "skip");
  const key = JSON.stringify(scope.kind === "case" ? [scope.kind, scope.caseId]
    : scope.kind === "project" ? [scope.kind, scope.projectId]
    : scope.kind === "cluster" ? [scope.kind, scope.projectId, scope.clusterId]
    : [scope.kind, scope.projectId, scope.nodeId]);
  const [pending, setPending] = useState<Record<string, number>>({});

  const send = async (message: string, newFix = false): Promise<void> => {
    const text = message.trim();
    if (!text) throw new Error("Enter a message before sending.");
    if (text.length > 2000) throw new Error("The message is too long. Keep it to 2,000 characters or fewer.");
    if (!liveClient) throw new Error("The backend URL is not configured.");
    if (scope.kind === "case" && (!scope.caseId || caseMessages === null)) throw new Error("This case was not found.");
    if (scope.kind !== "case" && !networkScope) {
      throw new Error(resolved === undefined && scope.projectId
        ? "The code network is still loading. Try again shortly."
        : "No matching code network is available for this project yet.");
    }

    setPending((counts) => ({ ...counts, [key]: (counts[key] ?? 0) + 1 }));
    try {
      if (scope.kind === "case") {
        await liveClient.action(api.fixes.investigate, {
          caseId: scope.caseId as Id<"cases">,
          message: text,
          ...(newFix ? { newFix: true } : {}),
        });
      } else if (networkScope) {
        const result = await liveClient.action(api.codeNetwork.ask.ask, { scope: networkScope, message: text });
        if (result.outcome === "not_configured") {
          throw new Error("Code questions are not enabled on this backend yet. Ask the owner to finish configuring code chat.");
        }
      }
    } catch (error) {
      throw new Error(errorMessage(error));
    } finally {
      setPending((counts) => {
        const next = { ...counts };
        if ((next[key] ?? 0) <= 1) delete next[key];
        else next[key] -= 1;
        return next;
      });
    }
  };

  return {
    messages: (scope.kind === "case" ? caseMessages : networkMessages) ?? [],
    send: (text) => send(text),
    requestNewFix: scope.kind === "case" ? () => send("New fix", true) : undefined,
    busy: (pending[key] ?? 0) > 0,
  };
}
