export interface SonarQubeQualityGateCondition {
  status: string;
  metricKey: string;
  comparator: string;
  errorThreshold?: string;
  actualValue?: string;
}

export interface SonarQubeIssue {
  key: string;
  rule: string;
  severity: string;
  component: string;
  line?: number;
  message: string;
  type: string;
  status: string;
}

export interface SonarQubeScanMetadata {
  qualityGateStatus: string;
  qualityGatePassed: boolean;
  qualityGateConditions?: SonarQubeQualityGateCondition[];
  metrics?: Record<string, string>;
  issues?: SonarQubeIssue[];
  ceTaskOutcome?: 'success' | 'timeout' | 'failed' | 'skipped';
  scanDurationMs?: number;
}
