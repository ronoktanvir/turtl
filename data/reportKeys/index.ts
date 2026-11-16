import { isLiveData } from "../source";
import * as example from "./example";
import * as live from "./live";

// A project's report keys for its customers' report form: from the backend in a live build, none in the example build.
export type { ReportKey } from "./types";

export const useReportKeys = isLiveData ? live.useReportKeys : example.useReportKeys;
export const makeReportKey = isLiveData ? live.makeReportKey : example.makeReportKey;
export const revokeReportKey = isLiveData ? live.revokeReportKey : example.revokeReportKey;
