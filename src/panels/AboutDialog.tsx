import type { AppInfo } from '../model/types';

export function AboutDialog({ info, onClose }: { info: AppInfo | null; onClose(): void }) {
  return (
    <div className="scrim" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog about" role="dialog" aria-modal="true" aria-labelledby="about-title">
        <div className="dialog-head">
          <img className="about-logo" src="/brand/vier-black.svg" alt="VierApparatus" />
        </div>
        <div>
          <h2 id="about-title">VierVideo {info?.version ?? ''}</h2>
          <p>Turns HTML animations into narrated videos for Instagram, YouTube and other platforms.</p>
        </div>
        <p>
          <strong>Developer:</strong> VierApparatus
        </p>
        <p>Everything runs on this computer. No account, login or paid service is needed.</p>
        <div>
          <strong>Built with</strong>
          <ul>
            <li>Electron, React and Vite</li>
            <li>Jost typeface, SIL Open Font License (via @fontsource)</li>
            <li>Planned: Kokoro-82M for local voice-over (Apache-2.0), FFmpeg for encoding (see its licence)</li>
          </ul>
        </div>
        <div className="dialog-foot">
          <button className="btn primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
