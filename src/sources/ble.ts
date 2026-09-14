/**
 * BleHeartRateSource: RR intervals from a Bluetooth LE chest strap (Heart
 * Rate Service 0x180D, Heart Rate Measurement characteristic 0x2A37) via
 * Web Bluetooth (Chrome on Android/desktop; not available on iOS Safari).
 *
 * Two uses: feed `hrv.analyzeHRV` directly from a strap, or record strap
 * RR intervals alongside camera samples in the same session for
 * validation (Bland-Altman of RMSSD and mean RR).
 */

export interface HeartRateMeasurement {
  /** Beats per minute as reported by the device. */
  heartRate: number;
  /** RR intervals in ms in this packet (0..n), in order. */
  rrIntervalsMs: number[];
  /** Sensor contact status, when the device reports it. */
  contactDetected: boolean | null;
  energyExpendedKj: number | null;
}

/** Parse a Heart Rate Measurement characteristic value (Bluetooth SIG GATT 0x2A37). */
export function parseHeartRateMeasurement(view: DataView): HeartRateMeasurement {
  const flags = view.getUint8(0);
  const hr16 = (flags & 0x01) !== 0;
  const contactSupported = (flags & 0x04) !== 0;
  const contactDetected = contactSupported ? (flags & 0x02) !== 0 : null;
  const energyPresent = (flags & 0x08) !== 0;
  const rrPresent = (flags & 0x10) !== 0;
  let offset = 1;
  const heartRate = hr16 ? view.getUint16(offset, true) : view.getUint8(offset);
  offset += hr16 ? 2 : 1;
  let energyExpendedKj: number | null = null;
  if (energyPresent) { energyExpendedKj = view.getUint16(offset, true); offset += 2; }
  const rrIntervalsMs: number[] = [];
  if (rrPresent) {
    while (offset + 1 < view.byteLength) {
      // RR is in 1/1024 s units.
      rrIntervalsMs.push((view.getUint16(offset, true) * 1000) / 1024);
      offset += 2;
    }
  }
  return { heartRate, rrIntervalsMs, contactDetected, energyExpendedKj };
}

export interface BleBeat { t: number; ibiMs: number; heartRate: number; }

type BluetoothLike = {
  requestDevice: (opts: { filters: Array<{ services: string[] }>; optionalServices?: string[] }) => Promise<BluetoothDeviceLike>;
};
type BluetoothDeviceLike = {
  name?: string;
  gatt?: { connect: () => Promise<GattServerLike>; disconnect: () => void; connected: boolean };
  addEventListener: (type: 'gattserverdisconnected', cb: () => void) => void;
};
type GattServerLike = { getPrimaryService: (uuid: string) => Promise<{ getCharacteristic: (uuid: string) => Promise<CharacteristicLike> }> };
type CharacteristicLike = {
  startNotifications: () => Promise<unknown>;
  stopNotifications: () => Promise<unknown>;
  addEventListener: (type: 'characteristicvaluechanged', cb: (e: Event) => void) => void;
  removeEventListener: (type: 'characteristicvaluechanged', cb: (e: Event) => void) => void;
  value?: DataView;
};

export class BleHeartRateSource extends EventTarget {
  device: BluetoothDeviceLike | null = null;
  private characteristic: CharacteristicLike | null = null;
  private handler: ((e: Event) => void) | null = null;
  private t0: number | null = null;
  private lastBeatT: number | null = null;
  readonly beats: BleBeat[] = [];

  static isSupported(): boolean {
    return typeof navigator !== 'undefined' && 'bluetooth' in navigator;
  }

  /** Prompt for a device (must be called from a user gesture) and start streaming. */
  async start(): Promise<void> {
    if (!BleHeartRateSource.isSupported()) throw new Error('Web Bluetooth is not available in this browser');
    const bluetooth = (navigator as Navigator & { bluetooth: BluetoothLike }).bluetooth;
    const device = await bluetooth.requestDevice({ filters: [{ services: ['heart_rate'] }] });
    this.device = device;
    if (!device.gatt) throw new Error('Device has no GATT server');
    const server = await device.gatt.connect();
    const service = await server.getPrimaryService('heart_rate');
    const ch = await service.getCharacteristic('heart_rate_measurement');
    this.characteristic = ch;
    this.handler = (e: Event) => {
      const target = e.target as unknown as { value?: DataView };
      if (!target.value) return;
      this.onPacket(parseHeartRateMeasurement(target.value));
    };
    ch.addEventListener('characteristicvaluechanged', this.handler);
    await ch.startNotifications();
    device.addEventListener('gattserverdisconnected', () => this.dispatchEvent(new CustomEvent('disconnected')));
    this.dispatchEvent(new CustomEvent('connected', { detail: { name: device.name || null } }));
  }

  /** Feed a parsed packet (public so a recording can be replayed without hardware). */
  onPacket(m: HeartRateMeasurement, nowSec = (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000): void {
    if (this.t0 === null) this.t0 = nowSec;
    // RR intervals arrive in batches; reconstruct beat times by chaining
    // from the previous beat so the tachogram has real spacing.
    for (const rr of m.rrIntervalsMs) {
      const t = this.lastBeatT === null ? nowSec - this.t0 : this.lastBeatT + rr / 1000;
      this.lastBeatT = t;
      const beat: BleBeat = { t, ibiMs: rr, heartRate: m.heartRate };
      this.beats.push(beat);
      this.dispatchEvent(new CustomEvent('beat', { detail: beat }));
    }
    this.dispatchEvent(new CustomEvent('measurement', { detail: m }));
  }

  async stop(): Promise<void> {
    if (this.characteristic && this.handler) {
      try { await this.characteristic.stopNotifications(); } catch { /* no-op */ }
      this.characteristic.removeEventListener('characteristicvaluechanged', this.handler);
    }
    if (this.device && this.device.gatt && this.device.gatt.connected) this.device.gatt.disconnect();
    this.characteristic = null;
    this.handler = null;
  }
}
