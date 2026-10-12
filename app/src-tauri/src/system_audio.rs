// Meeting mode: what the computer is playing (the other people in an online meeting), captured from an output device
// (the default, or one chosen: meeting apps may play through their own, e.g. a headset's "Chat" device) with WASAPI
// loopback (cpal opens an output device as an input). Sent to the app as 16 kHz mono 16-bit
// PCM in ~100 ms blocks over a Tauri channel; the app mixes it with the microphone. Windows only.

use std::sync::mpsc;
use std::sync::Mutex;

/// The running capture's stop signal (one capture at a time).
#[derive(Default)]
pub struct SystemAudio(pub Mutex<Option<mpsc::Sender<()>>>);

const TARGET_RATE: f64 = 16_000.0;
const BLOCK: usize = 1_600; // samples per message: 100 ms

/// Mono f32 at the device rate -> 16 kHz: a one-pole low-pass (against aliasing), then linear interpolation.
struct Resampler {
    step: f64,  // input samples per output sample
    phase: f64, // position of the next output, in input samples after `last`
    last: f32,
    lp: f32,
    alpha: f32,
}

impl Resampler {
    fn new(rate: f64) -> Self {
        let cutoff = 7_000.0_f64.min(rate / 2.0 * 0.9);
        Resampler {
            step: rate / TARGET_RATE,
            phase: 0.0,
            last: 0.0,
            lp: 0.0,
            alpha: (1.0 - (-2.0 * std::f64::consts::PI * cutoff / rate).exp()) as f32,
        }
    }

    fn push(&mut self, input: &[f32], out: &mut Vec<i16>) {
        if input.is_empty() {
            return;
        }
        // v[0] = last sample of the previous block, v[k] = filtered input[k - 1].
        let mut v = Vec::with_capacity(input.len() + 1);
        v.push(self.last);
        for &x in input {
            self.lp += self.alpha * (x - self.lp);
            v.push(self.lp);
        }
        let n = input.len() as f64;
        let mut p = self.phase;
        while p < n {
            let i = p.floor() as usize;
            let frac = (p - i as f64) as f32;
            let s = v[i] + frac * (v[i + 1] - v[i]);
            out.push((s.clamp(-1.0, 1.0) * 32767.0) as i16);
            p += self.step;
        }
        self.phase = p - n;
        self.last = v[input.len()];
    }
}

#[derive(serde::Serialize)]
pub struct OutputDevice {
    name: String,
    default: bool,
}

/// Output devices that can be captured, the default marked.
#[cfg(windows)]
pub fn devices() -> Result<Vec<OutputDevice>, String> {
    use cpal::traits::{DeviceTrait, HostTrait};
    let host = cpal::default_host();
    let default = host.default_output_device().and_then(|d| d.name().ok());
    Ok(host
        .output_devices()
        .map_err(|e| e.to_string())?
        .filter_map(|d| d.name().ok())
        .map(|name| OutputDevice { default: Some(&name) == default.as_ref(), name })
        .collect())
}

#[cfg(not(windows))]
pub fn devices() -> Result<Vec<OutputDevice>, String> {
    Ok(Vec::new())
}

/// `device`: an output device's name; None (or one no longer there) uses the default.
#[cfg(windows)]
pub fn start(state: &SystemAudio, channel: tauri::ipc::Channel, device: Option<String>) -> Result<u32, String> {
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

    stop(state);
    let (stop_tx, stop_rx) = mpsc::channel::<()>();
    let (ready_tx, ready_rx) = mpsc::channel::<Result<u32, String>>();

    // cpal streams can't move between threads, so one thread owns the stream until it's told to stop.
    std::thread::spawn(move || {
        let setup = (|| -> Result<cpal::Stream, String> {
            let host = cpal::default_host();
            let chosen = device.and_then(|want| {
                host.output_devices().ok()?.find(|d| d.name().map(|n| n == want).unwrap_or(false))
            });
            let device = chosen.or_else(|| host.default_output_device()).ok_or("No audio output device")?;
            let config = device.default_output_config().map_err(|e| e.to_string())?;
            let channels = config.channels() as usize;
            let rate = config.sample_rate().0 as f64;
            let format = config.sample_format();
            let mut resampler = Resampler::new(rate);
            let mut pending: Vec<i16> = Vec::with_capacity(BLOCK * 2);
            let mut mono: Vec<f32> = Vec::new();
            let tx = channel.clone();

            // Downmix one buffer to mono, resample, and send whole blocks.
            let mut handle = move |frames: &mut dyn Iterator<Item = f32>| {
                mono.clear();
                let mut sum = 0.0;
                let mut k = 0;
                for s in frames {
                    sum += s;
                    k += 1;
                    if k == channels {
                        mono.push(sum / channels as f32);
                        sum = 0.0;
                        k = 0;
                    }
                }
                resampler.push(&mono, &mut pending);
                while pending.len() >= BLOCK {
                    let bytes: Vec<u8> = pending.drain(..BLOCK).flat_map(|s| s.to_le_bytes()).collect();
                    let _ = tx.send(tauri::ipc::InvokeResponseBody::Raw(bytes));
                }
            };
            let err = |e: cpal::StreamError| eprintln!("system audio: {e}");
            let stream = match format {
                cpal::SampleFormat::F32 => device.build_input_stream(
                    &config.into(),
                    move |data: &[f32], _: &cpal::InputCallbackInfo| handle(&mut data.iter().copied()),
                    err,
                    None,
                ),
                cpal::SampleFormat::I16 => device.build_input_stream(
                    &config.into(),
                    move |data: &[i16], _: &cpal::InputCallbackInfo| handle(&mut data.iter().map(|&s| s as f32 / 32768.0)),
                    err,
                    None,
                ),
                other => return Err(format!("Unsupported audio format {other:?}")),
            }
            .map_err(|e| e.to_string())?;
            stream.play().map_err(|e| e.to_string())?;
            Ok(stream)
        })();
        match setup {
            Ok(stream) => {
                let _ = ready_tx.send(Ok(TARGET_RATE as u32));
                let _ = stop_rx.recv(); // until stop() (or the sender is dropped)
                drop(stream);
            }
            Err(e) => {
                let _ = ready_tx.send(Err(e));
            }
        }
    });

    let rate = ready_rx.recv().map_err(|e| e.to_string())??;
    *state.0.lock().unwrap() = Some(stop_tx);
    Ok(rate)
}

#[cfg(not(windows))]
pub fn start(_state: &SystemAudio, _channel: tauri::ipc::Channel, _device: Option<String>) -> Result<u32, String> {
    Err("Capturing the computer's audio is only available on Windows".into())
}

pub fn stop(state: &SystemAudio) {
    if let Some(tx) = state.0.lock().unwrap().take() {
        let _ = tx.send(());
    }
}
