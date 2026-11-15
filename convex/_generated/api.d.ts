/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as assistant from "../assistant.js";
import type * as cases from "../cases.js";
import type * as constants from "../constants.js";
import type * as dev from "../dev.js";
import type * as keiki from "../keiki.js";
import type * as runner_contract from "../runner/contract.js";
import type * as runner_handlers_authorize_and_execute from "../runner/handlers/authorize_and_execute.js";
import type * as runner_handlers_detect_or_receive from "../runner/handlers/detect_or_receive.js";
import type * as runner_handlers_examine_broader_causes from "../runner/handlers/examine_broader_causes.js";
import type * as runner_handlers_gather_context from "../runner/handlers/gather_context.js";
import type * as runner_handlers_index from "../runner/handlers/index.js";
import type * as runner_handlers_investigate from "../runner/handlers/investigate.js";
import type * as runner_handlers_learn from "../runner/handlers/learn.js";
import type * as runner_handlers_plan from "../runner/handlers/plan.js";
import type * as runner_handlers_verify from "../runner/handlers/verify.js";
import type * as runner_run from "../runner/run.js";
import type * as supermemory from "../supermemory.js";
import type * as workflow from "../workflow.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  assistant: typeof assistant;
  cases: typeof cases;
  constants: typeof constants;
  dev: typeof dev;
  keiki: typeof keiki;
  "runner/contract": typeof runner_contract;
  "runner/handlers/authorize_and_execute": typeof runner_handlers_authorize_and_execute;
  "runner/handlers/detect_or_receive": typeof runner_handlers_detect_or_receive;
  "runner/handlers/examine_broader_causes": typeof runner_handlers_examine_broader_causes;
  "runner/handlers/gather_context": typeof runner_handlers_gather_context;
  "runner/handlers/index": typeof runner_handlers_index;
  "runner/handlers/investigate": typeof runner_handlers_investigate;
  "runner/handlers/learn": typeof runner_handlers_learn;
  "runner/handlers/plan": typeof runner_handlers_plan;
  "runner/handlers/verify": typeof runner_handlers_verify;
  "runner/run": typeof runner_run;
  supermemory: typeof supermemory;
  workflow: typeof workflow;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
