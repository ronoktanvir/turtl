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
import type * as bookingDemo_booking from "../bookingDemo/booking.js";
import type * as bookingDemo_catalog from "../bookingDemo/catalog.js";
import type * as bookingDemo_checks from "../bookingDemo/checks.js";
import type * as bookingDemo_journeyCore from "../bookingDemo/journeyCore.js";
import type * as bookingDemo_provider from "../bookingDemo/provider.js";
import type * as bookingDemo_records from "../bookingDemo/records.js";
import type * as bookingDemo_state from "../bookingDemo/state.js";
import type * as bookingDemo_validators from "../bookingDemo/validators.js";
import type * as cases from "../cases.js";
import type * as constants from "../constants.js";
import type * as crons from "../crons.js";
import type * as decisions from "../decisions.js";
import type * as dev from "../dev.js";
import type * as diagnosis from "../diagnosis.js";
import type * as fixOptions from "../fixOptions.js";
import type * as fixes from "../fixes.js";
import type * as http from "../http.js";
import type * as keiki from "../keiki.js";
import type * as memory_checks from "../memory/checks.js";
import type * as memory_dev from "../memory/dev.js";
import type * as memory_flow from "../memory/flow.js";
import type * as memory_records from "../memory/records.js";
import type * as memory_reset from "../memory/reset.js";
import type * as memory_service from "../memory/service.js";
import type * as monitor from "../monitor.js";
import type * as permissions from "../permissions.js";
import type * as prTracking_capy from "../prTracking/capy.js";
import type * as prTracking_catalog from "../prTracking/catalog.js";
import type * as prTracking_execute from "../prTracking/execute.js";
import type * as prTracking_github from "../prTracking/github.js";
import type * as prTracking_records from "../prTracking/records.js";
import type * as prTracking_validators from "../prTracking/validators.js";
import type * as protectedApp_client from "../protectedApp/client.js";
import type * as protectedApp_records from "../protectedApp/records.js";
import type * as protectedApp_registry from "../protectedApp/registry.js";
import type * as pullRequests from "../pullRequests.js";
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
  "bookingDemo/booking": typeof bookingDemo_booking;
  "bookingDemo/catalog": typeof bookingDemo_catalog;
  "bookingDemo/checks": typeof bookingDemo_checks;
  "bookingDemo/journeyCore": typeof bookingDemo_journeyCore;
  "bookingDemo/provider": typeof bookingDemo_provider;
  "bookingDemo/records": typeof bookingDemo_records;
  "bookingDemo/state": typeof bookingDemo_state;
  "bookingDemo/validators": typeof bookingDemo_validators;
  cases: typeof cases;
  constants: typeof constants;
  crons: typeof crons;
  decisions: typeof decisions;
  dev: typeof dev;
  diagnosis: typeof diagnosis;
  fixOptions: typeof fixOptions;
  fixes: typeof fixes;
  http: typeof http;
  keiki: typeof keiki;
  "memory/checks": typeof memory_checks;
  "memory/dev": typeof memory_dev;
  "memory/flow": typeof memory_flow;
  "memory/records": typeof memory_records;
  "memory/reset": typeof memory_reset;
  "memory/service": typeof memory_service;
  monitor: typeof monitor;
  permissions: typeof permissions;
  "prTracking/capy": typeof prTracking_capy;
  "prTracking/catalog": typeof prTracking_catalog;
  "prTracking/execute": typeof prTracking_execute;
  "prTracking/github": typeof prTracking_github;
  "prTracking/records": typeof prTracking_records;
  "prTracking/validators": typeof prTracking_validators;
  "protectedApp/client": typeof protectedApp_client;
  "protectedApp/records": typeof protectedApp_records;
  "protectedApp/registry": typeof protectedApp_registry;
  pullRequests: typeof pullRequests;
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
