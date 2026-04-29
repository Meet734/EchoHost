// Fixed-capacity ring buffer for 16-bit PCM audio (no GC pressure)

import { ErrorCode } from "@echohost/shared";

export class AudioBufferOverflowError extends Error {
  public readonly code = ErrorCode.AUDIO_BUFFER_OVERFLOW;
  constructor(capacity: number) {
    super(`AudioRingBuffer overflow — capacity: ${capacity} samples`);
    this.name = "AudioBufferOverflowError";
  }
}

export class AudioRingBuffer {
  private readonly _buffer: Int16Array;
  private _writeHead = 0;
  private _readHead = 0;
  private _size = 0;
  private _overflowCount = 0;

  constructor(public readonly capacity: number) {
    if (capacity <= 0 || !Number.isInteger(capacity)) {
      throw new RangeError(
        `AudioRingBuffer capacity must be a positive integer, got ${capacity}`
      );
    }
    this._buffer = new Int16Array(capacity);
  }

  // Write samples, dropping oldest if needed
  write(samples: Int16Array): void {
    const incoming = samples.length;

    if (incoming > this.capacity) {
      const offset = incoming - this.capacity;
      this._writeAll(samples.subarray(offset));
      this._overflowCount++;
      return;
    }

    const available = this.capacity - this._size;
    if (incoming > available) {
      const overflow = incoming - available;
      this._readHead = (this._readHead + overflow) % this.capacity;
      this._size -= overflow;
      this._overflowCount++;
    }

    this._writeAll(samples);
  }

  // Read up to count samples
  read(count: number): Int16Array {
    const actual = Math.min(count, this._size);
    if (actual === 0) return new Int16Array(0);

    const out = new Int16Array(actual);
    const tail = Math.min(actual, this.capacity - this._readHead);

    out.set(this._buffer.subarray(this._readHead, this._readHead + tail));
    if (tail < actual) {
      out.set(this._buffer.subarray(0, actual - tail), tail);
    }

    this._readHead = (this._readHead + actual) % this.capacity;
    this._size -= actual;

    return out;
  }

  // Read all samples and reset
  drain(): Int16Array {
    return this.read(this._size);
  }

  // Peek without advancing read head
  peek(count: number): Int16Array {
    const actual = Math.min(count, this._size);
    if (actual === 0) return new Int16Array(0);

    const out = new Int16Array(actual);
    const tail = Math.min(actual, this.capacity - this._readHead);

    out.set(this._buffer.subarray(this._readHead, this._readHead + tail));
    if (tail < actual) {
      out.set(this._buffer.subarray(0, actual - tail), tail);
    }

    return out;
  }

  get size(): number {
    return this._size;
  }

  get isFull(): boolean {
    return this._size === this.capacity;
  }

  get isEmpty(): boolean {
    return this._size === 0;
  }

  get overflowCount(): number {
    return this._overflowCount;
  }

  get fillRatio(): number {
    return this._size / this.capacity;
  }

  reset(): void {
    this._writeHead = 0;
    this._readHead = 0;
    this._size = 0;
  }

  private _writeAll(samples: Int16Array): void {
    const len = samples.length;
    const tail = Math.min(len, this.capacity - this._writeHead);

    this._buffer.set(samples.subarray(0, tail), this._writeHead);
    if (tail < len) {
      this._buffer.set(samples.subarray(tail), 0);
    }

    this._writeHead = (this._writeHead + len) % this.capacity;
    this._size = Math.min(this._size + len, this.capacity);
  }
}
