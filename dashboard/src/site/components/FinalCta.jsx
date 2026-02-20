import { buttonClasses } from "./ui/button.jsx";
import { Card } from "./ui/card.jsx";
import { docsLinks, ossLinks } from "../config/links.js";

export default function FinalCta() {
  return (
    <section className="section-shell">
      <Card className="bg-gradient-to-br from-[#1f1f1f] to-[#292522] text-[#f7f2ea] shadow-[0_18px_45px_rgba(0,0,0,0.3)]">
        <p className="mb-3 text-xs font-bold uppercase tracking-[0.2em] text-[#e2c0b5]">Footer Call to Action</p>
        <h2 className="text-[clamp(2rem,5vw,3.4rem)] font-bold leading-[1] tracking-[-0.02em]">
          Open source. Build now.
        </h2>
        <p className="mt-4 max-w-3xl text-lg leading-relaxed text-[#efe5da]">
          Start with docs, run locally, and contribute on GitHub.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <a className={buttonClasses({ className: "bg-[#f7f2ea] text-[#1f1f1f] hover:bg-white" })} href={docsLinks.home}>
            Read docs
          </a>
          <a
            className={buttonClasses({
              variant: "outline",
              className: "border-[#b5968a] bg-transparent text-[#f7f2ea] hover:bg-[#3a3531]"
            })}
            href={ossLinks.repo}
          >
            Contribute on GitHub
          </a>
        </div>
      </Card>
    </section>
  );
}
