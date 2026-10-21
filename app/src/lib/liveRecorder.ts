// Live recording: keeps a compressed copy of the whole recording (MediaRecorder) and, in parallel,
// cuts the raw audio into short self-contained WAV chunks at natural pauses for live transcription.
// Meeting mode can add what the computer is playing (the other people in an online meeting), captured natively
// (Rust command system_audio_start, WASAPI loopback) and mixed with the microphone; both outputs use the mix.
// The compressed copy is also backed up on this device as it's recorded (lib/recordingBackup.ts).
import { Channel, invoke } from "@tauri-apps/api/core";
import type { AudioBackup } from "./recordingBackup";
import { t } from "./i18n";

export interface LiveChunk {
  seq: number; // 0, 1, 2, ... in recording order
  startMs: number; // offset from the start of the recording
  durationMs: number;
  wav: Blob;
}

export interface LiveRecorderOptions {
  onChunk: (chunk: LiveChunk) => void;
  onLevel?: (level: number) => void; // 0..1, for a mic meter
  minChunkMs?: number; // don't cut before this much audio...
  maxChunkMs?: number; // ...and always cut by this much
  silenceMs?: number; // a pause this long ends a chunk
  mic?: boolean; // record the microphone (default true)
  systemAudio?: boolean; // also record what the computer plays (Windows desktop app only)
  systemDevice?: string | null; // which output device to capture; null/undefined: the default
  backup?: AudioBackup; // gets each second of the compressed recording, for recovery after a crash
}

/** Output devices the computer's audio can be captured from (empty outside the Windows desktop app). */
export async function outputDevices(): Promise<{ name: string; default: boolean }[]> {
  try {
    return await invoke<{ name: string; default: boolean }[]>("system_audio_devices");
  } catch {
    return [];
  }
}

export interface LiveRecording {
  audio: Blob;
  mimeType: string;
  durationMs: number;
}

const FULL_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];
const WINDOW_MS = 20; // voice-activity analysis window
const MIN_SPEECH_MS = 300; // chunks with less speech than this are treated as silence and skipped

// Copies each block of mic samples to the main thread.
const TAP_WORKLET = `
class Tap extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor("tap", Tap);

// Plays samples posted from the main thread (the computer's audio) into the graph; silence when none are queued,
// and drops the oldest audio if more than a second piles up, so it never lags behind the microphone.
class Feed extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.offset = 0;
    this.port.onmessage = (e) => {
      this.queue.push(e.data);
      let total = -this.offset;
      for (const b of this.queue) total += b.length;
      while (total > sampleRate && this.queue.length > 1) {
        total -= this.queue[0].length - this.offset;
        this.queue.shift();
        this.offset = 0;
      }
    };
  }
  process(_inputs, outputs) {
    const out = outputs[0][0];
    let i = 0;
    while (i < out.length && this.queue.length) {
      const b = this.queue[0];
      const n = Math.min(out.length - i, b.length - this.offset);
      out.set(b.subarray(this.offset, this.offset + n), i);
      i += n;
      this.offset += n;
      if (this.offset >= b.length) {
        this.queue.shift();
        this.offset = 0;
      }
    }
    out.fill(0, i);
    return true;
  }
}
registerProcessor("feed", Feed);
`;

export class LiveRecorder {
  private stream: MediaStream | null = null; // the microphone (when used)
  private systemOn = false;
  private ctx: AudioContext | null = null;
  private media: MediaRecorder | null = null;
  private mediaParts: Blob[] = [];
  private mediaType = "audio/webm";
  private releaseLock: (() => void) | null = null;

  private sampleRate = 16000;
  private chunk: Float32Array[] = [];
  private chunkSamples = 0;
  private chunkStartSample = 0;
  private totalSamples = 0;
  private speechMs = 0;
  private trailingSilenceMs = 0;
  private seq = 0;

  private window: number[] = [];
  private noiseFloor = 0.005;
  private lastLevelAt = 0;

