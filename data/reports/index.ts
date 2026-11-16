import { isLiveData } from "../source";
import * as example from "./example";
import * as live from "./live";

export type { CustomerReport, CustomerReports } from "./types";

export const useCustomerReports = isLiveData ? live.useCustomerReports : example.useCustomerReports;
export const deleteCustomerReport = isLiveData ? live.deleteCustomerReport : example.deleteCustomerReport;
