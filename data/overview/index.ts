import { isLiveData } from "../source";
import * as example from "./example";
import * as live from "./live";

export type { Overview, WatchedCheck } from "./types";
export const useOverview = isLiveData ? live.useOverview : example.useOverview;
