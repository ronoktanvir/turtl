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
import type * as crons from "../crons.js";
import type * as decisions from "../decisions.js";
import type * as dev from "../dev.js";
import type * as diagnosis from "../diagnosis.js";
import type * as keiki from "../keiki.js";
import type * as memory_checks from "../memory/checks.js";
import type * as memory_dev from "../memory/dev.js";
import type * as memory_flow from "../memory/flow.js";
import type * as memory_records from "../memory/records.js";
import type * as memory_service from "../memory/service.js";
import type * as monitor from "../monitor.js";
import type * as protectedApp_client from "../protectedApp/client.js";
import type * as protectedApp_records from "../protectedApp/records.js";
import type * as protectedApp_registry from "../protectedApp/registry.js";
import type * as runner_contract from "../runner/contract.js";
import type * as runner_handlers_authorize_and_execute from "../runner/handlers/authorize_and_execute.js";
import type * as runner_handlers_detect_or_receive from "../runner/handlers/detect_or_receive.js";
import type * as runner_handlers_examine_broader_causes from "../runner/handlers/examine_broader_causes.js";
import type * as runner_handlers_gather_context from "../runner/handlers/gather_context.js";
import type * as runner_handlers_index from "../runner/handlers/index.js";
import type * as runner_handlers_investigate from "../runner/handlers/investigate.js";
import type * as runner_handlers_journey from "../runner/handlers/journey.js";
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
  crons: typeof crons;
  decisions: typeof decisions;
  dev: typeof dev;
  diagnosis: typeof diagnosis;
  keiki: typeof keiki;
  "memory/checks": typeof memory_checks;
  "memory/dev": typeof memory_dev;
  "memory/flow": typeof memory_flow;
  "memory/records": typeof memory_records;
  "memory/service": typeof memory_service;
  monitor: typeof monitor;
  "protectedApp/client": typeof protectedApp_client;
  "protectedApp/records": typeof protectedApp_records;
  "protectedApp/registry": typeof protectedApp_registry;
  "runner/contract": typeof runner_contract;
  "runner/handlers/authorize_and_execute": typeof runner_handlers_authorize_and_execute;
  "runner/handlers/detect_or_receive": typeof runner_handlers_detect_or_receive;
  "runner/handlers/examine_broader_causes": typeof runner_handlers_examine_broader_causes;
  "runner/handlers/gather_context": typeof runner_handlers_gather_context;
  "runner/handlers/index": typeof runner_handlers_index;
  "runner/handlers/investigate": typeof runner_handlers_investigate;
  "runner/handlers/journey": typeof runner_handlers_journey;
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
