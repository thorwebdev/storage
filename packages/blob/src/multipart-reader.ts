import bytes from 'bytes';
import { debug } from './debug';
import { PartSizeInBytes, type MultipartMemory } from './multipart-memory';
import type { MultipartApi } from './multipart-api';
import type { MultipartController } from './multipart-controller';

export class MultipartReader {
  private _done = false;
  private _reading = false;

  private currentPartNumber = 1;

  // holds data until we have enough to send a part
  private currentPart: ArrayBuffer[] = [];
  private currentPartSize = 0;

  private reader: ReadableStreamDefaultReader<ArrayBuffer>;

  constructor(
    readonly stream: ReadableStream<ArrayBuffer>,
    private readonly controller: MultipartController,
    private readonly api: MultipartApi,
    private readonly memory: MultipartMemory,
  ) {
    this.reader = stream.getReader();
  }

  private get partNumber(): number {
    return this.currentPartNumber++;
  }

  private uploadPart(): void {
    this.api.upload({
      partNumber: this.partNumber,
      blob: new Blob(this.currentPart, { type: 'application/octet-stream' }),
    });

    this.currentPart = [];
    this.currentPartSize = 0;
  }

  private get partIsReady(): boolean {
    return this.currentPartSize === PartSizeInBytes;
  }

  // This code ensures that each part will be exactly of `partSizeInBytes` size
  // Otherwise R2 will refuse it. AWS S3 is fine with parts of different sizes.
  private processValue(value: ArrayBuffer): void {
    let valueOffset = 0;
    while (valueOffset < value.byteLength) {
      const remainingPartSize = PartSizeInBytes - this.currentPartSize;

      const endOffset = Math.min(
        valueOffset + remainingPartSize,
        value.byteLength,
      );

      const chunk = value.slice(valueOffset, endOffset);

      this.currentPart.push(chunk);
      this.currentPartSize += chunk.byteLength;

      valueOffset = endOffset;

      if (this.partIsReady) {
        this.uploadPart();
      }
    }
  }

  public async read(): Promise<void> {
    debug(
      'mpu: upload read start',
      'activeUploads:',
      this.api.activeUploads,
      'currentBytesInMemory:',
      this.memory.debug(),
      'bytesSent:',
      bytes(this.api.totalBytesSent),
    );

    this._reading = true;

    while (this.memory.hasSpace() && !this.controller.canceled) {
      try {
        // eslint-disable-next-line no-await-in-loop -- A for loop is fine here.
        const { value, done } = await this.reader.read();

        if (done) {
          this._done = true;
          this._reading = false;
          debug('mpu: upload read consumed the whole stream');

          // done is sent when the stream is fully consumed. `value` is undefined here,
          // we just need to send the rest data in memory
          if (this.currentPart.length > 0) {
            this.uploadPart();
          }

          return;
        }

        this.memory.useSpace(value.byteLength);

        this.processValue(value);
      } catch (error) {
        this.controller.cancel(error);
      }
    }

    debug(
      'mpu: upload read end',
      'activeUploads:',
      this.api.activeUploads,
      'currentBytesInMemory:',
      this.memory.debug(),
      'bytesSent:',
      bytes(this.api.totalBytesSent),
    );

    this._reading = false;
  }

  public get done(): boolean {
    return this._done;
  }

  public get reading(): boolean {
    return this._reading;
  }

  public releaseLock(): void {
    this.reader.releaseLock();
  }
}
