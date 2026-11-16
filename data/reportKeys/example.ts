import type { ReportKey } from "./types";

// The example data has no backend to receive reports, so it has no report keys and the Customer reports row stays
// hidden, as the case screen's report controls do.
export const useReportKeys = (_projectId: string, _enabled = true): ReportKey[] | null | undefined => null;
export const makeReportKey = (_projectId: string): Promise<string> => Promise.reject(new Error("Report keys need a turtl backend. The example data has none."));
export const revokeReportKey = (_keyId: string): Promise<void> => Promise.reject(new Error("Report keys need a turtl backend. The example data has none."));
