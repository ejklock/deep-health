export class ConfigLoadError extends Error {
  constructor(message: string, public readonly path: string) {
    super(message);
    this.name = 'ConfigLoadError';
  }
}

export class EnvironmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvironmentError';
  }
}

export class PhaseError extends Error {
  constructor(
    message: string,
    public readonly phase: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'PhaseError';
  }
}

export class GateValidationError extends Error {
  constructor(
    message: string,
    /** Gate identifier: 'A' for scan gate, or a plugin id (e.g. 'npm', 'composer') for update gates */
    public readonly gate: string,
    public readonly errors: string[],
  ) {
    super(message);
    this.name = 'GateValidationError';
  }
}
