import type { Condition, ParameterValue, RecoveryMemory } from "../constants";

const FACT_TYPES: Record<string, string> = {
  "journey.verdict": "string",
  "journey.failedStep": "string",
  "journey.errorCode": "string",
  "flags.recommendationsEnabled": "boolean",
  "health.ok": "boolean",
  "errors.totalBookings": "number",
  "errors.failedBookings": "number",
  "errors.errorRate": "number",
  "errors.topCode": "string",
  "app.revision": "string",
};

export function supportedFactKeys(
  facts: Record<string, unknown>,
  keys: unknown,
): string[] {
  if (!Array.isArray(keys)) return [];
  return [
    ...new Set(
      keys.filter(
        (field): field is string =>
          typeof field === "string" &&
          Object.hasOwn(FACT_TYPES, field) &&
          Object.hasOwn(facts, field) &&
          typeof facts[field] === FACT_TYPES[field] &&
          (typeof facts[field] !== "number" || Number.isFinite(facts[field])),
      ),
    ),
  ].sort();
}

export function diagnosisChecks(
  facts: Record<string, unknown>,
  keys: unknown,
): Condition[] | null {
  const named = supportedFactKeys(facts, keys);
  if (!named.length) return null;
  const fields = supportedFactKeys(facts, [
    ...named,
    "journey.verdict",
    "journey.failedStep",
    "journey.errorCode",
    "app.revision",
    "flags.recommendationsEnabled",
    "health.ok",
  ]);
  if (
    facts["journey.verdict"] !== "failed" ||
    facts["flags.recommendationsEnabled"] !== true ||
    facts["health.ok"] !== true ||
    !fields.includes("app.revision") ||
    !fields.includes("journey.failedStep") ||
    !fields.includes("journey.errorCode")
  )
    return null;
  return fields.map((field) => ({
    field,
    operator: "eq",
    value: facts[field] as ParameterValue,
  }));
}

export function describeCheck(check: Condition): string {
  const operators = {
    eq: "equals",
    neq: "does not equal",
    lt: "is less than",
    lte: "is at most",
    gt: "is greater than",
    gte: "is at least",
  };
  return `${check.field} ${operators[check.operator]} ${JSON.stringify(check.value)}`;
}

export function evaluateCheck(
  check: Condition,
  facts: Record<string, unknown>,
) {
  const expectedType = Object.hasOwn(FACT_TYPES, check.field)
    ? FACT_TYPES[check.field]
    : undefined;
  if (!expectedType)
    return {
      matches: false,
      unknown: true,
      reason: `${check.field} is not a supported fact.`,
    };
  if (!Object.hasOwn(facts, check.field)) {
    return {
      matches: false,
      unknown: true,
      reason: `${check.field} was not observed; ${describeCheck(check)} could not be checked.`,
    };
  }
  const actual = facts[check.field];
  if (
    typeof actual !== expectedType ||
    typeof check.value !== expectedType ||
    (typeof actual === "number" && !Number.isFinite(actual))
  ) {
    return {
      matches: false,
      unknown: true,
      reason: `${check.field} has an incompatible value; ${describeCheck(check)} could not be checked.`,
    };
  }
  let matches: boolean;
  if (check.operator === "eq") matches = actual === check.value;
  else if (check.operator === "neq") matches = actual !== check.value;
  else if (
    typeof actual !== "number" ||
    typeof check.value !== "number" ||
    !Number.isFinite(check.value)
  ) {
    return {
      matches: false,
      unknown: true,
      reason: `${describeCheck(check)} requires numeric values.`,
    };
  } else {
    const value = check.value;
    matches =
      check.operator === "lt"
        ? actual < value
        : check.operator === "lte"
          ? actual <= value
          : check.operator === "gt"
            ? actual > value
            : actual >= value;
  }
  return {
    matches,
    unknown: false,
    reason: `${describeCheck(check)}; observed ${JSON.stringify(actual)}.`,
  };
}

export function applicability(
  memory: RecoveryMemory,
  facts: Record<string, unknown>,
) {
  const failedChecks: string[] = [];
  if (memory.invalidatedAt !== undefined)
    failedChecks.push("This recovery memory has been invalidated.");
  if (memory.conditionChecks.length === 0)
    failedChecks.push("This memory has no applicability checks.");
  for (const check of memory.conditionChecks) {
    const result = evaluateCheck(check, facts);
    if (!result.matches)
      failedChecks.push(`Required condition failed: ${result.reason}`);
  }
  for (const check of memory.notWhenChecks) {
    const result = evaluateCheck(check, facts);
    if (result.matches || result.unknown)
      failedChecks.push(`Do not use this recovery: ${result.reason}`);
  }
  return { applies: failedChecks.length === 0, failedChecks };
}

export function recoveryChecks(
  facts: Record<string, unknown>,
): Condition[] | null {
  if (
    facts["journey.verdict"] !== "failed" ||
    facts["journey.failedStep"] !== "recommendations" ||
    facts["journey.errorCode"] !== "RECOMMENDATIONS_TIMEOUT" ||
    facts["flags.recommendationsEnabled"] !== true ||
    facts["health.ok"] !== true ||
    typeof facts["app.revision"] !== "string" ||
    !facts["app.revision"]
  )
    return null;
  return [
    "journey.verdict",
    "journey.failedStep",
    "journey.errorCode",
    "flags.recommendationsEnabled",
    "health.ok",
    "app.revision",
  ].map((field) => ({
    field,
    operator: "eq",
    value: facts[field] as ParameterValue,
  }));
}