  constructor(private readonly opts: LiveRecorderOptions) {}

  async start(): Promise<void> {
    const useMic = this.opts.mic !== false;
    const useSystem = this.opts.systemAudio === true;
    if (!useMic && !useSystem) throw new Error(t("Choose the microphone, the computer's audio, or both"));
    if (useMic) {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    }

    // One graph mixes the sources; the chunks and the whole recording both take the mix. 16 kHz mono is what speech
    // models use.
    this.ctx = new AudioContext({ sampleRate: 16000 });
    this.sampleRate = this.ctx.sampleRate;
    const mix = this.ctx.createGain();
    if (this.stream) this.ctx.createMediaStreamSource(this.stream).connect(mix);
    const sink = this.ctx.createGain();
    sink.gain.value = 0; // keeps the graph running without playing anything back
    sink.connect(this.ctx.destination);

    const worklets = !!this.ctx.audioWorklet;
    if (worklets) {
      const url = URL.createObjectURL(new Blob([TAP_WORKLET], { type: "application/javascript" }));
      await this.ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
    }
    if (useSystem) {
      if (!worklets) throw new Error(t("This system can't mix the computer's audio"));
      const feed = new AudioWorkletNode(this.ctx, "feed", { outputChannelCount: [1] });
      feed.connect(mix);
      const ratio = this.sampleRate / 16000; // the native capture sends 16 kHz
      const channel = new Channel<ArrayBuffer | number[]>();
      channel.onmessage = (data) => {
        const bytes = data instanceof ArrayBuffer ? new Int16Array(data) : new Int16Array(new Uint8Array(data).buffer);
        const n = Math.round(bytes.length * ratio);
        const out = new Float32Array(n);
        for (let i = 0; i < n; i++) out[i] = bytes[Math.min(bytes.length - 1, Math.floor(i / ratio))] / 32768;
        feed.port.postMessage(out, [out.buffer]);
      };
      await invoke("system_audio_start", { onAudio: channel, device: this.opts.systemDevice ?? null });
      this.systemOn = true;
    }

    // Whole recording, compressed (~32 kbps keeps an hour around 15 MB).
    const recordFrom = useSystem ? (() => {
      const dest = this.ctx!.createMediaStreamDestination();
      mix.connect(dest);
      return dest.stream;
    })() : this.stream!;
    const mimeType = FULL_TYPES.find((t) => MediaRecorder.isTypeSupported(t));
    this.media = new MediaRecorder(recordFrom, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: 32000 });
    this.mediaType = this.media.mimeType || mimeType || "audio/webm";
    this.mediaParts = [];
    this.media.ondataavailable = (e) => {
      if (e.data.size === 0) return;
      this.mediaParts.push(e.data);
      this.opts.backup?.append(e.data, (this.totalSamples / this.sampleRate) * 1000);
    };
    this.opts.backup?.begin(this.mediaType);
    this.media.start(1000);

    // A held Web Lock keeps the page from being frozen while the app is in the background (minimized, another app
    // in front), so recording and transcription carry on.
    navigator.locks
      ?.request(`recording-${Date.now()}-${Math.random()}`, () => new Promise<void>((resolve) => (this.releaseLock = resolve)))
      .catch(() => {});

