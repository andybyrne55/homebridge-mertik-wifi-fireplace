/**
 * Thin logging wrapper. Info = user-level events, debug = packets / queue / transitions,
 * shown at info level when the fireplace's `debug` option is on (otherwise only with homebridge -D).
 */

export interface LogSink {
  info(message: string, ...params: unknown[]): void;
  warn(message: string, ...params: unknown[]): void;
  error(message: string, ...params: unknown[]): void;
  debug(message: string, ...params: unknown[]): void;
}

export class FireplaceLogger {
  constructor(
    private readonly sink: LogSink,
    private readonly prefix: string,
    private readonly debugEnabled: boolean,
  ) {}

  info(message: string): void {
    this.sink.info(`${this.prefix}: ${message}`);
  }

  warn(message: string): void {
    this.sink.warn(`${this.prefix}: ${message}`);
  }

  error(message: string): void {
    this.sink.error(`${this.prefix}: ${message}`);
  }

  debug(message: string): void {
    if (this.debugEnabled) {
      this.sink.info(`${this.prefix} [debug]: ${message}`);
    } else {
      this.sink.debug(`${this.prefix}: ${message}`);
    }
  }

  get isDebug(): boolean {
    return this.debugEnabled;
  }
}
