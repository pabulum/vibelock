// Page footer: data attribution, the methodology link, and the fan-tool disclaimer.
import "./Footer.css";

export function Footer(props: { onOpenGuide: () => void }) {
  return (
    <footer className="foot">
      Data:{" "}
      <a href="https://deadlock-api.com" target="_blank" rel="noreferrer">
        deadlock-api.com
      </a>
      .{" "}
      <button type="button" className="guidelink" onClick={props.onOpenGuide}>
        Methodology &amp; glossary →
      </button>
      <div className="disclaimer">
        Vibelock is a fan-made, unofficial tool. Not affiliated with, endorsed
        by, or sponsored by Valve. Deadlock and all related assets are
        trademarks of Valve Corporation.
      </div>
    </footer>
  );
}
