import SiteNav from "./components/SiteNav.jsx";
import Hero from "./components/Hero.jsx";
import ProofStrip from "./components/ProofStrip.jsx";
import KernelNow from "./components/KernelNow.jsx";
import SocialProofStrip from "./components/SocialProofStrip.jsx";
import ChainFlow from "./components/ChainFlow.jsx";
import DemoRecording from "./components/DemoRecording.jsx";
import Verifiability from "./components/Verifiability.jsx";
import DeterministicLayer from "./components/DeterministicLayer.jsx";
import Quickstart from "./components/Quickstart.jsx";
import Vision from "./components/Vision.jsx";
import PricingStrip from "./components/PricingStrip.jsx";
import ChangelogSection from "./components/ChangelogSection.jsx";
import FaqSection from "./components/FaqSection.jsx";
import FinalCta from "./components/FinalCta.jsx";
import SiteFooter from "./components/SiteFooter.jsx";

export default function SiteShell() {
  return (
    <div className="site-root">
      <div className="site-bg-grid" aria-hidden="true" />
      <div className="site-bg-glow" aria-hidden="true" />
      <SiteNav />
      <main>
        <Hero />
        <SocialProofStrip />
        <KernelNow />
        <PricingStrip />
        <ChainFlow />
        <DemoRecording />
        <ProofStrip />
        <Quickstart />
        <Verifiability />
        <DeterministicLayer />
        <Vision />
        <ChangelogSection />
        <FaqSection />
        <FinalCta />
      </main>
      <SiteFooter />
    </div>
  );
}
