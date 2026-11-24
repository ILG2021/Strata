import { tr } from '../lib/i18n';

/** What Strata collects and where things go: one compact paragraph (the six sentences read together, translated as one in every language). */
const NOTES = "Strata sends no usage telemetry. Conversations stay on this computer, in Strata's data folder. Downloads and update checks use GitHub and Hugging Face only. If you share Strata or open a Cloudflare tunnel, requests and answers pass over that network. The UI request log keeps client, timing and token metadata in memory. Native API monitoring can retain request content in memory when enabled.";

export function PrivacyNotes() {
  return <div className="privacy-notes" aria-label={tr("Collection and logs")}>
    <p>{tr(NOTES)}</p>
  </div>;
}
