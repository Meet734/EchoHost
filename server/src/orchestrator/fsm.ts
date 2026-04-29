// Type-safe finite state machine for the speech-to-speech pipeline

import {
  PipelineState,
  VALID_TRANSITIONS,
  ErrorCode,
  type StateTransitionEvent,
} from "@echohost/shared";

// FSM error with validation details
export class FsmError extends Error {
  public readonly code = ErrorCode.INVALID_STATE_TRANSITION;

  constructor(
    public readonly from: PipelineState,
    public readonly to: PipelineState,
    public readonly sessionId: string
  ) {
    super(
      `[FSM][${sessionId}] Illegal transition: ${from} → ${to}. ` +
        `Valid targets from ${from}: [${VALID_TRANSITIONS[from].join(", ")}]`
    );
    this.name = "FsmError";
  }
}

export type TransitionListener = (event: StateTransitionEvent) => void;

// Core FSM implementation
export class PipelineFSM {
  private _state: PipelineState = PipelineState.IDLE;
  private readonly _history: StateTransitionEvent[] = [];
  private readonly _listeners: Set<TransitionListener> = new Set();

  constructor(
    public readonly sessionId: string,
    initialState: PipelineState = PipelineState.IDLE
  ) {
    this._state = initialState;
  }

  get state(): PipelineState {
    return this._state;
  }

  get history(): readonly StateTransitionEvent[] {
    return this._history;
  }

  onTransition(listener: TransitionListener): () => void {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  // Attempt state transition, throw if invalid
  transition(to: PipelineState): StateTransitionEvent {
    const from = this._state;
    const validTargets = VALID_TRANSITIONS[from];

    if (!(validTargets as readonly PipelineState[]).includes(to)) {
      throw new FsmError(from, to, this.sessionId);
    }

    this._state = to;

    const event: StateTransitionEvent = {
      from,
      to,
      timestamp: Date.now(),
      sessionId: this.sessionId,
    };

    this._history.push(event);
    this._notifyListeners(event);

    return event;
  }

  // Safe transition that returns null if guard fails (used in async callbacks)
  tryTransition(
    expectedFrom: PipelineState,
    to: PipelineState
  ): StateTransitionEvent | null {
    if (this._state !== expectedFrom) return null;
    try {
      return this.transition(to);
    } catch {
      return null;
    }
  }

  // Force ERROR state (unrecoverable errors)
  forceError(): StateTransitionEvent {
    const from = this._state;
    this._state = PipelineState.ERROR;

    const event: StateTransitionEvent = {
      from,
      to: PipelineState.ERROR,
      timestamp: Date.now(),
      sessionId: this.sessionId,
    };

    this._history.push(event);
    this._notifyListeners(event);

    return event;
  }

  is(state: PipelineState): boolean {
    return this._state === state;
  }

  isTerminal(): boolean {
    return this._state === PipelineState.ERROR;
  }

  private _notifyListeners(event: StateTransitionEvent): void {
    for (const listener of this._listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error(
          `[FSM][${this.sessionId}] Transition listener threw:`,
          err
        );
      }
    }
  }
}
