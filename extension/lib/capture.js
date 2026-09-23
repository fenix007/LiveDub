// Звук вкладки после tabCapture перестаёт играть в колонках, поэтому
// одна ветка графа возвращает его на выход (с регулируемой громкостью для
// приглушения во время озвучки), а вторая готовит PCM 16 кГц для Deepgram.
export async function startTabAudio({ context, stream, workletUrl, onPcm }) {
  await context.audioWorklet.addModule(workletUrl);
  const source = context.createMediaStreamSource(stream);
  const monitor = context.createGain();
  source.connect(monitor).connect(context.destination);

  const lowpass1 = context.createBiquadFilter();
  const lowpass2 = context.createBiquadFilter();
  for (const filter of [lowpass1, lowpass2]) {
    filter.type = 'lowpass';
    filter.frequency.value = 6500;
    filter.Q.value = Math.SQRT1_2;
  }
  const worklet = new AudioWorkletNode(context, 'pcm16k', { outputChannelCount: [1] });
  const sink = context.createGain();
  sink.gain.value = 0; // worklet должен быть подключён к выходу, но без повторного звука
  worklet.port.onmessage = ({ data }) => { if (data.byteLength) onPcm(data); };
  source.connect(lowpass1).connect(lowpass2).connect(worklet).connect(sink).connect(context.destination);
  await context.resume();

  return {
    setVolume(value) { monitor.gain.setTargetAtTime(value, context.currentTime, 0.08); },
    stop() {
      worklet.port.close();
      for (const node of [source, monitor, lowpass1, lowpass2, worklet, sink]) node.disconnect();
    },
  };
}
