/**
 * 录课页（设计文档 2.6）。
 *
 * 合成 Canvas = 阅读器页面 + 摄像头小窗 + 手写标注层，
 * 经 canvas.captureStream(30) → MediaRecorder → video/webm。
 *
 * @module ebook-reader/pages/RecordPage
 */

import { useEffect, useRef, useState } from 'react';

import { useReaderStore } from '../store.js';

/** 录制状态。 */
type RecorderState = 'idle' | 'recording' | 'paused' | 'stopped';

/** 录课页。 */
export function RecordPage(): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const recorderRef = useRef<MediaRecorder | undefined>(undefined);
  const chunksRef = useRef<Blob[]>([]);
  const [state, setState] = useState<RecorderState>('idle');
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState<string | undefined>(undefined);
  const { recordings, currentBook } = useReaderStore();

  useEffect(() => {
    let timer: number | undefined;
    if (state === 'recording') {
      timer = window.setInterval(() => setDuration((d) => d + 1), 1000);
    }
    return () => {
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, [state]);

  /** 开始录制：合成 Canvas + 摄像头 + 麦克风。 */
  const start = async (): Promise<void> => {
    setError(undefined);
    try {
      const canvas = canvasRef.current;
      if (canvas === null) throw new Error('画布未就绪');
      const stream = canvas.captureStream(30);
      // 摄像头小窗
      const camera = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      for (const track of camera.getVideoTracks()) stream.addTrack(track);
      for (const track of camera.getAudioTracks()) stream.addTrack(track);
      if (videoRef.current !== null) {
        videoRef.current.srcObject = camera;
        await videoRef.current.play();
      }
      const recorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
      chunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.start(1000);
      recorderRef.current = recorder;
      setState('recording');
      setDuration(0);
    } catch (cause) {
      setError(`无法开始录制：${(cause as Error).message}`);
    }
  };

  const stop = (): void => {
    recorderRef.current?.stop();
    recorderRef.current = undefined;
    setState('stopped');
  };

  return (
    <div className="record">
      <header className="record-header">
        <h1>录课</h1>
        {currentBook !== undefined && <span>当前书籍：《{currentBook.title}》</span>}
      </header>

      <div className="record-stage">
        <canvas ref={canvasRef} width={1280} height={720} className="record-canvas" />
        <video ref={videoRef} muted playsInline className="record-camera" />
        <div className="record-ink-layer" />
      </div>

      <div className="record-controls">
        {state === 'recording' ? (
          <button type="button" className="record-stop" onClick={stop}>
            停止（{formatDuration(duration)}）
          </button>
        ) : (
          <button type="button" className="record-start" onClick={() => void start()}>
            开始录制
          </button>
        )}
        {error !== undefined && <p className="record-error">{error}</p>}
      </div>

      <section className="record-list">
        <h2>已有录课（{recordings.length}）</h2>
        {recordings.length === 0 && <p>还没有录课视频。</p>}
        <ul>
          {recordings.map((rec) => (
            <li key={rec.id}>
              {rec.title} · {formatDuration(rec.duration_seconds)}
              {rec.position_at_start !== undefined && <span className="record-anchor">定位于书籍内容</span>}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

/** 秒 → mm:ss。 */
export function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
