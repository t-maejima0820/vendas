export interface StealthViolation {
  file: string;
  line: number;
  col: number;
  rule: string;
  message: string;
}

export function scanSourceText(
  code: string,
  filePath: string,
): { file: string; violations: StealthViolation[] };
