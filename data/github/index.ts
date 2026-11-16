import { isLiveData } from "../source";
import * as example from "./example";
import * as live from "./live";

export type { GithubConnection, GithubDisconnect, GithubLeftOut, GithubRefresh, GithubRepository, GithubReturn, GithubStatus } from "./types";

export const useGithubStatus = isLiveData ? live.useGithubStatus : example.useGithubStatus;
export const useGithubRepositories = isLiveData ? live.useGithubRepositories : example.useGithubRepositories;
export const beginGithubConnect = isLiveData ? live.beginGithubConnect : example.beginGithubConnect;
export const finishGithubConnect = isLiveData ? live.finishGithubConnect : example.finishGithubConnect;
export const refreshGithubRepositories = isLiveData ? live.refreshGithubRepositories : example.refreshGithubRepositories;
export const disconnectGithub = isLiveData ? live.disconnectGithub : example.disconnectGithub;
