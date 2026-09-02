export interface CaseSummary {
  caseId: string;
  referenceNumber: string;
  agreementReference: string;
  overallStatus: string;
  currentStepName: string;
  pendingTaskCount: number;
  nextDueDate: string | null;
  lastUpdatedAt: string;
}
