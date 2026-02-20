const footerLogoUrl =
  typeof import.meta !== "undefined" && import.meta.env?.VITE_BRAND_LOGO_URL
    ? String(import.meta.env.VITE_BRAND_LOGO_URL).trim()
    : "/brand/settld-logo.png";

export default function SiteFooter() {
  return (
    <footer className="site-footer">
      <div>
        <div className="footer-brand-row">
          <img src={footerLogoUrl} alt="" className="footer-brand-logo" />
          <p className="footer-brand">Settld</p>
        </div>
        <p>
          Build autonomous systems with deterministic primitives across identity, policy, execution, evidence, and operations.
        </p>
      </div>
      <div className="footer-links">
        <a href="/product">Product</a>
        <a href="/developers">Developers</a>
        <a href="/docs">Docs</a>
        <a href="/security">Security</a>
        <a href="/pricing">Access</a>
        <a href="/company">Company</a>
      </div>
    </footer>
  );
}
