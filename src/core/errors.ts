/** Stable error codes for camera / environment failures. */
export type PPGErrorCode =
  | 'insecure_context'
  | 'unsupported'
  | 'permission_denied'
  | 'no_camera'
  | 'camera_busy'
  | 'overconstrained'
  | 'aborted'
  | 'unknown';

const GUIDANCE: Record<PPGErrorCode, string> = {
  insecure_context: 'Camera access needs HTTPS (or localhost). Open the page over a secure connection.',
  unsupported: 'This browser cannot access the camera. Open the page in Safari or Chrome rather than an in-app browser.',
  permission_denied: 'Camera permission was denied. Allow camera access for this site and try again.',
  no_camera: 'No camera was found on this device.',
  camera_busy: 'The camera is in use by another app or tab. Close it and try again.',
  overconstrained: 'The camera does not support the requested settings.',
  aborted: 'The camera was interrupted.',
  unknown: 'The camera could not be started.'
};

export class PPGError extends Error {
  readonly code: PPGErrorCode;
  readonly guidance: string;
  readonly cause?: unknown;

  constructor(code: PPGErrorCode, message?: string, cause?: unknown) {
    super(message || GUIDANCE[code]);
    this.name = 'PPGError';
    this.code = code;
    this.guidance = GUIDANCE[code];
    this.cause = cause;
  }

  /** Map a getUserMedia / environment error onto a PPGError. */
  static from(err: unknown): PPGError {
    if (err instanceof PPGError) return err;
    const name = (err && typeof err === 'object' && 'name' in err) ? String((err as { name: unknown }).name) : '';
    const msg = (err && typeof err === 'object' && 'message' in err) ? String((err as { message: unknown }).message) : String(err);
    switch (name) {
      case 'NotAllowedError':
      case 'PermissionDeniedError':
      case 'SecurityError':
        return new PPGError('permission_denied', msg, err);
      case 'NotFoundError':
      case 'DevicesNotFoundError':
        return new PPGError('no_camera', msg, err);
      case 'NotReadableError':
      case 'TrackStartError':
        return new PPGError('camera_busy', msg, err);
      case 'OverconstrainedError':
      case 'ConstraintNotSatisfiedError':
        return new PPGError('overconstrained', msg, err);
      case 'AbortError':
        return new PPGError('aborted', msg, err);
      default:
        return new PPGError('unknown', msg, err);
    }
  }
}
