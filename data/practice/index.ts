import { isLiveData } from "../source";
import * as example from "./example";
import * as live from "./live";

// A practice project (convex/practice): whether this account can have one, its state, and the owner's three controls.
// From the backend in a live build (where it exists only with accounts on), and from memory in the example build.
export type { Practice, PracticeFailure, PracticeProject } from "./types";
export { FAILURE_WORDS } from "./types";

export const usePractice = isLiveData ? live.usePractice : example.usePractice;
export const createPractice = isLiveData ? live.createPractice : example.createPractice;
export const breakPractice = isLiveData ? live.breakPractice : example.breakPractice;
export const mendPractice = isLiveData ? live.mendPractice : example.mendPractice;
