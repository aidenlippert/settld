import { buttonClasses } from "./ui/button.jsx";

export default function Hero() {
  return (
    <section className="section-shell" id="hero">
      <div className="mx-auto max-w-5xl">
        <p className="mb-4 text-xs font-bold uppercase tracking-[0.2em] text-[#7f2f1f]">
          Autonomous Commerce Infrastructure
        </p>
        <h1 className="max-w-[11ch] text-[clamp(3rem,9vw,6.25rem)] font-bold leading-[0.95] tracking-[-0.03em] text-[#1b2430]">
          The future runs on agents. Agents run on Settld.
        </h1>
        <p className="mt-6 max-w-3xl text-lg leading-relaxed text-[#354152]">
          You build the AI. We enforce the financial boundaries and demand cryptographic proof of execution. The
          uncompromising foundation for a trustless economy.
        </p>

        <div className="mt-10 flex flex-wrap gap-3">
          <a className={buttonClasses({ size: "lg" })} href="/docs/integrations">
            Start with MCP
          </a>
          <a className={buttonClasses({ variant: "outline", size: "lg" })} href="/pilot">
            Request pilot
          </a>
        </div>
      </div>
    </section>
  );
}
