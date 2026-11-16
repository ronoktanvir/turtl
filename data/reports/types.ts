// What customers wrote on one case, through the report form, newest first. Contact details never reach the app.

export type CustomerReport = { id: string; text: string; receivedAt: number };

export type CustomerReports = { people: number; reports: CustomerReport[] };
