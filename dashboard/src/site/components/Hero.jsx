import { buttonClasses } from "./ui/button.jsx";
import { docsLinks, ossLinks } from "../config/links.js";
import { Badge } from "./ui/badge.jsx";

export default function Hero() {
  return (
    <section className="section-shell" id="hero">
      <div className="mx-auto max-w-5xl">
        <p className="mb-4 text-xs font-bold uppercase tracking-[0.2em] text-[#7f2f1f]">
          Open-source runtime for AI agents
        </p>
        <h1 className="max-w-[11ch] text-[clamp(3rem,9vw,6.25rem)] font-bold leading-[0.95] tracking-[-0.03em] text-[#1b2430]">
          Run agents with real-world guardrails.
        </h1>
        <p className="mt-6 max-w-3xl text-lg leading-relaxed text-[#354152]">
          Set clear limits, require human approval when needed, and verify what happened after every action.
        </p>

        <div className="mt-6 flex flex-wrap gap-2">
          <Badge variant="accent">Set limits</Badge>
          <Badge variant="accent">Require approval</Badge>
          <Badge variant="accent">Verify outcomes</Badge>
        </div>

        <div className="mt-10 flex flex-wrap gap-3">
          <a className={buttonClasses({ size: "lg" })} href={docsLinks.quickstart}>
            Get started
          </a>
          <a className={buttonClasses({ variant: "outline", size: "lg" })} href={ossLinks.repo}>
            View GitHub
          </a>
        </div>
      </div>
    </section>
  );
}
