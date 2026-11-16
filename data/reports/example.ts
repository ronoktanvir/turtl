import type { CustomerReports } from "./types";

// Example data has no customer reports to delete, so the case screen shows no report control and looks as it did.
export function useCustomerReports(_caseId: string): CustomerReports | null | undefined {
  return null;
}

export async function deleteCustomerReport(_caseId: string, _reportId: string): Promise<{ reportCount: number; people: number }> {
  throw new Error("Example data has no customer reports to delete.");
}
