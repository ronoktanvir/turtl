import type { AiPermission, AiSpend } from "../../data/consent";

/** "OpenAI", "OpenAI and Capy", "OpenAI, Supermemory and Capy". */
export function listNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * Whether the permission screen shows "turtl will work without AI" with its Continue: right after Not now, and when
 * the screen opened at the start of the app (?from=start) for someone who has already said Not now, such as after a
 * reload before they pressed Continue. Without this, a reload showed the whole list again with no way on but a
 * second Not now.
 */
export function showsDeclined(declinedHere: boolean, atStart: boolean, status: Pick<AiPermission, "answer" | "needsAnswer">): boolean {
  return declinedHere || (atStart && status.answer === "declined" && !status.needsAnswer);
}

export const day = (at: number) => new Date(at).toLocaleDateString("en-GB", { day: "numeric", month: "long" });

const lower = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

/** "OpenAI, which names the parts of the code, …", from the service's own line in store/data-practices.json. */
export const whatItDoes = (service: { name: string; does: string }) => `${service.name}, which ${lower(service.does)}`;

/** Where the owner stands, in one sentence, for the gear sheet. */
export function standingLine(status: AiPermission): string {
  const allowed = status.services.filter((service) => service.allowed).map((service) => service.name);
  const blocked = status.services.filter((service) => !service.allowed).map((service) => service.name);
  const without = "turtl sends nothing to AI services and uses its own rules.";
  if (status.answer === "allowed" && !blocked.length) {
    return `turtl may use ${listNames(allowed)}, as you allowed${status.answeredAt ? ` on ${day(status.answeredAt)}` : ""}.`;
  }
  if (status.answer === "allowed") return `turtl's list changed after you agreed. Read it again to let turtl use ${listNames(blocked)}.`;
  if (status.answer === "withdrawn") return `You took permission back${status.withdrawnAt ? ` on ${day(status.withdrawnAt)}` : ""}, so ${without}`;
  if (status.answer === "declined") return `You chose Not now, so ${without}`;
  return `You have not answered yet, so ${without}`;
}

const dollars = (value: number) => `$${value.toFixed(2)}`;

/** The account against its limits, in one line. */
export function spendLine(spend: AiSpend): string {
  const month = spend.month.split(" ")[0];
  return `AI use in ${month}: ${dollars(spend.spentUsd)} of ${dollars(spend.limitUsd)}. Code changes today: ${spend.threadsToday} of ${spend.threadsPerDay}.`;
}
