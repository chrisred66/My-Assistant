// Live recording: keeps a compressed copy of the whole recording (MediaRecorder) and, in parallel,
// cuts the raw audio into short self-contained WAV chunks at natural pauses for live transcription.

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
`;

export class LiveRecorder {
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private media: MediaRecorder | null = null;
  private mediaParts: Blob[] = [];
  private mediaType = "audio/webm";

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
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });

    // Whole recording, compressed (~32 kbps keeps an hour around 15 MB).
    const mimeType = FULL_TYPES.find((t) => MediaRecorder.isTypeSupported(t));
    this.media = new MediaRecorder(this.stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: 32000 });
    this.mediaType = this.media.mimeType || mimeType || "audio/webm";
    this.mediaParts = [];
    this.media.ondataavailable = (e) => {
      if (e.data.size > 0) this.mediaParts.push(e.data);
    };
    this.media.start(1000);

    // Raw samples for the transcription chunks. 16 kHz mono is what speech models use.
    this.ctx = new AudioContext({ sampleRate: 16000 });
    this.sampleRate = this.ctx.sampleRate;
    const source = this.ctx.createMediaStreamSource(this.stream);
    const sink = this.ctx.createGain();
    sink.gain.value = 0; // keeps the graph running without playing the mic back
    sink.connect(this.ctx.destination);

    if (this.ctx.audioWorklet) {
      const url = URL.createObjectURL(new Blob([TAP_WORKLET], { type: "application/javascript" }));
      await this.ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      const tap = new AudioWorkletNode(this.ctx, "tap");
      tap.port.onmessage = (e: MessageEvent<Float32Array>) => this.onSamples(e.data);
      source.connect(tap).connect(sink);
    } else {
      // Older engines: ScriptProcessorNode is deprecated but universally available.
      const proc = this.ctx.createScriptProcessor(4096, 1, 1);
      proc.onaudioprocess = (e) => this.onSamples(new Float32Array(e.inputBuffer.getChannelData(0)));
      source.connect(proc).connect(sink);
    }
  }

  /** Stops recording, emits the final chunk, and returns the whole recording. */
  async stop(): Promise<LiveRecording> {
    this.cut(true);
    const durationMs = (this.totalSamples / this.sampleRate) * 1000;

    const audio = await new Promise<Blob>((resolve) => {
      if (!this.media || this.media.state === "inactive") {
        resolve(new Blob(this.mediaParts, { type: this.mediaType }));
        return;
      }
      this.media.onstop = () => resolve(new Blob(this.mediaParts, { type: this.mediaType }));
      this.media.stop();
    });

    this.stream?.getTracks().forEach((t) => t.stop());
    await this.ctx?.close();
    this.stream = null;
    this.ctx = null;
    this.media = null;
    return { audio, mimeType: this.mediaType, durationMs };
  }

  /** Abandons the recording without emitting anything. */
  async cancel(): Promise<void> {
    this.chunk = [];
    this.chunkSamples = 0;
    if (this.media && this.media.state !== "inactive") this.media.stop();
    this.stream?.getTracks().forEach((t) => t.stop());
    await this.ctx?.close();
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
