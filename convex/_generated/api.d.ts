/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as access from "../access.js";
import type * as auth from "../auth.js";
import type * as auth_apple from "../auth/apple.js";
import type * as auth_email from "../auth/email.js";
import type * as auth_password from "../auth/password.js";
import type * as auth_review from "../auth/review.js";
import type * as auth_rules from "../auth/rules.js";
import type * as auth_settings from "../auth/settings.js";
import type * as bookingDemo_booking from "../bookingDemo/booking.js";
import type * as bookingDemo_catalog from "../bookingDemo/catalog.js";
import type * as bookingDemo_checks from "../bookingDemo/checks.js";
import type * as bookingDemo_journeyCore from "../bookingDemo/journeyCore.js";
import type * as bookingDemo_provider from "../bookingDemo/provider.js";
import type * as bookingDemo_records from "../bookingDemo/records.js";
import type * as bookingDemo_state from "../bookingDemo/state.js";
import type * as bookingDemo_validators from "../bookingDemo/validators.js";
import type * as cases from "../cases.js";
import type * as codeNetwork_ask from "../codeNetwork/ask.js";
import type * as codeNetwork_build from "../codeNetwork/build.js";
import type * as codeNetwork_dev from "../codeNetwork/dev.js";
import type * as codeNetwork_graph from "../codeNetwork/graph.js";
import type * as codeNetwork_network from "../codeNetwork/network.js";
import type * as codeNetwork_openai from "../codeNetwork/openai.js";
import type * as codeNetwork_redact from "../codeNetwork/redact.js";
import type * as codeNetwork_seed from "../codeNetwork/seed.js";
import type * as consent_gate from "../consent/gate.js";
import type * as consent_outbound from "../consent/outbound.js";
import type * as consent_permission from "../consent/permission.js";
import type * as consent_services from "../consent/services.js";
import type * as constants from "../constants.js";
import type * as council_run from "../council/run.js";
import type * as council_settings from "../council/settings.js";
import type * as crons from "../crons.js";
import type * as decisions from "../decisions.js";
import type * as dev from "../dev.js";
import type * as diagnosis from "../diagnosis.js";
import type * as evidence_collectors from "../evidence/collectors.js";
import type * as evidence_context from "../evidence/context.js";
import type * as evidence_localProof from "../evidence/localProof.js";
import type * as evidence_records from "../evidence/records.js";
import type * as evidence_snapshots from "../evidence/snapshots.js";
import type * as fixOptions from "../fixOptions.js";
import type * as fixes from "../fixes.js";
import type * as github_access from "../github/access.js";
import type * as github_api from "../github/api.js";
import type * as github_config from "../github/config.js";
import type * as github_connect from "../github/connect.js";
import type * as github_http from "../github/http.js";
import type * as github_installations from "../github/installations.js";
import type * as github_jwt from "../github/jwt.js";
import type * as github_links from "../github/links.js";
import type * as github_secrets from "../github/secrets.js";
import type * as github_shapes from "../github/shapes.js";
import type * as github_sync from "../github/sync.js";
import type * as github_tokens from "../github/tokens.js";
import type * as github_webhook from "../github/webhook.js";
import type * as http from "../http.js";
import type * as intake_dev from "../intake/dev.js";
import type * as intake_http from "../intake/http.js";
import type * as intake_keys from "../intake/keys.js";
import type * as intake_records from "../intake/records.js";
import type * as intake_rules from "../intake/rules.js";
import type * as intake_triage from "../intake/triage.js";
import type * as intake_workflow from "../intake/workflow.js";
import type * as keiki from "../keiki.js";
import type * as learning_context from "../learning/context.js";
import type * as learning_feedback from "../learning/feedback.js";
import type * as learning_model from "../learning/model.js";
import type * as learning_preferences from "../learning/preferences.js";
import type * as learning_rules from "../learning/rules.js";
import type * as learning_runs from "../learning/runs.js";
import type * as memory_checks from "../memory/checks.js";
import type * as memory_dev from "../memory/dev.js";
import type * as memory_flow from "../memory/flow.js";
import type * as memory_records from "../memory/records.js";
import type * as memory_reset from "../memory/reset.js";
import type * as memory_service from "../memory/service.js";
import type * as monitor from "../monitor.js";
import type * as notices from "../notices.js";
import type * as onboarding_brief from "../onboarding/brief.js";
import type * as onboarding_detect from "../onboarding/detect.js";
import type * as onboarding_github from "../onboarding/github.js";
import type * as onboarding_inspect from "../onboarding/inspect.js";
import type * as onboarding_prepare from "../onboarding/prepare.js";
import type * as onboarding_projects from "../onboarding/projects.js";
import type * as onboarding_records from "../onboarding/records.js";
import type * as onboarding_stage from "../onboarding/stage.js";
import type * as ownerPasscode from "../ownerPasscode.js";
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
import type * as push_deliver from "../push/deliver.js";
import type * as push_devices from "../push/devices.js";
import type * as push_expo from "../push/expo.js";
import type * as push_localProof from "../push/localProof.js";
import type * as push_message from "../push/message.js";
import type * as revyl_api from "../revyl/api.js";
import type * as revyl_device from "../revyl/device.js";
import type * as revyl_runs from "../revyl/runs.js";
import type * as routing_configs from "../routing/configs.js";
import type * as routing_log from "../routing/log.js";
import type * as routing_models from "../routing/models.js";
import type * as routing_selector from "../routing/selector.js";
import type * as routing_validators from "../routing/validators.js";
import type * as routing_view from "../routing/view.js";
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
import type * as runner_jobs from "../runner/jobs.js";
import type * as runner_run from "../runner/run.js";
import type * as screens_network from "../screens/network.js";
import type * as screens_overview from "../screens/overview.js";
import type * as screens_projects from "../screens/projects.js";
import type * as spend_ledger from "../spend/ledger.js";
import type * as spend_limits from "../spend/limits.js";
import type * as spend_status from "../spend/status.js";
import type * as structural_checks from "../structural/checks.js";
import type * as structural_dev from "../structural/dev.js";
import type * as structural_examine from "../structural/examine.js";
import type * as structural_queries from "../structural/queries.js";
import type * as structural_records from "../structural/records.js";
import type * as structural_rules from "../structural/rules.js";
import type * as supermemory from "../supermemory.js";
import type * as users from "../users.js";
import type * as voice_openai from "../voice/openai.js";
import type * as voice_progress from "../voice/progress.js";
import type * as voice_rules from "../voice/rules.js";
import type * as voice_runs from "../voice/runs.js";
import type * as voice_turn from "../voice/turn.js";
import type * as workflow from "../workflow.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  access: typeof access;
  auth: typeof auth;
  "auth/apple": typeof auth_apple;
  "auth/email": typeof auth_email;
  "auth/password": typeof auth_password;
  "auth/review": typeof auth_review;
  "auth/rules": typeof auth_rules;
  "auth/settings": typeof auth_settings;
  "bookingDemo/booking": typeof bookingDemo_booking;
  "bookingDemo/catalog": typeof bookingDemo_catalog;
  "bookingDemo/checks": typeof bookingDemo_checks;
  "bookingDemo/journeyCore": typeof bookingDemo_journeyCore;
  "bookingDemo/provider": typeof bookingDemo_provider;
  "bookingDemo/records": typeof bookingDemo_records;
  "bookingDemo/state": typeof bookingDemo_state;
  "bookingDemo/validators": typeof bookingDemo_validators;
  cases: typeof cases;
  "codeNetwork/ask": typeof codeNetwork_ask;
  "codeNetwork/build": typeof codeNetwork_build;
  "codeNetwork/dev": typeof codeNetwork_dev;
  "codeNetwork/graph": typeof codeNetwork_graph;
  "codeNetwork/network": typeof codeNetwork_network;
  "codeNetwork/openai": typeof codeNetwork_openai;
  "codeNetwork/redact": typeof codeNetwork_redact;
  "codeNetwork/seed": typeof codeNetwork_seed;
  "consent/gate": typeof consent_gate;
  "consent/outbound": typeof consent_outbound;
  "consent/permission": typeof consent_permission;
  "consent/services": typeof consent_services;
  constants: typeof constants;
  "council/run": typeof council_run;
  "council/settings": typeof council_settings;
  crons: typeof crons;
  decisions: typeof decisions;
  dev: typeof dev;
  diagnosis: typeof diagnosis;
  "evidence/collectors": typeof evidence_collectors;
  "evidence/context": typeof evidence_context;
  "evidence/localProof": typeof evidence_localProof;
  "evidence/records": typeof evidence_records;
  "evidence/snapshots": typeof evidence_snapshots;
  fixOptions: typeof fixOptions;
  fixes: typeof fixes;
  "github/access": typeof github_access;
  "github/api": typeof github_api;
  "github/config": typeof github_config;
  "github/connect": typeof github_connect;
  "github/http": typeof github_http;
  "github/installations": typeof github_installations;
  "github/jwt": typeof github_jwt;
  "github/links": typeof github_links;
  "github/secrets": typeof github_secrets;
  "github/shapes": typeof github_shapes;
  "github/sync": typeof github_sync;
  "github/tokens": typeof github_tokens;
  "github/webhook": typeof github_webhook;
  http: typeof http;
  "intake/dev": typeof intake_dev;
  "intake/http": typeof intake_http;
  "intake/keys": typeof intake_keys;
  "intake/records": typeof intake_records;
  "intake/rules": typeof intake_rules;
  "intake/triage": typeof intake_triage;
  "intake/workflow": typeof intake_workflow;
  keiki: typeof keiki;
  "learning/context": typeof learning_context;
  "learning/feedback": typeof learning_feedback;
  "learning/model": typeof learning_model;
  "learning/preferences": typeof learning_preferences;
  "learning/rules": typeof learning_rules;
  "learning/runs": typeof learning_runs;
  "memory/checks": typeof memory_checks;
  "memory/dev": typeof memory_dev;
  "memory/flow": typeof memory_flow;
  "memory/records": typeof memory_records;
  "memory/reset": typeof memory_reset;
  "memory/service": typeof memory_service;
  monitor: typeof monitor;
  notices: typeof notices;
  "onboarding/brief": typeof onboarding_brief;
  "onboarding/detect": typeof onboarding_detect;
  "onboarding/github": typeof onboarding_github;
  "onboarding/inspect": typeof onboarding_inspect;
  "onboarding/prepare": typeof onboarding_prepare;
  "onboarding/projects": typeof onboarding_projects;
  "onboarding/records": typeof onboarding_records;
  "onboarding/stage": typeof onboarding_stage;
  ownerPasscode: typeof ownerPasscode;
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
  "push/deliver": typeof push_deliver;
  "push/devices": typeof push_devices;
  "push/expo": typeof push_expo;
  "push/localProof": typeof push_localProof;
  "push/message": typeof push_message;
  "revyl/api": typeof revyl_api;
  "revyl/device": typeof revyl_device;
  "revyl/runs": typeof revyl_runs;
  "routing/configs": typeof routing_configs;
  "routing/log": typeof routing_log;
  "routing/models": typeof routing_models;
  "routing/selector": typeof routing_selector;
  "routing/validators": typeof routing_validators;
  "routing/view": typeof routing_view;
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
  "runner/jobs": typeof runner_jobs;
  "runner/run": typeof runner_run;
  "screens/network": typeof screens_network;
  "screens/overview": typeof screens_overview;
  "screens/projects": typeof screens_projects;
  "spend/ledger": typeof spend_ledger;
  "spend/limits": typeof spend_limits;
  "spend/status": typeof spend_status;
  "structural/checks": typeof structural_checks;
  "structural/dev": typeof structural_dev;
  "structural/examine": typeof structural_examine;
  "structural/queries": typeof structural_queries;
  "structural/records": typeof structural_records;
  "structural/rules": typeof structural_rules;
  supermemory: typeof supermemory;
  users: typeof users;
  "voice/openai": typeof voice_openai;
  "voice/progress": typeof voice_progress;
  "voice/rules": typeof voice_rules;
  "voice/runs": typeof voice_runs;
  "voice/turn": typeof voice_turn;
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
