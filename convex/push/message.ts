// What a push notification says. This file is the only place its words come from.
//
// A notification shows on a locked phone, so it names the project and says that a case needs the owner, and nothing
// more: never a customer's words, a log line, an error, a model's text, or code. The title is the project's name;
// the body is one fixed sentence picked by the kind of event; the payload carries only the case id, so a tap opens
// /review/<caseId>. Nothing here is promotional, and no other input can reach the message.

export type NoticeEvent = "opened" | "needs_decision" | "handled_under_permission" | "not_answering" | "answering_again";

/**
 * The events that send a push, and the one sentence each sends.
 * - needs_decision: the case is waiting for the owner to approve or decline a fix. They must act.
 * - handled_under_permission: a fix the owner allowed in advance ran on its own and the check after it passed.
 * - not_answering: the app gave turtl's checks no usable answer three times in a row, so a case opened. turtl cannot
 *   look into an app it cannot reach, so the owner is the one who can.
 * - answering_again: that case closed because the app answered again. It may have answered with a failing check (whose
 *   own case opens, with no push of its own), so the sentence is no all-clear.
 * "opened" sends no push: turtl is still looking into it and there is nothing for the owner to do yet. If the case
 * needs them, needs_decision follows.
 */
export const PUSH_BODIES: Readonly<Partial<Record<NoticeEvent, string>>> = Object.freeze({
  needs_decision: "A case needs your decision. Open it to approve or decline a fix.",
  handled_under_permission: "A fix you allowed ran and the app passed its check. Open the case to see what changed.",
  not_answering: "Your app is not answering turtl's checks. Open the case to see what turtl saw.",
  answering_again: "Your app is answering turtl's checks again. Open the case to see whether they pass.",
});

export const FALLBACK_TITLE = "turtl";
const MAX_TITLE = 60;
const CASE_ID = /^[a-z0-9]{8,64}$/;

export function sendsPush(event: string): event is NoticeEvent {
  return Object.prototype.hasOwnProperty.call(PUSH_BODIES, event);
}

/** The project's name as a title: one line, no control characters, at most 60 characters. */
export function pushTitle(projectName: string): string {
  const line = String(projectName).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
  if (!line) return FALLBACK_TITLE;
  return line.length > MAX_TITLE ? `${line.slice(0, MAX_TITLE - 1).trimEnd()}…` : line;
}

export type PushContent = { title: string; body: string; data: { caseId: string } };

/** The notification for one case event, or null when that event sends none or the case id is not a case id. */
export function pushMessage(input: { projectName: string; caseId: string; event: string }): PushContent | null {
  const { projectName, caseId, event } = input;
  if (!sendsPush(event) || typeof caseId !== "string" || !CASE_ID.test(caseId)) return null;
  return { title: pushTitle(projectName), body: PUSH_BODIES[event]!, data: { caseId } };
}

export type ExpoMessage = PushContent & { to: string; sound: "default"; priority: "high" };

/** One Expo message per phone, so each ticket in Expo's answer lines up with one token. */
export function expoMessages(content: PushContent, tokens: string[]): ExpoMessage[] {
  return tokens.map((to) => ({
    to,
    title: content.title,
    body: content.body,
    data: { caseId: content.data.caseId },
    sound: "default",
    priority: "high",
  }));
}