    if (worklets) {
      const tap = new AudioWorkletNode(this.ctx, "tap");
      tap.port.onmessage = (e: MessageEvent<Float32Array>) => this.onSamples(e.data);
      mix.connect(tap).connect(sink);
    } else {
      // Older engines: ScriptProcessorNode is deprecated but universally available.
      const proc = this.ctx.createScriptProcessor(4096, 1, 1);
      proc.onaudioprocess = (e) => this.onSamples(new Float32Array(e.inputBuffer.getChannelData(0)));
      mix.connect(proc).connect(sink);
    }
  }

  private async stopSystem() {
    if (!this.systemOn) return;
    this.systemOn = false;
    await invoke("system_audio_stop").catch(() => {});
  }

  /** Stops recording, emits the final chunk, and returns the whole recording. */
  async stop(): Promise<LiveRecording> {
    this.cut(true);
    const durationMs = (this.totalSamples / this.sampleRate) * 1000;
    const audio = await this.close();
    return { audio, mimeType: this.mediaType, durationMs };
  }

  /** Stops without emitting a last chunk or returning the audio; the backup keeps everything up to here. */
  async cancel(): Promise<void> {
    this.chunk = [];
    this.chunkSamples = 0;
    await this.close();
  }

  /** Stops every source; resolves with the whole recording once its last piece is in (and passed to the backup). */
  private async close(): Promise<Blob> {
    const audio = await new Promise<Blob>((resolve) => {
      if (!this.media || this.media.state === "inactive") {
        resolve(new Blob(this.mediaParts, { type: this.mediaType }));
        return;
      }
      this.media.onstop = () => resolve(new Blob(this.mediaParts, { type: this.mediaType }));
      this.media.stop();
    });

    await this.stopSystem();
    this.stream?.getTracks().forEach((t) => t.stop());
    await this.ctx?.close();
    this.releaseLock?.();
    this.releaseLock = null;
    this.stream = null;
    this.ctx = null;
    this.media = null;
    return audio;
  }

  private onSamples(samples: Float32Array) {
    this.chunk.push(samples);
    this.chunkSamples += samples.length;
    this.totalSamples += samples.length;

    // Voice activity on fixed windows, against an adaptive noise floor.
    const windowSize = Math.round((this.sampleRate * WINDOW_MS) / 1000);
    for (let i = 0; i < samples.length; i++) {
      this.window.push(samples[i]);
      if (this.window.length < windowSize) continue;
      let sum = 0;
      for (const s of this.window) sum += s * s;
      const rms = Math.sqrt(sum / this.window.length);
      this.window = [];

      const threshold = Math.max(0.012, this.noiseFloor * 3);
      if (rms > threshold) {
        this.speechMs += WINDOW_MS;
        this.trailingSilenceMs = 0;
      } else {
        this.trailingSilenceMs += WINDOW_MS;
        this.noiseFloor = this.noiseFloor * 0.98 + rms * 0.02; // only learns from quiet windows
      }

      const now = performance.now();
      if (this.opts.onLevel && now - this.lastLevelAt > 60) {
        this.lastLevelAt = now;
        this.opts.onLevel(Math.min(1, rms / 0.2));
      }
    }

    const lengthMs = (this.chunkSamples / this.sampleRate) * 1000;
    const pause = lengthMs >= (this.opts.minChunkMs ?? 3000) && this.trailingSilenceMs >= (this.opts.silenceMs ?? 600);
    if (pause || lengthMs >= (this.opts.maxChunkMs ?? 12000)) this.cut(false);
  }

  private cut(final: boolean) {
    if (this.chunkSamples === 0) return;
    const hasSpeech = this.speechMs >= MIN_SPEECH_MS;
    if (hasSpeech) {
      const pcm = new Float32Array(this.chunkSamples);
      let offset = 0;
      for (const part of this.chunk) {
        pcm.set(part, offset);
        offset += part.length;
      }
      this.opts.onChunk({
        seq: this.seq++,
        startMs: Math.round((this.chunkStartSample / this.sampleRate) * 1000),
        durationMs: Math.round((this.chunkSamples / this.sampleRate) * 1000),
        wav: encodeWav(pcm, this.sampleRate),
      });
    }
    this.chunkStartSample += this.chunkSamples;
    this.chunk = [];
    this.chunkSamples = 0;
    this.speechMs = 0;
    this.trailingSilenceMs = 0;
    if (final) this.window = [];
  }
}

/** 16-bit PCM mono WAV. */
function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const text = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  text(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  text(36, "data");
  view.setUint32(40, samples.length * 2, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}
