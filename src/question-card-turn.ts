export class QuestionCardTurnQueue {
  private tail: Promise<void> = Promise.resolve();
  private terminalRequested = false;
  private terminalAttempt: symbol | undefined;

  constructor(
    private readonly onError: (error: unknown) => void,
    private readonly onTerminalSuccess: () => void = () => undefined,
  ) {}

  enqueueUpdate(task: () => Promise<void>): Promise<void> {
    const operation = this.tail.then(async () => {
      if (this.terminalRequested) return;
      await task();
    });
    this.tail = operation.catch((error) => this.onError(error));
    return this.tail;
  }

  enqueueTerminal<T>(task: () => Promise<T>): Promise<T> {
    const attempt = Symbol('question-card-terminal');
    this.terminalAttempt = attempt;
    this.terminalRequested = true;
    const operation = this.tail.then(task).then((result) => {
      this.onTerminalSuccess();
      return result;
    });
    this.tail = operation.then(
      () => undefined,
      (error) => {
        if (this.terminalAttempt === attempt) {
          this.terminalRequested = false;
          this.terminalAttempt = undefined;
        }
        this.onError(error);
      },
    );
    return operation;
  }

  wait(): Promise<void> {
    return this.tail;
  }
}
